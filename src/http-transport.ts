/**
 * ORB-244 Phase A — Streamable HTTP transport for the MCP server.
 *
 * Used by the Self-Hosted-inline delivery variant: a separate
 * container alongside the API, listening on `ORBOTO_MCP_PORT` (default
 * 3100). The reverse proxy routes `/mcp` to this port.
 *
 * Per-request auth: every POST must carry `Authorization: Bearer
 * orb_*` in the header. We build one `McpServer` per session so each
 * session gets its own OrbotoClient bound to that session's token —
 * no mid-session token mutation, no cross-session leakage.
 *
 * Sessions are indexed by the MCP-spec-mandated `mcp-session-id`
 * header the transport generates on initialise. Closing the session
 * deletes the transport; a fresh initialise spins up a new one.
 *
 * ORB-1353 - session resilience. The in-memory session map is wiped on every
 * api restart/deploy, which used to invalidate every connected client at once
 * (a real ZCode adapter then dead-looped on the resulting 404 for hours). Two
 * server-side layers fix this: (1) the session registry is PERSISTED to the db
 * via `/system/mcp/sessions`, so a request carrying a session id we no longer
 * hold in memory is rehydrated under the SAME id after a restart; (2) an
 * unknown session id under otherwise-valid auth is transparently AUTO-ADOPTED
 * under a fresh id (MCP tool calls are stateless per-call, so re-establishing
 * loses nothing). The ORB-1324 404 re-initialise contract stays ONLY for
 * requests without valid auth; the kill-switch + mcp:use preflight still fires
 * on every (re)hydration.
 *
 * No Express dep — Node's built-in http server is enough for a
 * single-route MCP endpoint and keeps the production image small.
 */
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildOrbotoMcpServer } from './server.js';
import { OrbotoClient, preflightMcpSession } from './orboto-client.js';
import { EventBridge } from './event-bridge.js';

/**
 * ORB-1353 - persisted-session store. The transport calls these to survive an
 * api restart: `register` persists a session (or records an adoption), `resolve`
 * asks whether a presented id is a live session owned by the caller's token, and
 * `remove` drops it on explicit close. The default implementation wraps the
 * `/system/mcp/sessions` REST surface; tests inject a fake so the flow can be
 * exercised without a database.
 */
export interface McpSessionStore {
  register(
    token: string,
    meta: { sessionId: string; clientInfo?: string; userAgent?: string; adoptedFrom?: string },
  ): Promise<void>;
  /** True iff the id maps to a live session owned by this token (layer 1). */
  resolve(token: string, sessionId: string): Promise<boolean>;
  remove(token: string, sessionId: string): Promise<void>;
}

/** Default store backed by the api's `/system/mcp/sessions` endpoints. Each
 *  call builds a short-lived OrbotoClient bound to the request's token so the
 *  api scopes every read/write to that identity. */
export function createApiSessionStore(baseUrl: string): McpSessionStore {
  return {
    async register(token, meta) {
      const client = new OrbotoClient({ baseUrl, apiKey: token });
      await client.post('/system/mcp/sessions', meta);
    },
    async resolve(token, sessionId) {
      const client = new OrbotoClient({ baseUrl, apiKey: token });
      const res = await client.get<{ found: boolean }>(
        `/system/mcp/sessions/${encodeURIComponent(sessionId)}`,
      );
      return res.found === true;
    },
    async remove(token, sessionId) {
      const client = new OrbotoClient({ baseUrl, apiKey: token });
      await client.delete(`/system/mcp/sessions/${encodeURIComponent(sessionId)}`);
    },
  };
}

export interface HttpServerOptions {
  baseUrl: string;
  /** Override the persisted-session store (tests inject a fake). */
  sessionStore?: McpSessionStore;
}

/** ORB-941 - a live MCP session: its transport, the server bound to it
 *  (for out-of-band notifications), and the OrbotoClient carrying that
 *  session's token (used to poll the workspace kill-switch). */
export interface McpSession {
  transport: StreamableHTTPServerTransport;
  mcp: McpServer;
  client: OrbotoClient;
  bridge: EventBridge;
  /** The token this session was (re)hydrated with - used for throttled
   *  persistence touches so the retention window slides on activity. */
  token: string;
  /** Epoch ms of the last persistence touch, for throttling (ORB-1353). */
  lastTouchAt: number;
}

/** How an unknown (not-in-memory) session id should be handled. Pure decision
 *  so it can be unit-tested without a transport or database (ORB-1353):
 *   - `reinit-404` - no valid auth (or MCP disabled): keep the ORB-1324 404
 *                     so spec-conform clients re-initialise.
 *   - `rehydrate` - valid auth + the id is a persisted session owned by the
 *                     caller: rebuild a transport under the SAME id (layer 1).
 *   - `adopt` - valid auth but the id is unknown to the store: mint a
 *                     FRESH id and transparently re-establish (layer 2). */
export type UnknownSessionAction = 'reinit-404' | 'rehydrate' | 'adopt';

export function classifyUnknownSession(input: {
  hasValidAuth: boolean;
  isPersistedForCaller: boolean;
}): UnknownSessionAction {
  if (!input.hasValidAuth) return 'reinit-404';
  return input.isPersistedForCaller ? 'rehydrate' : 'adopt';
}

/** Minimal view of the SDK transport's private web-standard delegate. The
 *  Node wrapper exposes `sessionId` read-only and hides `_initialized`; to
 *  rehydrate/adopt a session WITHOUT replaying the initialize handshake we set
 *  both directly so the transport validates the client's in-flight non-init
 *  request against the chosen id. MCP tool calls are stateless per-call, so
 *  skipping the handshake loses nothing (the server never needs the client's
 *  negotiated capabilities to answer tools/list or tools/call). */
interface RawWebTransport {
  sessionId?: string;
  _initialized: boolean;
}

function forceInitialized(transport: StreamableHTTPServerTransport, sessionId: string): void {
  const web = (transport as unknown as { _webStandardTransport: RawWebTransport })._webStandardTransport;
  web.sessionId = sessionId;
  web._initialized = true;
}

/** Rewrite the `mcp-session-id` on an in-flight Node request so the transport
 *  validates it against an adopted (fresh) id. The SDK's transport builds its
 *  Web Request from `rawHeaders`, so patching the parsed `headers` object alone
 *  is not enough - both must be updated (ORB-1353). */
function overrideSessionIdHeader(req: IncomingMessage, sessionId: string): void {
  req.headers['mcp-session-id'] = sessionId;
  const raw = req.rawHeaders;
  let found = false;
  for (let i = 0; i < raw.length; i += 2) {
    if (raw[i]?.toLowerCase() === 'mcp-session-id') {
      raw[i + 1] = sessionId;
      found = true;
    }
  }
  if (!found) raw.push('mcp-session-id', sessionId);
}

/** Idle-touch throttle: don't re-persist a live session more than once per
 *  minute of activity. The api slides the row's TTL on every touch. */
const TOUCH_THROTTLE_MS = 60_000;

/** Extract a "name@version" label from an initialize request's clientInfo, for
 *  observability of which adapter owns a session. Returns undefined when the
 *  body carries no usable clientInfo. */
export function clientInfoLabel(body: unknown): string | undefined {
  const params = (body as { params?: { clientInfo?: { name?: unknown; version?: unknown } } } | null)?.params;
  const ci = params?.clientInfo;
  if (ci && typeof ci.name === 'string' && ci.name.length > 0) {
    return typeof ci.version === 'string' && ci.version.length > 0 ? `${ci.name}@${ci.version}` : ci.name;
  }
  return undefined;
}

/**
 * ORB-941 - graceful close of every active MCP session when the
 * workspace kill-switch (`system_config.mcp_enabled`) flips to disabled.
 *
 * The MCP spec has no standard `notifications/server/closing` method, so
 * the closest correct behaviour is: emit a best-effort logging
 * notification (visible to clients that negotiated the logging
 * capability) explaining WHY, then close the transport. Closing the
 * transport ends the SSE stream; the client's next request lands on the
 * unknown-session 404 branch, which per the Streamable-HTTP spec
 * triggers a transparent re-initialise - and our per-session preflight
 * then refuses that re-init with the clear "administrator has disabled
 * MCP access" error. So an in-flight session is dropped promptly and the
 * client gets an actionable reason rather than an opaque hang.
 *
 * Exported for unit testing with fake sessions.
 */
export async function closeAllMcpSessions(
  sessions: Iterable<McpSession>,
  reason: string,
): Promise<number> {
  let closed = 0;
  for (const { transport, mcp } of [...sessions]) {
    try {
      await mcp.server.sendLoggingMessage({
        level: 'warning',
        data: `orboto MCP: ${reason} Closing this session.`,
      });
    } catch {
      // Client never negotiated the logging capability - skip the
      // notice; the transport close below is what actually enforces it.
    }
    try {
      await transport.close();
    } catch {
      // Already closing / closed - nothing to do.
    }
    closed++;
  }
  return closed;
}

/** Read the request body as JSON. Fails hard on empty body for POSTs
 *  that need one; MCP clients always send a body on /mcp. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.length === 0) return resolve(null);
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendError(res: ServerResponse, status: number, message: string, extraHeaders?: Record<string, string>): void {
  res.writeHead(status, { 'content-type': 'application/json', ...(extraHeaders ?? {}) });
  res.end(JSON.stringify({ error: message }));
}

/** ORB-957 — RFC 6750 §3 WWW-Authenticate challenge for /mcp 401s.
 *  MCP-aware clients (Claude Desktop, Cursor, VS Code Copilot) follow
 *  the resource_metadata URL to auto-discover the OAuth flow.
 *
 *  The resource_metadata URL must point at the PUBLIC host the AI
 *  client can reach — NOT the internal `http://api:3000` baseUrl the
 *  MCP container uses to talk to the API. We derive the public URL
 *  from the incoming request's Host + X-Forwarded-Proto headers,
 *  which the reverse proxy (nginx → web container) sets for us.
 *  Falls back to baseUrl only when the headers are missing (local
 *  dev / direct connections).
 */
function wwwAuthChallenge(
  req: IncomingMessage,
  baseUrl: string,
  error: string,
  description: string,
): string {
  const host = (req.headers['x-forwarded-host'] as string | undefined)
    || (req.headers.host as string | undefined);
  // Multi-layer proxies (Coolify's outer Caddy → web container's nginx
  // → mcp container) sometimes lose the original scheme. Trust an
  // explicit X-Forwarded-Proto header if present; otherwise default to
  // https UNLESS the host is obviously localhost / a private IP (local
  // dev). The MCP container only runs in TLS-terminated deployments,
  // so https-by-default is right for production + lets local dev
  // explicitly send X-Forwarded-Proto=http if needed.
  const hostIsLocal = !!host && /^(localhost|127\.|::1|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
  const protoHeader = req.headers['x-forwarded-proto'] as string | undefined;
  const proto = protoHeader || (hostIsLocal ? 'http' : 'https');
  const origin = host
    ? `${proto}://${host}`
    : baseUrl.replace(/\/$/, '');
  const resourceMetadata = `${origin}/.well-known/oauth-protected-resource`;
  return `Bearer realm="orboto-mcp", error="${error}", error_description="${description.replace(/"/g, '\\"')}", resource_metadata="${resourceMetadata}"`;
}

export function createHttpServer({ baseUrl, sessionStore }: HttpServerOptions) {
  // One transport + server per MCP session. The session-id comes from
  // the transport's `onsessioninitialized` hook, which fires after
  // the `initialize` request lands and we've minted a fresh id.
  const sessions = new Map<string, McpSession>();

  // ORB-1353 - persisted-session store (survives api restarts). Defaults to
  // the api-backed store; tests inject a fake.
  const store = sessionStore ?? createApiSessionStore(baseUrl);

  // Build the per-session core (client + subscription set + MCP server +
  // event bridge) bound to a token. Shared by the new-session, rehydrate, and
  // adopt paths so they can't drift apart.
  async function buildSessionCore(token: string, userAgentSuffix: string | undefined) {
    const sessionClient = new OrbotoClient({ baseUrl, apiKey: token, userAgentSuffix });
    // ORB-940 - per-session subscription set + live-event bridge. The set is
    // mutated by resources/subscribe + resources/unsubscribe handlers inside
    // the McpServer; the bridge reads it to decide which incoming API events
    // deserve a push.
    //
    // ORB-1353 subscription boundary: a rehydrated (layer 1) or adopted
    // (layer 2) session ALWAYS starts with an empty subscription set + a fresh
    // bridge. Live subscription state is per-session in-memory state tied to a
    // now-dead SSE socket, so it cannot be carried across an api restart even
    // for the same session id - per the MCP spec, re-subscribing after a
    // session change is the client's job. Rehydrating under the SAME id keeps
    // the deploy case coherent (the client's own session bookkeeping stays
    // valid and its re-subscribe resumes pushes); adoption gives a new id so
    // the client treats it as a fresh session and re-subscribes from scratch.
    const subscriptions = new Set<string>();
    const mcp = await buildOrbotoMcpServer({ baseUrl, apiKey: token, userAgentSuffix, subscriptions });
    const bridge = new EventBridge({ baseUrl, apiKey: token, mcp, subscriptions });
    return { sessionClient, subscriptions, mcp, bridge };
  }

  // Rehydrate/adopt: stand up a session bound to `token` and force it into the
  // initialized state under `chosenSessionId` WITHOUT replaying the initialize
  // handshake, so the client's in-flight non-init request validates against it.
  async function establishForcedSession(
    token: string,
    userAgentSuffix: string | undefined,
    chosenSessionId: string,
  ): Promise<McpSession> {
    const { sessionClient, mcp, bridge } = await buildSessionCore(token, userAgentSuffix);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    transport.onclose = () => { sessions.delete(chosenSessionId); bridge.close(); };
    await mcp.connect(transport);
    forceInitialized(transport, chosenSessionId);
    const session: McpSession = {
      transport, mcp, client: sessionClient, bridge, token, lastTouchAt: Date.now(),
    };
    sessions.set(chosenSessionId, session);
    bridge.start();
    return session;
  }

  // ORB-941 / ORB-942 - MCP kill-switch poll. Two kill-switches ride the
  // same `/system/mcp/status` probe while sessions are live:
  //   - workspace-wide (`system_config.mcp_enabled`, ORB-941): an admin
  //     flip closes EVERY in-flight session (any session's response is
  //     authoritative for the whole workspace).
  //   - per-user (`users.mcp_enabled`, ORB-942): a user flipping their own
  //     opt-out closes only THAT user's sessions. Since the flag is
  //     per-identity, each session is probed with its own token and the
  //     `userMcpEnabled` field is read from the same response.
  // New sessions (and rehydrate/adopt) are already refused at preflight, so
  // the poll only needs to reap existing sessions. Only polls while sessions
  // exist → zero cost when idle. Interval is env-tunable for tests.
  const pollMs = Number(process.env.ORBOTO_MCP_KILLSWITCH_POLL_MS ?? 30_000);
  async function pollKillSwitch(): Promise<void> {
    if (sessions.size === 0) return;
    const userDisabled: McpSession[] = [];
    for (const session of sessions.values()) {
      try {
        const status = await session.client.get<{ enabled: boolean; userMcpEnabled: boolean }>(
          '/system/mcp/status',
        );
        if (!status.enabled) {
          // Workspace-wide off wins and is authoritative for everyone -
          // close all sessions and stop probing.
          await closeAllMcpSessions(
            sessions.values(),
            'the workspace administrator has disabled MCP access.',
          );
          return;
        }
        if (!status.userMcpEnabled) userDisabled.push(session);
      } catch {
        // This session's token may be expired/invalid - try the next.
      }
    }
    if (userDisabled.length > 0) {
      await closeAllMcpSessions(
        userDisabled,
        'you have disabled MCP access for your account.',
      );
    }
  }
  const killSwitchTimer = setInterval(() => { void pollKillSwitch(); }, pollMs);
  // Don't let the poll keep the process (or a test) alive on its own.
  killSwitchTimer.unref?.();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Health probe — stays cheap, zero-auth so docker healthchecks
    // don't need a token. Doesn't reveal anything about config.
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    // Route: all MCP traffic lands on /mcp per spec convention.
    // Anything else is 404 so an accidental probe at / doesn't leak
    // the transport.
    if (req.url !== '/mcp') {
      sendError(res, 404, 'Not found');
      return;
    }

    // Reject non-POST + non-DELETE. GET on /mcp is legal per the spec
    // (SSE resumption) but that is unimplemented here.
    //
    // ORB-1424 - an UNAUTHENTICATED GET/HEAD on /mcp is almost always an
    // OAuth-discovery probe (rmcp/Codex hit the resource to read the
    // WWW-Authenticate challenge). Answering a bare 405 there left the
    // client without the resource_metadata pointer and logged a noisy
    // "405 Method Not Allowed". Return 401 + WWW-Authenticate instead so
    // the probe discovers the OAuth flow cleanly. An AUTHENTICATED GET
    // (a real client attempting SSE resumption) still 405s - it already
    // holds a token and needs no discovery pointer, so spec-conform
    // clients (Claude Desktop / Cursor) do not regress.
    if (req.method !== 'POST' && req.method !== 'DELETE') {
      const probeAuth = (req.headers.authorization ?? '') as string;
      const hasBearer = probeAuth.startsWith('Bearer ') && probeAuth.slice(7).trim().length > 0;
      if ((req.method === 'GET' || req.method === 'HEAD') && !hasBearer) {
        const challenge = wwwAuthChallenge(req, baseUrl, 'invalid_request', 'Bearer token required');
        if (req.method === 'HEAD') {
          // HEAD carries no body per HTTP semantics.
          res.writeHead(401, { 'content-type': 'application/json', 'WWW-Authenticate': challenge });
          res.end();
        } else {
          sendError(res, 401, 'Bearer token required', { 'WWW-Authenticate': challenge });
        }
        return;
      }
      res.writeHead(405, { allow: 'POST, DELETE' });
      res.end();
      return;
    }

    // Extract the bearer token. Per-session auth — the same token
    // is used for the session's whole lifetime (reconnect without
    // re-init would land on a new session id and fresh auth anyway).
    //
    // Two acceptable token shapes:
    //   orb_*          — service-account API key (operator-minted)
    //   JWT (3 segs)   — OAuth-issued access token from the /oauth/
    //                    authorize + /oauth/token flow (ORB-957)
    // Both go to the API unchanged; the API's authenticate decorator
    // distinguishes them.
    const authHeader = (req.headers.authorization ?? '') as string;
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : '';
    if (!token) {
      sendError(res, 401, 'Bearer token required', {
        'WWW-Authenticate': wwwAuthChallenge(req, baseUrl, 'invalid_request', 'Bearer token required'),
      });
      return;
    }

    const sessionId = (req.headers['mcp-session-id'] ?? '') as string;

    // DELETE is the client's explicit session-close. We forward it
    // to the transport's handleRequest which tears down cleanly.
    if (req.method === 'DELETE') {
      // ORB-1353 - drop the persisted row too so a closed session doesn't
      // linger until the retention sweep. Best-effort + scoped to the caller.
      void store.remove(token, sessionId).catch(() => { /* best-effort */ });
      const existing = sessions.get(sessionId);
      if (existing) {
        await existing.transport.handleRequest(req, res);
        return;
      }
      // Not in memory - e.g. the client is closing a session we only know from
      // persistence after a restart. Acknowledge the close idempotently.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // POST path. Parse body so we can route (new-session vs. existing).
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendError(res, 400, 'Malformed JSON');
    }

    const userAgentSuffix = (req.headers['user-agent'] as string | undefined)
      ?.split('/')[0] || undefined;
    const userAgent = req.headers['user-agent'] as string | undefined;

    if (sessionId && sessions.has(sessionId)) {
      // Existing session — hand straight to its transport.
      const session = sessions.get(sessionId)!;
      await session.transport.handleRequest(req, res, body);
      // ORB-1353 - slide the persistence TTL on activity so an actively-used
      // session never idle-expires. Throttled + fire-and-forget so it adds no
      // latency and no per-call write storm.
      const now = Date.now();
      if (now - session.lastTouchAt >= TOUCH_THROTTLE_MS) {
        session.lastTouchAt = now;
        void store.register(session.token, { sessionId }).catch(() => { /* best-effort */ });
      }
      return;
    }

    // ORB-1175 / ORB-1324 / ORB-1353 - the client presented a session id we
    // don't hold in memory. The common cause is a deploy: the MCP container
    // restarted and lost its in-memory `sessions` map, so every connected
    // client's session id is now unknown. Three outcomes on a non-init request,
    // decided by whether the token is valid and whether the id is a persisted
    // session owned by that token:
    //
    //   - no valid auth (or MCP disabled / mcp:use missing) → keep the ORB-1324
    //     404 so spec-conform clients transparently re-initialise (and hit the
    //     clear preflight error on the re-init path). NO WWW-Authenticate: the
    //     token, not the session, is the thing to fix only when it's actually
    //     invalid - which the re-init preflight then challenges.
    //   - valid auth + persisted session owned by caller → REHYDRATE under the
    //     SAME id (layer 1): the deploy is invisible to a well-behaved client.
    //   - valid auth + unknown id → AUTO-ADOPT under a fresh id (layer 2): a
    //     buggy client that keeps replaying a dead id self-heals instead of
    //     dead-looping on the 404. MCP tool calls are stateless per-call, so
    //     silently re-establishing the session loses nothing.
    //
    // The preflight below enforces the kill-switch (ORB-941) + per-user mcp:use
    // on EVERY rehydrate/adopt, exactly like a fresh session - a disabled
    // workspace refuses adopted sessions (they fall to the 404).
    if (sessionId && !isInitializeRequest(body)) {
      const preflightClient = new OrbotoClient({ baseUrl, apiKey: token, userAgentSuffix });
      let authValid = false;
      try {
        await preflightMcpSession(preflightClient);
        authValid = true;
      } catch {
        // Invalid token, MCP disabled, or mcp:use missing → refuse to
        // re-establish; fall back to the re-initialise 404.
        authValid = false;
      }
      let isPersisted = false;
      if (authValid) {
        try {
          isPersisted = await store.resolve(token, sessionId);
        } catch {
          // Store hiccup - treat as not-persisted and let adoption handle it
          // (auth is already valid, so re-establishing is safe).
          isPersisted = false;
        }
      }
      const action = classifyUnknownSession({ hasValidAuth: authValid, isPersistedForCaller: isPersisted });

      if (action === 'reinit-404') {
        return sendError(res, 404, 'Unknown or expired MCP session - reinitialize (the server restarted since this session began).');
      }

      if (action === 'rehydrate') {
        const session = await establishForcedSession(token, userAgentSuffix, sessionId);
        // Touch persistence so the TTL slides; same id, so no adoptedFrom.
        void store.register(token, { sessionId, userAgent }).catch(() => { /* best-effort */ });
        await session.transport.handleRequest(req, res, body);
        return;
      }

      // action === 'adopt' - mint a fresh id and re-establish under it.
      const newSessionId = randomUUID();
      const session = await establishForcedSession(token, userAgentSuffix, newSessionId);
      // Rewrite the in-flight request's session header so the transport
      // validates it against the fresh id AND the response advertises the new
      // id. A well-behaved client migrates to it; a client that keeps sending
      // the dead id simply gets re-adopted each call - self-healing either way.
      overrideSessionIdHeader(req, newSessionId);
      // Record the adoption (old id, new id, client). Stderr here; the api
      // upsert emits the Sentry breadcrumb (Sentry lives on the api side).
      process.stderr.write(
        `[orboto-mcp] auto-adopted stale session ${sessionId} → ${newSessionId} (client=${userAgent ?? 'unknown'})\n`,
      );
      void store
        .register(token, { sessionId: newSessionId, userAgent, adoptedFrom: sessionId })
        .catch(() => { /* best-effort */ });
      await session.transport.handleRequest(req, res, body);
      return;
    }

    if (!sessionId && isInitializeRequest(body)) {
      // New session — mint a transport + server pair bound to this
      // request's token, register with the session map once
      // `onsessioninitialized` fires.

      // Preflight: verify mcp:use + mcp_enabled BEFORE we stand up the server,
      // so a refused session costs nothing. If either fails we refuse at the
      // transport level - much clearer than letting the first tool call 403.
      // WWW-Authenticate included on 401-shape failures so the client can
      // auto-discover OAuth.
      const preflightClient = new OrbotoClient({ baseUrl, apiKey: token, userAgentSuffix });
      try {
        await preflightMcpSession(preflightClient);
      } catch (err) {
        return sendError(res, 401, (err as Error).message, {
          'WWW-Authenticate': wwwAuthChallenge(req, baseUrl, 'invalid_token', (err as Error).message),
        });
      }

      const { sessionClient, mcp, bridge } = await buildSessionCore(token, userAgentSuffix);
      // "name@version" of the client's declared clientInfo, for observability
      // of which adapter owns the session.
      const clientInfo = clientInfoLabel(body);
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => {
          sessions.set(sid, {
            transport, mcp, client: sessionClient, bridge, token, lastTouchAt: Date.now(),
          });
          bridge.start();
          // ORB-1353 - persist the freshly-minted session so it survives an
          // api restart (a later request with this id then rehydrates).
          void store
            .register(token, { sessionId: sid, clientInfo, userAgent })
            .catch(() => { /* best-effort */ });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
        bridge.close();
      };
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }

    // Neither an init nor a known session — the client is confused.
    sendError(res, 400, 'Missing mcp-session-id header or initialize request');
  });

  // Stop the kill-switch poll when the HTTP server is torn down.
  server.on('close', () => clearInterval(killSwitchTimer));

  // ORB-1353 - expose the in-memory registry + store for tests to drive the
  // restart-simulation (clear `sessions` to mimic a process restart while the
  // injected store keeps its persisted rows) and to close lingering sessions.
  (server as unknown as { __mcp: McpServerInternals }).__mcp = { sessions, store };

  return server;
}

/** Test seam: the transport's in-memory session registry + persisted store,
 *  attached to the returned http.Server as `__mcp` (ORB-1353). */
export interface McpServerInternals {
  sessions: Map<string, McpSession>;
  store: McpSessionStore;
}

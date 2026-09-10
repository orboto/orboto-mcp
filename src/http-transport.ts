/**
 * ORB-244 Phase A - Streamable HTTP transport for the MCP server.
 *
 * @see ORB-1353, ORB-1324
 */
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildOrbotoMcpServer } from './server.js';
import { resolveToolset, type Toolset } from './toolset.js';
import { OrbotoClient, preflightMcpSession } from './orboto-client.js';
import type { OAuthTokenProviderLike } from './orboto-client.js';
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

/** ORB-1470 - a per-session, MUTABLE bearer holder. The session's
 *  OrbotoClient(s) + event bridge resolve `.current` on every call, and the
 *  request handler updates it to the bearer the CLIENT presents on each
 *  request. This is what keeps a long-lived MCP session alive across the
 *  client's OAuth access-token rotation: the fresh bearer is used for the API
 *  call, not the (eventually-expired) token captured when the session was
 *  created. Without it a session dead-ends with a 401 "OAuth access token
 *  expired" the moment its creation-time token ages past the 1h access-token
 *  TTL - which, if the session was initialised with an already-aged cached
 *  token, is only minutes after connect - even though that very request
 *  carried a valid refreshed bearer. */
export interface SessionTokenHolder { current: string }

/** Wrap a mutable token holder as an OAuthTokenProviderLike so the session's
 *  clients resolve the latest presented bearer per request. `forceRefresh`
 *  cannot mint a new token here (the CLIENT owns the OAuth refresh), so on a
 *  401 it just re-reads the holder; the client presents its refreshed bearer
 *  on the next request, which updates the holder for subsequent calls. */
function holderTokenProvider(holder: SessionTokenHolder): OAuthTokenProviderLike {
  return {
    getAccessToken: async () => holder.current,
    forceRefresh: async () => holder.current,
  };
}

/** ORB-941 - a live MCP session: its transport, the server bound to it
 *  (for out-of-band notifications), and the OrbotoClient carrying that
 *  session's token (used to poll the workspace kill-switch). */
export interface McpSession {
  transport: StreamableHTTPServerTransport;
  mcp: McpServer;
  client: OrbotoClient;
  bridge: EventBridge;
  /** ORB-1470 - the session's mutable bearer holder. Updated to the current
   *  request's bearer on every call so a client that rotated its OAuth access
   *  token keeps using the same session. Also read for throttled persistence
   *  touches so the retention window slides on activity (ORB-1353). */
  tokenHolder: SessionTokenHolder;
  /** ORB-1576 - the identity that created the session (from the preflight at
   *  init). Bearer rotations + DELETEs are only honoured when the presented
   *  bearer resolves to THIS user, so a leaked session id is not a
   *  cross-user capability. */
  userEmail: string;
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
 *  that need one; MCP clients always send a body on /mcp.
 *  ORB-1576 - byte cap: the auth check runs AFTER the body is buffered,
 *  so an unauthenticated client could otherwise grow container memory
 *  with an endless POST. JSON-RPC envelopes are small (the fat
 *  attachment payloads ride the api directly, not /mcp). */
const MAX_BODY_BYTES = 5 * 1024 * 1024;

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error(`request body too large (>${MAX_BODY_BYTES} bytes)`));
        return;
      }
      chunks.push(chunk);
    });
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

/** ORB-957 - RFC 6750 §3 WWW-Authenticate challenge for /mcp 401s.
 *  MCP-aware clients (Claude Desktop, Cursor, VS Code Copilot) follow
 *  the resource_metadata URL to auto-discover the OAuth flow.
 */
function wwwAuthChallenge(
  req: IncomingMessage,
  baseUrl: string,
  error: string,
  description: string,
): string {
  const host = (req.headers['x-forwarded-host'] as string | undefined)
    || (req.headers.host as string | undefined);
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
  const sessions = new Map<string, McpSession>();

  const store = sessionStore ?? createApiSessionStore(baseUrl);

  async function buildSessionCore(tokenHolder: SessionTokenHolder, userAgentSuffix: string | undefined, toolset?: Toolset) {
    const tokenProvider = holderTokenProvider(tokenHolder);
    const sessionClient = new OrbotoClient({ baseUrl, tokenProvider, userAgentSuffix });
    const subscriptions = new Set<string>();
    const mcp = await buildOrbotoMcpServer({ baseUrl, tokenProvider, userAgentSuffix, subscriptions, toolset });
    const bridge = new EventBridge({ baseUrl, tokenProvider, mcp, subscriptions });
    return { sessionClient, subscriptions, mcp, bridge };
  }

  /** ORB-1576 - resolve a bearer's owner identity via the status preflight;
   *  null on any failure (invalid token, MCP off, network) = fail closed. */
  async function resolveUserEmail(token: string): Promise<string | null> {
    try {
      const client = new OrbotoClient({ baseUrl, apiKey: token });
      const { userEmail } = await preflightMcpSession(client);
      return userEmail;
    } catch {
      return null;
    }
  }

  async function establishForcedSession(
    tokenHolder: SessionTokenHolder,
    userAgentSuffix: string | undefined,
    chosenSessionId: string,
    userEmail: string,
    toolset?: Toolset,
  ): Promise<McpSession> {
    const { sessionClient, mcp, bridge } = await buildSessionCore(tokenHolder, userAgentSuffix, toolset);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    transport.onclose = () => { sessions.delete(chosenSessionId); bridge.close(); };
    await mcp.connect(transport);
    forceInitialized(transport, chosenSessionId);
    const session: McpSession = {
      transport, mcp, client: sessionClient, bridge, tokenHolder, userEmail, lastTouchAt: Date.now(),
    };
    sessions.set(chosenSessionId, session);
    bridge.start();
    return session;
  }

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
  killSwitchTimer.unref?.();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    const requestUrl = new URL(req.url ?? '', 'http://localhost');
    if (requestUrl.pathname !== '/mcp') {
      sendError(res, 404, 'Not found');
      return;
    }
    const toolset = resolveToolset(
      requestUrl.searchParams.get('toolset')
        ?? (req.headers['x-orboto-toolset'] as string | undefined),
      process.env.ORBOTO_MCP_TOOLSET,
    );

    if (req.method !== 'POST' && req.method !== 'DELETE') {
      const probeAuth = (req.headers.authorization ?? '') as string;
      const hasBearer = probeAuth.startsWith('Bearer ') && probeAuth.slice(7).trim().length > 0;
      if ((req.method === 'GET' || req.method === 'HEAD') && !hasBearer) {
        const challenge = wwwAuthChallenge(req, baseUrl, 'invalid_request', 'Bearer token required');
        if (req.method === 'HEAD') {
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

    if (req.method === 'DELETE') {
      const existing = sessions.get(sessionId);
      if (existing) {
        const presented = await resolveUserEmail(token);
        if (!presented || presented !== existing.userEmail) {
          return sendError(res, 404, 'Unknown MCP session');
        }
      }
      void store.remove(token, sessionId).catch(() => { /* best-effort */ });
      if (existing) {
        await existing.transport.handleRequest(req, res);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

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
      const session = sessions.get(sessionId)!;
      if (session.tokenHolder.current !== token) {
        const presented = await resolveUserEmail(token);
        if (!presented || presented !== session.userEmail) {
          return sendError(res, 401, 'Bearer does not match the session owner');
        }
        process.stderr.write(
          `[orboto-mcp] session ${sessionId} bearer rotated - adopting client's current access token\n`,
        );
        session.tokenHolder.current = token;
      }
      await session.transport.handleRequest(req, res, body);
      const now = Date.now();
      if (now - session.lastTouchAt >= TOUCH_THROTTLE_MS) {
        session.lastTouchAt = now;
        void store.register(session.tokenHolder.current, { sessionId }).catch(() => { /* best-effort */ });
      }
      return;
    }

    if (sessionId && !isInitializeRequest(body)) {
      const preflightClient = new OrbotoClient({ baseUrl, apiKey: token, userAgentSuffix });
      let authValid = false;
      let callerEmail = '';
      try {
        const preflight = await preflightMcpSession(preflightClient);
        authValid = true;
        callerEmail = preflight.userEmail;
      } catch {
        authValid = false;
      }
      let isPersisted = false;
      if (authValid) {
        try {
          isPersisted = await store.resolve(token, sessionId);
        } catch {
          isPersisted = false;
        }
      }
      const action = classifyUnknownSession({ hasValidAuth: authValid, isPersistedForCaller: isPersisted });

      if (action === 'reinit-404') {
        return sendError(res, 404, 'Unknown or expired MCP session - reinitialize (the server restarted since this session began).');
      }

      if (action === 'rehydrate') {
        const session = await establishForcedSession({ current: token }, userAgentSuffix, sessionId, callerEmail, toolset);
        void store.register(token, { sessionId, userAgent }).catch(() => { /* best-effort */ });
        await session.transport.handleRequest(req, res, body);
        return;
      }

      const newSessionId = randomUUID();
      const session = await establishForcedSession({ current: token }, userAgentSuffix, newSessionId, callerEmail, toolset);
      overrideSessionIdHeader(req, newSessionId);
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

      const preflightClient = new OrbotoClient({ baseUrl, apiKey: token, userAgentSuffix });
      let ownerEmail: string;
      try {
        ownerEmail = (await preflightMcpSession(preflightClient)).userEmail;
      } catch (err) {
        return sendError(res, 401, (err as Error).message, {
          'WWW-Authenticate': wwwAuthChallenge(req, baseUrl, 'invalid_token', (err as Error).message),
        });
      }

      const tokenHolder: SessionTokenHolder = { current: token };
      const { sessionClient, mcp, bridge } = await buildSessionCore(tokenHolder, userAgentSuffix, toolset);
      const clientInfo = clientInfoLabel(body);
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => {
          sessions.set(sid, {
            transport, mcp, client: sessionClient, bridge, tokenHolder, userEmail: ownerEmail, lastTouchAt: Date.now(),
          });
          bridge.start();
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

    sendError(res, 400, 'Missing mcp-session-id header or initialize request');
  });

  server.on('close', () => clearInterval(killSwitchTimer));

  (server as unknown as { __mcp: McpServerInternals }).__mcp = { sessions, store };

  return server;
}

/** Test seam: the transport's in-memory session registry + persisted store,
 *  attached to the returned http.Server as `__mcp` (ORB-1353). */
export interface McpServerInternals {
  sessions: Map<string, McpSession>;
  store: McpSessionStore;
}

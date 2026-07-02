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
 * No Express dep — Node's built-in http server is enough for a
 * single-route MCP endpoint and keeps the production image small.
 */
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { buildOrbotoMcpServer } from './server.js';
import { OrbotoClient, preflightMcpSession } from './orboto-client.js';
import { EventBridge } from './event-bridge.js';

export interface HttpServerOptions {
  baseUrl: string;
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

export function createHttpServer({ baseUrl }: HttpServerOptions) {
  // One transport + server per MCP session. The session-id comes from
  // the transport's `onsessioninitialized` hook, which fires after
  // the `initialize` request lands and we've minted a fresh id.
  const sessions = new Map<string, StreamableHTTPServerTransport>();

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

    // Reject non-POST + non-DELETE. GET on /mcp is legal per the
    // spec (SSE resumption) but this first cut keeps it simple and
    // returns 405 — resumption is a v2 concern.
    if (req.method !== 'POST' && req.method !== 'DELETE') {
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
      const existing = sessions.get(sessionId);
      if (!existing) return sendError(res, 404, 'Unknown session');
      await existing.handleRequest(req, res);
      return;
    }

    // POST path. Parse body so we can route (new-session vs. existing).
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendError(res, 400, 'Malformed JSON');
    }

    if (sessionId && sessions.has(sessionId)) {
      // Existing session — hand straight to its transport.
      const transport = sessions.get(sessionId)!;
      await transport.handleRequest(req, res, body);
      return;
    }

    // ORB-1175 / ORB-1324 — the client presented a session id we don't know.
    // The common cause is a deploy: the MCP container restarted and lost its
    // in-memory `sessions` map, so every connected client's session id is now
    // unknown. Per the Streamable HTTP spec, answer 404 to a request carrying
    // an Mcp-Session-Id the server doesn't recognise — that is the signal an
    // MCP client acts on to transparently re-initialise (re-send Initialize
    // without a session id → our new-session branch below → it retries the
    // pending call). NO WWW-Authenticate here: the token is fine, only the
    // session is gone, and attaching an auth challenge (ORB-1175) made clients
    // read this as a token problem and kick off a MANUAL OAuth re-auth instead
    // of the automatic re-init — which is exactly why a routine deploy started
    // requiring hand-holding. A genuinely expired token is still caught on the
    // re-init path: the initialize preflight 401s + challenges then.
    if (sessionId && !isInitializeRequest(body)) {
      return sendError(res, 404, 'Unknown or expired MCP session — reinitialize (the server restarted since this session began).');
    }

    if (!sessionId && isInitializeRequest(body)) {
      // New session — mint a transport + server pair bound to this
      // request's token, register with the session map once
      // `onsessioninitialized` fires.
      const userAgentSuffix = (req.headers['user-agent'] as string | undefined)
        ?.split('/')[0] || undefined;

      // Preflight: verify mcp:use + mcp_enabled. If either fails we
      // refuse the session at the transport level — much clearer
      // than letting the first tool call 403. WWW-Authenticate
      // included on 401-shape failures so the client can auto-
      // discover OAuth.
      try {
        await preflightMcpSession(new OrbotoClient({ baseUrl, apiKey: token, userAgentSuffix }));
      } catch (err) {
        return sendError(res, 401, (err as Error).message, {
          'WWW-Authenticate': wwwAuthChallenge(req, baseUrl, 'invalid_token', (err as Error).message),
        });
      }

      // ORB-940 — per-session subscription set + live-event bridge.
      // The set is mutated by resources/subscribe + resources/
      // unsubscribe handlers inside the McpServer; the bridge reads
      // it to decide which incoming API events deserve a push.
      const subscriptions = new Set<string>();
      const mcp = await buildOrbotoMcpServer({
        baseUrl,
        apiKey: token,
        userAgentSuffix,
        subscriptions,
      });
      const bridge = new EventBridge({ baseUrl, apiKey: token, mcp, subscriptions });
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => {
          sessions.set(sid, transport);
          bridge.start();
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

  return server;
}

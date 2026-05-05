/**
 * ORB-244 Phase A — Streamable HTTP transport for the MCP server.
 *
 * Used by the Self-Hosted-inline delivery variant: a separate
 * container alongside the API, listening on `ORBOTO_MCP_PORT` (default
 * 3100). The reverse proxy routes `/mcp` to this port.
 *
 * Per-request auth: every POST must carry `Authorization: Bearer
 * obo_*` in the header. We build one `McpServer` per session so each
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

function sendError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
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
    const authHeader = (req.headers.authorization ?? '') as string;
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : '';
    if (!token) {
      sendError(res, 401, 'Authorization: Bearer <orb_*> required');
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

    if (!sessionId && isInitializeRequest(body)) {
      // New session — mint a transport + server pair bound to this
      // request's token, register with the session map once
      // `onsessioninitialized` fires.
      const userAgentSuffix = (req.headers['user-agent'] as string | undefined)
        ?.split('/')[0] || undefined;

      // Preflight: verify mcp:use + mcp_enabled. If either fails we
      // refuse the session at the transport level — much clearer
      // than letting the first tool call 403.
      try {
        await preflightMcpSession(new OrbotoClient({ baseUrl, apiKey: token, userAgentSuffix }));
      } catch (err) {
        return sendError(res, 403, (err as Error).message);
      }

      const mcp = buildOrbotoMcpServer({
        baseUrl,
        apiKey: token,
        userAgentSuffix,
      });
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => {
          sessions.set(sid, transport);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
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

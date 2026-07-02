/**
 * ORB-1175 — after a deploy the MCP container loses its in-memory session
 * map, so a client's existing mcp-session-id is unknown. The transport
 * must answer 404 (the Streamable-HTTP spec signal to re-initialise)
 * rather than the old opaque 400, so OAuth-connected clients recover
 * transparently instead of failing with a generic execution error.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer as createNodeServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import {
  createHttpServer,
  closeAllMcpSessions,
  classifyUnknownSession,
  clientInfoLabel,
  type McpSession,
  type McpSessionStore,
  type McpServerInternals,
} from './http-transport.js';

let server: Server | null = null;
afterEach(() => { server?.close(); server = null; });

async function start(): Promise<string> {
  server = createHttpServer({ baseUrl: 'http://api.invalid' });
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const { port } = server!.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

const NON_INIT = JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 });

describe('ORB-1175 — stale MCP session recovery', () => {
  it('returns a clean 404 (re-initialise signal, no auth challenge) for an unknown session id on a non-init request', async () => {
    const base = await start();
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer orb_dummy', 'content-type': 'application/json', 'mcp-session-id': 'stale-after-deploy' },
      body: NON_INIT,
    });
    expect(res.status).toBe(404);
    // ORB-1324 — NO WWW-Authenticate: the token is fine, only the session is
    // gone. Attaching an auth challenge made clients kick off a manual OAuth
    // re-auth instead of the automatic re-initialise the 404 already signals.
    // (Token expiry is still caught on the re-init path's preflight.)
    expect(res.headers.get('www-authenticate')).toBeNull();
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/reinitialize/i);
  });

  it('still 401s when no bearer token is present', async () => {
    const base = await start();
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'mcp-session-id': 'whatever' },
      body: NON_INIT,
    });
    expect(res.status).toBe(401);
  });

  it('health probe stays open + cheap', async () => {
    const base = await start();
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});

describe('ORB-941 - graceful close of in-flight MCP sessions on kill-switch', () => {
  function fakeSession(): { session: McpSession; close: ReturnType<typeof vi.fn>; log: ReturnType<typeof vi.fn> } {
    const close = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn().mockResolvedValue(undefined);
    const session = {
      transport: { close } as unknown as McpSession['transport'],
      mcp: { server: { sendLoggingMessage: log } } as unknown as McpSession['mcp'],
      client: {} as unknown as McpSession['client'],
      bridge: { close: vi.fn() } as unknown as McpSession['bridge'],
      token: 'orb_dummy',
      lastTouchAt: Date.now(),
    };
    return { session, close, log };
  }

  it('emits a logging notice then closes every active transport', async () => {
    const a = fakeSession();
    const b = fakeSession();
    const closed = await closeAllMcpSessions([a.session, b.session], 'disabled by admin.');
    expect(closed).toBe(2);
    expect(a.log).toHaveBeenCalledOnce();
    expect(b.log).toHaveBeenCalledOnce();
    expect(a.close).toHaveBeenCalledOnce();
    expect(b.close).toHaveBeenCalledOnce();
    // The reason is surfaced to the client in the notification payload.
    expect(a.log.mock.calls[0][0]).toMatchObject({ level: 'warning' });
    expect(a.log.mock.calls[0][0].data).toContain('disabled by admin.');
  });

  it('still closes the transport when the client never negotiated logging', async () => {
    const s = fakeSession();
    s.log.mockRejectedValueOnce(new Error('logging capability not negotiated'));
    const closed = await closeAllMcpSessions([s.session], 'disabled by admin.');
    expect(closed).toBe(1);
    expect(s.close).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// ORB-1353 - session resilience: persist across restarts + auto-adopt.
// ---------------------------------------------------------------------------

describe('ORB-1353 - classifyUnknownSession (pure decision)', () => {
  it('keeps the 404 re-init contract when auth is invalid', () => {
    expect(classifyUnknownSession({ hasValidAuth: false, isPersistedForCaller: false })).toBe('reinit-404');
    // Even a "persisted" id must not resurrect without valid auth.
    expect(classifyUnknownSession({ hasValidAuth: false, isPersistedForCaller: true })).toBe('reinit-404');
  });
  it('rehydrates a persisted session owned by the caller (layer 1)', () => {
    expect(classifyUnknownSession({ hasValidAuth: true, isPersistedForCaller: true })).toBe('rehydrate');
  });
  it('adopts an unknown id under valid auth (layer 2)', () => {
    expect(classifyUnknownSession({ hasValidAuth: true, isPersistedForCaller: false })).toBe('adopt');
  });
});

describe('ORB-1353 - clientInfoLabel', () => {
  it('formats name@version from an initialize body', () => {
    expect(clientInfoLabel({ params: { clientInfo: { name: 'zcode', version: '2.1' } } })).toBe('zcode@2.1');
  });
  it('falls back to name-only and undefined', () => {
    expect(clientInfoLabel({ params: { clientInfo: { name: 'zcode' } } })).toBe('zcode');
    expect(clientInfoLabel({ params: {} })).toBeUndefined();
    expect(clientInfoLabel(null)).toBeUndefined();
  });
});

// A controllable in-process fake of the api endpoints the transport touches:
// preflight (/system/mcp/status), the working-rules fetch, and the event
// bridge's SSE endpoint. DB-free - the persisted-session store is injected
// separately so a "restart" is just clearing the in-memory registry.
function fakeApi(opts: { enabled?: boolean; mcpUseGranted?: boolean } = {}) {
  const state = { enabled: opts.enabled ?? true, mcpUseGranted: opts.mcpUseGranted ?? true };
  const api = createNodeServer((req, res) => {
    const url = req.url ?? '';
    if (url.startsWith('/system/mcp/status')) {
      // A token of `Bearer invalid` models an expired/invalid credential.
      if ((req.headers.authorization ?? '') === 'Bearer invalid') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid token' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ enabled: state.enabled, mcpUseGranted: state.mcpUseGranted, userEmail: 'u@example.com' }));
      return;
    }
    if (url.startsWith('/agent-instructions')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ instructions: '' }));
      return;
    }
    if (url.startsWith('/sse/mcp-events')) {
      // Empty stream - the bridge reconnects on close, cleared by session close.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end();
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  return { api, state };
}

/** In-memory persisted-session store. Survives an in-memory-registry "restart";
 *  keyed identity by token (1:1 with a user in these tests). */
function fakeStore() {
  const rows = new Map<string, { userId: string; adoptedFrom?: string }>();
  const register = vi.fn(async (token: string, meta: { sessionId: string; adoptedFrom?: string }) => {
    rows.set(meta.sessionId, { userId: token, adoptedFrom: meta.adoptedFrom });
  });
  const resolve = vi.fn(async (token: string, sessionId: string) => {
    const r = rows.get(sessionId);
    return !!r && r.userId === token;
  });
  const remove = vi.fn(async (_token: string, sessionId: string) => { rows.delete(sessionId); });
  const store: McpSessionStore = { register, resolve, remove };
  return { rows, register, resolve, remove, store };
}

const INIT_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-client', version: '1.0' } },
});

describe('ORB-1353 - persisted-session resilience (transport, fake api)', () => {
  let api: Server | null = null;
  const cleanups: Array<() => void> = [];

  afterEach(async () => {
    // Close any live MCP sessions so their event-bridge retry timers don't leak.
    for (const c of cleanups.splice(0)) c();
    if (server) {
      const internals = (server as unknown as { __mcp?: McpServerInternals }).__mcp;
      if (internals) {
        for (const s of internals.sessions.values()) {
          try { await s.transport.close(); } catch { /* ignore */ }
        }
      }
    }
    await new Promise<void>((r) => (api ? api.close(() => r()) : r()));
    api = null;
  });

  async function startWithFakeApi(
    store: McpSessionStore,
    fake = fakeApi(),
  ): Promise<{ base: string; internals: McpServerInternals }> {
    api = fake.api;
    await new Promise<void>((r) => api!.listen(0, r));
    const { port: apiPort } = api!.address() as AddressInfo;
    server = createHttpServer({ baseUrl: `http://127.0.0.1:${apiPort}`, sessionStore: store });
    await new Promise<void>((r) => server!.listen(0, r));
    const { port } = server!.address() as AddressInfo;
    const internals = (server as unknown as { __mcp: McpServerInternals }).__mcp;
    return { base: `http://127.0.0.1:${port}`, internals };
  }

  async function post(base: string, body: string, headers: Record<string, string>): Promise<Response> {
    return fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body,
    });
  }

  it('rehydrates the SAME session id after an in-memory restart (layer 1)', async () => {
    const store = fakeStore();
    const { base, internals } = await startWithFakeApi(store.store);

    // 1. Initialise a session and capture its id.
    const initRes = await post(base, INIT_BODY, { authorization: 'Bearer orb_alice' });
    expect(initRes.status).toBe(200);
    const sid = initRes.headers.get('mcp-session-id');
    await initRes.text();
    expect(sid).toBeTruthy();
    // The freshly-minted session was persisted.
    await vi.waitFor(() => expect(store.rows.has(sid!)).toBe(true));

    // 2. Simulate an api restart: the in-memory registry is wiped, the store
    //    (DB) survives.
    internals.sessions.clear();

    // 3. The next call with the OLD id + valid auth rehydrates under the SAME id.
    const res = await post(base, NON_INIT, { authorization: 'Bearer orb_alice', 'mcp-session-id': sid! });
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBe(sid);
    await res.text();
    expect(store.resolve).toHaveBeenCalledWith('orb_alice', sid);
  });

  it('auto-adopts an unknown session id under a FRESH id when auth is valid (layer 2)', async () => {
    const store = fakeStore();
    const { base } = await startWithFakeApi(store.store);

    const stale = 'sess_dead_from_zcode';
    const res = await post(base, NON_INIT, { authorization: 'Bearer orb_bob', 'mcp-session-id': stale });
    expect(res.status).toBe(200);
    const newId = res.headers.get('mcp-session-id');
    await res.text();
    expect(newId).toBeTruthy();
    expect(newId).not.toBe(stale);
    // Adoption is recorded old -> new.
    expect(store.register).toHaveBeenCalledWith('orb_bob', expect.objectContaining({ sessionId: newId, adoptedFrom: stale }));
  });

  it('keeps the ORB-1324 404 contract for an unknown id WITHOUT valid auth', async () => {
    const store = fakeStore();
    const { base } = await startWithFakeApi(store.store);

    const res = await post(base, NON_INIT, { authorization: 'Bearer invalid', 'mcp-session-id': 'whatever' });
    expect(res.status).toBe(404);
    expect(res.headers.get('www-authenticate')).toBeNull();
    const bodyText = await res.text();
    expect(bodyText).toMatch(/reinitialize/i);
    // No session was adopted for an unauthenticated request.
    expect(store.register).not.toHaveBeenCalled();
  });

  it('refuses to adopt when the MCP kill-switch is OFF (returns 404, not a session)', async () => {
    const store = fakeStore();
    const { base } = await startWithFakeApi(store.store, fakeApi({ enabled: false }));

    const res = await post(base, NON_INIT, { authorization: 'Bearer orb_carol', 'mcp-session-id': 'sess_stale' });
    expect(res.status).toBe(404);
    await res.text();
    expect(store.register).not.toHaveBeenCalled();
  });
});

/**
 * ORB-1576 — MCP transport hardening.
 *
 *  1. Bearer rotation is only adopted when the presented bearer resolves
 *     to the SESSION OWNER (a session id + any valid token is no longer a
 *     cross-user attach/poison capability).
 *  2. DELETE only tears down the owner's own session (404 otherwise).
 *  3. readJsonBody caps at 5 MB (unauthenticated memory-exhaustion DoS).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer as createNodeServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { createHttpServer, type McpServerInternals, type McpSessionStore } from './http-transport.js';

let server: Server | null = null;
let api: Server | null = null;

afterEach(async () => {
  if (server) {
    const internals = (server as unknown as { __mcp?: McpServerInternals }).__mcp;
    if (internals) {
      for (const s of internals.sessions.values()) {
        try { await s.transport.close(); } catch { /* ignore */ }
      }
    }
    server.close();
    server = null;
  }
  await new Promise<void>((r) => (api ? api.close(() => r()) : r()));
  api = null;
});

/** Fake API whose /system/mcp/status maps bearer -> per-user email. */
function fakeApiPerUser() {
  const api = createNodeServer((req, res) => {
    const url = req.url ?? '';
    if (url.startsWith('/system/mcp/status')) {
      const auth = (req.headers.authorization ?? '') as string;
      const email = auth === 'Bearer orb_alice' || auth === 'Bearer orb_alice_rot'
        ? 'alice@example.com'
        : auth === 'Bearer orb_mallory'
          ? 'mallory@example.com'
          : null;
      if (!email) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid token' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ enabled: true, mcpUseGranted: true, userMcpEnabled: true, userEmail: email }));
      return;
    }
    if (url.startsWith('/agent-instructions')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ instructions: '' }));
      return;
    }
    if (url.startsWith('/sse/mcp-events')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end();
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  return api;
}

const store: McpSessionStore = {
  register: async () => {},
  resolve: async () => false,
  remove: async () => {},
};

async function start(): Promise<string> {
  api = fakeApiPerUser();
  await new Promise<void>((r) => api!.listen(0, r));
  const { port: apiPort } = api!.address() as AddressInfo;
  server = createHttpServer({ baseUrl: `http://127.0.0.1:${apiPort}`, sessionStore: store });
  await new Promise<void>((r) => server!.listen(0, r));
  const { port } = server!.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

const INIT_BODY = JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
});
const NON_INIT = JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 2 });

async function post(base: string, body: string, headers: Record<string, string>): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body,
  });
}

async function initSession(base: string, bearer: string): Promise<string> {
  const res = await post(base, INIT_BODY, { authorization: `Bearer ${bearer}` });
  expect(res.status).toBe(200);
  const sid = res.headers.get('mcp-session-id');
  expect(sid).toBeTruthy();
  await res.text();
  return sid!;
}

describe('ORB-1576 — session binding', () => {
  it('rotation adopted for the SAME user, rejected for a different user', async () => {
    const base = await start();
    const sid = await initSession(base, 'orb_alice');

    // Same user, rotated token -> adopted (200).
    const rotated = await post(base, NON_INIT, { authorization: 'Bearer orb_alice_rot', 'mcp-session-id': sid });
    expect(rotated.status).toBe(200);
    await rotated.text();

    // Different user with a VALID token -> 401, holder not adopted.
    const hijack = await post(base, NON_INIT, { authorization: 'Bearer orb_mallory', 'mcp-session-id': sid });
    expect(hijack.status).toBe(401);
    await hijack.text();
  });

  it('DELETE tears down only the owner session', async () => {
    const base = await start();
    const sid = await initSession(base, 'orb_alice');

    const mallory = await fetch(`${base}/mcp`, {
      method: 'DELETE',
      headers: { authorization: 'Bearer orb_mallory', 'mcp-session-id': sid },
    });
    expect(mallory.status).toBe(404);

    const alice = await fetch(`${base}/mcp`, {
      method: 'DELETE',
      headers: { authorization: 'Bearer orb_alice', 'mcp-session-id': sid },
    });
    expect(alice.status).toBe(200);
  });
});

describe('ORB-1576 — request body cap', () => {
  it('a >5 MB body is rejected (no memory growth, no 200)', async () => {
    const base = await start();
    const big = 'x'.repeat(6 * 1024 * 1024);
    let status = 0;
    let errored = false;
    try {
      const res = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer orb_alice' },
        body: big,
      });
      status = res.status;
      await res.text();
    } catch {
      errored = true; // connection reset mid-write is an acceptable outcome too
    }
    expect(errored || status === 400).toBe(true);
  });
});

// vitest fake-timer hygiene for the bridge internals
void vi;

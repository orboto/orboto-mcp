/**
 * ORB-1175 — after a deploy the MCP container loses its in-memory session
 * map, so a client's existing mcp-session-id is unknown. The transport
 * must answer 404 (the Streamable-HTTP spec signal to re-initialise)
 * rather than the old opaque 400, so OAuth-connected clients recover
 * transparently instead of failing with a generic execution error.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { createHttpServer, closeAllMcpSessions, type McpSession } from './http-transport.js';

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

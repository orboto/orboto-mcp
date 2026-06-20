/**
 * ORB-1175 — after a deploy the MCP container loses its in-memory session
 * map, so a client's existing mcp-session-id is unknown. The transport
 * must answer 404 (the Streamable-HTTP spec signal to re-initialise)
 * rather than the old opaque 400, so OAuth-connected clients recover
 * transparently instead of failing with a generic execution error.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { createHttpServer } from './http-transport.js';

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
  it('returns 404 (re-initialise signal) for an unknown session id on a non-init request', async () => {
    const base = await start();
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer orb_dummy', 'content-type': 'application/json', 'mcp-session-id': 'stale-after-deploy' },
      body: NON_INIT,
    });
    expect(res.status).toBe(404);
    // tells the client what to do + carries the OAuth re-discovery header
    expect(res.headers.get('www-authenticate')).toContain('Bearer');
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

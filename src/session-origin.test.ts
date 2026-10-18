/**
 * ORB-2544 - the origin header and one session row per MCP client.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer as createNodeServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpServer, type McpServerInternals, type McpSessionStore } from './http-transport.js';
import { formatOrigin, machineId, repoBasename, shortHost, stdioHarness, stdioOrigin } from './session-origin.js';
import { bindSessionInstance, mcpInstanceToken, releaseSessionInstance, stableClientInstance } from './tools/shared.js';
import { InboxChannel, SESSION_ENDED_NOTICE } from './inbox-channel.js';

describe('ORB-2544 - the origin header', () => {
  it('formats the fields it has and leaves the rest out', () => {
    expect(formatOrigin({ host: 'build-host', pid: 12, harness: 'claude-code', repo: null })).toBe('host=build-host&pid=12&harness=claude-code');
  });

  it('a stdio proxy takes the origin the CLI handed over and names itself as the client', () => {
    const params = new URLSearchParams(stdioOrigin({ ORBOTO_ORIGIN: 'host=build-host&pid=99&harness=claude-code&client=orboto-cli&version=1.0.0' }));
    expect(params.get('pid')).toBe('99');
    expect(params.get('harness')).toBe('claude-code');
    expect(params.get('client')).toBe('orboto-mcp');
  });

  it('ORB-2571 - a stdio proxy names the harness orboto <harness> started and its model, else the harness markers', () => {
    expect(stdioHarness({ ORBOTO_HARNESS: 'kimi', CLAUDECODE: '1' })).toBe('kimi');
    expect(stdioHarness({ ORBOTO_HARNESS: 'antigravity' })).toBe('agy');
    expect(stdioHarness({ GEMINI_CLI: '1' })).toBe('gemini');
    expect(stdioHarness({ CODEX_SESSION_ID: 's' })).toBe('codex');
    expect(stdioHarness({})).toBe('mcp-stdio');
    const params = new URLSearchParams(stdioOrigin({ ORBOTO_HARNESS: 'agy', ORBOTO_MODEL: 'gemini-4-argon' }));
    expect(params.get('harness')).toBe('agy');
    expect(params.get('model')).toBe('gemini-4-argon');
    expect(new URLSearchParams(stdioOrigin({ ORBOTO_MODEL: 'has spaces' })).has('model')).toBe(false);
  });

  it('reduces the host to its first label and a checkout to the repository basename', () => {
    expect(shortHost('Build-Host.example.lan.')).toBe('build-host');
    const root = mkdtempSync(join(tmpdir(), 'origin-'));
    mkdirSync(join(root, 'sample-repo', '.git'), { recursive: true });
    mkdirSync(join(root, 'sample-repo', 'apps', 'api'), { recursive: true });
    expect(repoBasename(join(root, 'sample-repo', 'apps', 'api'))).toBe('sample-repo');
  });

  it('hashes the machine id once', () => {
    const read = vi.fn(() => 'platform-uuid');
    const first = machineId(read);
    expect(first === null || /^[0-9a-f]{16}$/.test(first)).toBe(true);
    expect(machineId(read)).toBe(first);
  });
});

describe('ORB-2544 - one token per MCP client', () => {
  it('the same account, credential and client keep one token; another client id gets its own; no id falls back', () => {
    const one = stableClientInstance({ userEmail: 'a@example.com', credential: { kind: 'oauth', id: 'client-1' }, client: 'claude-code@2.0' });
    expect(one).toMatch(/^mcp-[0-9a-f]{16}$/);
    expect(stableClientInstance({ userEmail: 'A@example.com', credential: { kind: 'oauth', id: 'client-1' }, client: 'claude-code@2.1' })).toBe(one);
    expect(stableClientInstance({ userEmail: 'a@example.com', credential: { kind: 'oauth', id: 'client-2' }, client: 'claude-code' })).not.toBe(one);
    expect(stableClientInstance({ userEmail: 'a@example.com', credential: null })).toBeNull();
  });

  it('a bound transport session acts under the stable token until it is released', () => {
    bindSessionInstance('sid-1', 'mcp-stable');
    bindSessionInstance('sid-2', 'mcp-stable');
    expect(mcpInstanceToken(undefined, { sessionId: 'sid-1' })).toBe('mcp-stable');
    expect(releaseSessionInstance('sid-1')).toEqual({ token: 'mcp-stable', shared: true });
    expect(releaseSessionInstance('sid-2')).toEqual({ token: 'mcp-stable', shared: false });
    expect(mcpInstanceToken(undefined, { sessionId: 'sid-1' })).toBe('mcp-sid-1');
  });
});

let server: Server | null = null;
let api: Server | null = null;

afterEach(async () => {
  if (server) {
    const internals = (server as unknown as { __mcp?: McpServerInternals }).__mcp;
    for (const s of internals?.sessions.values() ?? []) { try { await s.transport.close(); } catch { /* ignore */ } }
    server.close();
    server = null;
  }
  await new Promise<void>((r) => (api ? api.close(() => r()) : r()));
  api = null;
});

describe('ORB-2544 - an MCP client reconnecting five times', () => {
  it('opens every live-events stream under one token and ends it resumably on each close', async () => {
    const streams: string[] = [];
    const ended: string[] = [];
    const origins: string[] = [];
    api = createNodeServer((req, res) => {
      const url = req.url ?? '';
      if (url.startsWith('/system/mcp/status')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ enabled: true, mcpUseGranted: true, userMcpEnabled: true, userEmail: 'alice@example.com', credential: { kind: 'oauth', id: 'client-1' } }));
        return;
      }
      if (url.startsWith('/sse/mcp-events')) {
        streams.push(String(req.headers['x-orboto-agent-session'] ?? ''));
        origins.push(String(req.headers['x-orboto-origin'] ?? ''));
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end();
        return;
      }
      if (url.startsWith('/v1/agent/end-session')) {
        ended.push(String(req.headers['x-orboto-agent-session'] ?? ''));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(url.startsWith('/agent-instructions') ? JSON.stringify({ instructions: '' }) : '{}');
    });
    await new Promise<void>((r) => api!.listen(0, r));
    const store: McpSessionStore = { register: async () => {}, resolve: async () => false, remove: async () => {} };
    server = createHttpServer({ baseUrl: `http://127.0.0.1:${(api.address() as AddressInfo).port}`, sessionStore: store });
    await new Promise<void>((r) => server!.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    for (let i = 0; i < 5; i += 1) {
      const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer orb_alice', 'user-agent': 'claude-code/2.0' }, body: init });
      const sid = res.headers.get('mcp-session-id')!;
      await res.text();
      await vi.waitFor(() => expect(streams.length).toBe(i + 1));
      await fetch(`${base}/mcp`, { method: 'DELETE', headers: { authorization: 'Bearer orb_alice', 'mcp-session-id': sid } });
      await vi.waitFor(() => expect(ended.length).toBe(i + 1));
    }
    const expected = stableClientInstance({ userEmail: 'alice@example.com', credential: { kind: 'oauth', id: 'client-1' }, client: 'claude-code' });
    expect(new Set(streams)).toEqual(new Set([expected]));
    expect(new Set(ended)).toEqual(new Set([expected]));
    expect(new URLSearchParams(origins[0]).get('harness')).toBe('mcp-oauth');
  });
});

describe('ORB-2544 - the end notice on the wake channel', () => {
  it('emits the notice once and stops the channel', async () => {
    const notification = vi.fn(async () => {});
    const channel = new InboxChannel({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k', instanceToken: 'tok', mcp: { server: { notification } } as never, fetchFn: (() => new Promise(() => {})) as never });
    await channel.deliverNotice(SESSION_ENDED_NOTICE, 'The operator ended this orboto session (stale).');
    expect(notification).toHaveBeenCalledTimes(1);
    expect((channel as unknown as { closed: boolean }).closed).toBe(true);
  });
});

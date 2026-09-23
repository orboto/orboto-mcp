/**
 * ORB-2140 - the inbox channel: stream messages become channel notifications,
 * digest policy, dedupe across reconnects, and the capability declaration.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CHANNEL_CAPABILITY, CHANNEL_INSTRUCTIONS, CHANNEL_METHOD, CLI_OUTDATED_NOTICE, InboxChannel, RESTART_REQUESTED_NOTICE, cliOutdatedNotice, digestMinutesFromEnv, isImmediate, renderEvent, type InboxMessage } from './inbox-channel.js';
import { buildOrbotoMcpServer } from './server.js';
import { _forgetDeclaredScopes, rememberDeclaredScope, rememberedScope } from './session-scope-memory.js';

function mockMcp() {
  const notification = vi.fn().mockResolvedValue(undefined);
  return { mcp: { server: { notification } } as unknown as McpServer, notification };
}

function sse(frames: unknown[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const NOW = Date.parse('2026-09-18T10:00:00Z');
const msg = (over: Partial<InboxMessage> = {}): InboxMessage => ({
  id: 'm1', fromUserId: 'u-spec', kind: 'request', subject: 'ticket-ready:ORB-1', payload: { message: 'please take it' },
  threadId: null, projectKey: 'ORB', createdAt: '2026-09-18 09:59:30+00',
  from: { email: 'spec@orboto.io', sessionId: 'aaaaaaaa-0000-4000-8000-000000000000', role: 'spec', label: 'spec@orboto.io (spec, aaaaaaaa)' },
  to: { email: 'claude@orboto.io', sessionId: 'bbbbbbbb-0000-4000-8000-000000000000', role: 'integrator', label: 'claude@orboto.io (integrator, bbbbbbbb)' },
  ...over,
});

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('renderEvent / isImmediate', () => {
  it('names both parties, carries id, project and thread, and caps the body', () => {
    const e = renderEvent(msg({ threadId: 't1', payload: { message: 'x'.repeat(2500) } }), NOW);
    expect(e.content.split('\n')[0]).toBe('[request] ticket-ready:ORB-1');
    expect(e.content.split('\n')[1]).toBe('from spec@orboto.io (spec, aaaaaaaa) to claude@orboto.io (integrator, bbbbbbbb) | project ORB | id m1 | thread t1');
    expect(e.content).toContain('[... cut, read the rest with orboto_messages]');
    expect(e.meta).toMatchObject({ id: 'm1', kind: 'request', project: 'ORB', from_session: 'aaaaaaaa', to_session: 'bbbbbbbb', waited_min: '0' });
  });

  it('request, error, a question and a message that waited over five minutes go out at once; plain info is digest material', () => {
    expect(isImmediate(msg({ kind: 'info', payload: { message: 'pushed abc' } }), NOW, 15)).toBe(false);
    expect(isImmediate(msg({ kind: 'request' }), NOW, 15)).toBe(true);
    expect(isImmediate(msg({ kind: 'error', payload: null }), NOW, 15)).toBe(true);
    expect(isImmediate(msg({ kind: 'info', payload: { message: 'can you check?' } }), NOW, 15)).toBe(true);
    expect(isImmediate(msg({ kind: 'info', payload: { message: 'old' }, createdAt: '2026-09-18 09:50:00+00' }), NOW, 15)).toBe(true);
    expect(isImmediate(msg({ kind: 'info', payload: { message: 'pushed abc' } }), NOW, 0)).toBe(true);
  });

  it('reads the digest window from the environment with a safe default', () => {
    expect(digestMinutesFromEnv(undefined)).toBe(15);
    expect(digestMinutesFromEnv('0')).toBe(0);
    expect(digestMinutesFromEnv('7.9')).toBe(7);
    expect(digestMinutesFromEnv('nope')).toBe(15);
    expect(digestMinutesFromEnv('-3')).toBe(15);
  });
});

describe('InboxChannel', () => {
  it('turns each streamed message into one channel notification and batches info into a digest', async () => {
    const { mcp, notification } = mockMcp();
    const fetchFn = vi.fn().mockResolvedValueOnce(sse([
      msg(),
      msg({ id: 'm2', kind: 'info', subject: 'pushed 1', payload: { message: 'ok' }, createdAt: '2026-09-18 09:59:50+00' }),
      msg({ id: 'm3', kind: 'complete', subject: 'done 2', payload: null, createdAt: '2026-09-18 09:59:55+00' }),
    ])).mockImplementation(() => new Promise(() => { /* second connect never resolves */ }));
    const channel = new InboxChannel({ baseUrl: 'https://x.test', apiKey: 'orb_k', instanceToken: 'mcp-proc', mcp, fetchFn, log: () => {}, digestMinutes: 15 });
    channel.start();
    await vi.waitFor(() => expect(notification).toHaveBeenCalledTimes(1));
    const first = notification.mock.calls[0][0] as { method: string; params: { content: string; meta: Record<string, string> } };
    expect(first.method).toBe(CHANNEL_METHOD);
    expect(first.params.meta.id).toBe('m1');
    expect(fetchFn.mock.calls[0][1].headers['x-orboto-agent-session']).toBe('mcp-proc');
    expect(String(fetchFn.mock.calls[0][0])).toContain('/v1/agent/messages/stream?since=2026-09-18T10%3A00%3A00.000Z');
    expect(channel.stats).toMatchObject({ delivered: 1, digested: 2 });

    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(notification).toHaveBeenCalledTimes(2);
    const digest = notification.mock.calls[1][0] as { params: { content: string; meta: Record<string, string> } };
    expect(digest.params.meta).toMatchObject({ kind: 'digest', count: '2' });
    expect(digest.params.content).toContain('- [info] pushed 1');
    expect(digest.params.content).toContain('- [complete] done 2');
    channel.close();
  });

  it('reconnects from the last delivered id and never delivers a message twice', async () => {
    const { mcp, notification } = mockMcp();
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(sse([msg()]))
      .mockResolvedValueOnce(sse([msg(), msg({ id: 'm9', subject: 'second' })]))
      .mockImplementation(() => new Promise(() => { /* hold */ }));
    const channel = new InboxChannel({ baseUrl: 'https://x.test', apiKey: 'orb_k', instanceToken: 'mcp-proc', mcp, fetchFn, log: () => {}, digestMinutes: 0 });
    channel.start();
    await vi.waitFor(() => expect(notification).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(notification).toHaveBeenCalledTimes(2));
    expect(String(fetchFn.mock.calls[1][0])).toContain('since=m1');
    expect(channel.stats).toMatchObject({ delivered: 2, duplicates: 1 });
    expect(channel.stats.reconnects).toBeGreaterThanOrEqual(1);
    channel.close();
  });

  it('ORB-2209 - every reconnect sends the same instance token, re-sends the declared scope and applies the session frame without an event', async () => {
    _forgetDeclaredScopes();
    rememberDeclaredScope('mcp-proc', { role: 'worker', projectKeys: ['ORB'] });
    const { mcp, notification } = mockMcp();
    const frame = (count: number) => ({ session: { id: 'sess-1111', scope: { role: 'worker', projectKeys: ['ORB'] }, resumed: count > 0, scopeRestored: false, reconnects: count, lastReconnectAt: count ? '2026-09-18T10:00:02.000Z' : null } });
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(sse([frame(0)]))
      .mockResolvedValueOnce(sse([frame(1)]))
      .mockImplementation(() => new Promise(() => { /* hold */ }));
    const channel = new InboxChannel({ baseUrl: 'https://x.test', apiKey: 'orb_k', instanceToken: 'mcp-proc', mcp, fetchFn, log: () => {}, digestMinutes: 0 });
    channel.start();
    await vi.waitFor(() => expect(channel.session?.reconnects).toBe(0));
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(channel.session?.reconnects).toBe(1));
    expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const [url, init] of fetchFn.mock.calls.slice(0, 2)) {
      expect(init.headers['x-orboto-agent-session']).toBe('mcp-proc');
      expect(String(url)).toContain('sessionFrame=1');
      expect(decodeURIComponent(String(url))).toContain('declaredScope={"role":"worker","projectKeys":["ORB"]}');
    }
    expect(channel.session).toMatchObject({ id: 'sess-1111', resumed: true, scope: { projectKeys: ['ORB'] } });
    expect(notification).not.toHaveBeenCalled();
    channel.close();
  });

  it('ORB-2209 - a proxy that never declared a scope, or cleared it, re-sends nothing; a server-confirmed scope replaces the remembered one', async () => {
    _forgetDeclaredScopes();
    const { mcp } = mockMcp();
    const fetchFn = vi.fn().mockImplementation(() => new Promise(() => { /* hold */ }));
    const quiet = new InboxChannel({ baseUrl: 'https://x.test', apiKey: 'orb_k', instanceToken: 'mcp-never', mcp, fetchFn, log: () => {}, digestMinutes: 0 });
    quiet.start();
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    expect(String(fetchFn.mock.calls[0][0])).not.toContain('declaredScope');
    quiet.close();

    rememberDeclaredScope('mcp-cleared', null);
    expect(rememberedScope('mcp-cleared')).toBeNull();
    rememberDeclaredScope('mcp-changed', { projectKeys: ['OLD'] });
    const changed = new InboxChannel({ baseUrl: 'https://x.test', apiKey: 'orb_k', instanceToken: 'mcp-changed', mcp, fetchFn, log: () => {}, digestMinutes: 0 });
    changed.applySession({ id: 's', scope: { projectKeys: ['NEW'] }, resumed: true, scopeRestored: false, reconnects: 3, lastReconnectAt: null });
    expect(rememberedScope('mcp-changed')).toEqual({ projectKeys: ['NEW'] });
    changed.applySession({ id: 's', scope: null, resumed: true, scopeRestored: false, reconnects: 4, lastReconnectAt: null });
    expect(rememberedScope('mcp-changed')).toEqual({ projectKeys: ['NEW'] });
    rememberDeclaredScope('mcp-never-2', null);
    const other = new InboxChannel({ baseUrl: 'https://x.test', apiKey: 'orb_k', instanceToken: 'mcp-untouched', mcp, fetchFn, log: () => {}, digestMinutes: 0 });
    other.applySession({ id: 's', scope: { projectKeys: ['SRV'] }, resumed: false, scopeRestored: false, reconnects: 0, lastReconnectAt: null });
    expect(rememberedScope('mcp-untouched')).toBeNull();
  });

  it('ORB-2151 - a server notice becomes its own event and never becomes the replay anchor', async () => {
    const { mcp, notification } = mockMcp();
    const hint = { notice: 'declare_scope', sessionId: 'cccccccc-0000-4000-8000-000000000000', content: 'declare your scope: orboto_session_start { scope: { role, projectKeys } }' };
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(sse([hint, msg()]))
      .mockImplementation(() => new Promise(() => { /* hold */ }));
    const channel = new InboxChannel({ baseUrl: 'https://x.test', apiKey: 'orb_k', instanceToken: 'mcp-proc', mcp, fetchFn, log: () => {}, digestMinutes: 0 });
    channel.start();
    await vi.waitFor(() => expect(notification).toHaveBeenCalledTimes(2));
    const first = notification.mock.calls[0][0] as { params: { content: string; meta: Record<string, string> } };
    expect(first.params.meta).toEqual({ kind: 'notice', notice: 'declare_scope' });
    expect(first.params.content).toContain('orboto_session_start');
    expect(channel.stats).toMatchObject({ notices: 1, delivered: 1 });
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
    expect(String(fetchFn.mock.calls[1][0])).toContain('since=m1');
    channel.close();
  });

  it('ORB-2181 - a restart_requested notice becomes the supervisor request file and says so', async () => {
    const { mcp, notification } = mockMcp();
    const writeRestart = vi.fn().mockReturnValue({ written: true, sessionId: 'sess-1', path: '/home/a/.orboto/claude/sess-1/restart.json', detail: 'ok' });
    const fetchFn = vi.fn().mockImplementation(() => new Promise(() => { /* hold */ }));
    const channel = new InboxChannel({ baseUrl: 'https://x.test', apiKey: 'orb_k', instanceToken: 'mcp-proc', mcp, fetchFn, log: () => {}, digestMinutes: 0, writeRestart });
    await channel.deliverNotice(RESTART_REQUESTED_NOTICE, 'the CLI was updated');
    expect(writeRestart).toHaveBeenCalledWith(process.cwd(), { reason: 'the CLI was updated', source: 'channel' });
    const sent = notification.mock.calls[0][0] as { params: { content: string; meta: Record<string, string> } };
    expect(sent.params.meta).toEqual({ kind: 'notice', notice: 'restart_requested' });
    expect(sent.params.content).toContain('resumes the same conversation');
    expect(channel.stats).toMatchObject({ notices: 1, delivered: 0 });
    channel.close();
  });

  it('ORB-2181 - a restart_requested notice that cannot be written says why instead of pretending', async () => {
    const { mcp, notification } = mockMcp();
    const writeRestart = vi.fn().mockReturnValue({ written: false, sessionId: null, path: null, detail: 'no status line report' });
    const fetchFn = vi.fn().mockImplementation(() => new Promise(() => { /* hold */ }));
    const channel = new InboxChannel({ baseUrl: 'https://x.test', apiKey: 'orb_k', instanceToken: 'mcp-proc', mcp, fetchFn, log: () => {}, digestMinutes: 0, writeRestart });
    await channel.deliverNotice(RESTART_REQUESTED_NOTICE, 'rotated key');
    const sent = notification.mock.calls[0][0] as { params: { content: string } };
    expect(sent.params.content).toContain('no status line report');
    channel.close();
  });

  it('ORB-2175 - the stale-CLI finding from `mcp serve` becomes one cli_outdated notice on connect', async () => {
    expect(cliOutdatedNotice(undefined)).toBe('');
    expect(cliOutdatedNotice('   ')).toBe('');
    const finding = 'CLI 0.200.0 is older than the instance 0.201.0 - run `orboto self-update` and restart this session';
    const content = cliOutdatedNotice(finding);
    expect(content).toContain(finding);
    expect(content).toContain('two instance tokens');

    const { mcp, notification } = mockMcp();
    const fetchFn = vi.fn().mockImplementation(() => new Promise(() => { /* hold */ }));
    const channel = new InboxChannel({ baseUrl: 'https://x.test', apiKey: 'orb_k', instanceToken: 'mcp-proc', mcp, fetchFn, log: () => {}, digestMinutes: 0 });
    await channel.deliverNotice(CLI_OUTDATED_NOTICE, content);
    expect(notification).toHaveBeenCalledTimes(1);
    const sent = notification.mock.calls[0][0] as { params: { content: string; meta: Record<string, string> } };
    expect(sent.params.meta).toEqual({ kind: 'notice', notice: 'cli_outdated' });
    expect(sent.params.content).toBe(content);
    expect(channel.stats).toMatchObject({ notices: 1, delivered: 0 });
    channel.close();
  });
});

describe('server capability', () => {
  async function connect(channel: boolean) {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline test'));
    const server = await buildOrbotoMcpServer({ baseUrl: 'https://x.test', apiKey: 'orb_k', channel });
    const client = new Client({ name: 't', version: '0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    return { server, client };
  }

  it('declares claude/channel and the channel instructions only when asked (stdio)', async () => {
    const on = await connect(true);
    expect(on.client.getServerCapabilities()?.experimental).toHaveProperty(CHANNEL_CAPABILITY);
    expect(on.client.getInstructions()).toContain(CHANNEL_INSTRUCTIONS.slice(0, 40));
    await on.client.close(); await on.server.close();
    const off = await connect(false);
    expect(off.client.getServerCapabilities()?.experimental ?? {}).not.toHaveProperty(CHANNEL_CAPABILITY);
    expect(off.client.getInstructions() ?? '').not.toContain('Inbox channel:');
    await off.client.close(); await off.server.close();
  });
});

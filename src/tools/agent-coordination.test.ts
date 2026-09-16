/**
 * ORB-705 - Multi-Agent Coordination MCP tools.
 *
 * Pins the contract that each tool wraps the right REST endpoint
 * with the right body shape and surfaces the response. The actual
 * end-to-end push behaviour is covered by the API-side tests in
 * agent-sessions.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import {
  makeAgentHeartbeatHandler,
  makeAgentPresenceHandler,
  makeAgentNotifyHandler,
} from './agent-coordination.js';
import { makeAgentMessagesHandler } from './agent-messages.js';

afterEach(() => { vi.restoreAllMocks(); });

function stub(responses: Array<{ ok?: boolean; status?: number; json?: unknown }>) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    const r = responses.shift();
    if (!r) throw new Error('unexpected fetch');
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      statusText: 'OK',
      json: async () => ('json' in r ? r.json : {}),
      text: async () => '',
    } as unknown as Response;
  });
}

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_test' });

describe('orboto_agent_heartbeat', () => {
  it('POSTs to /v1/agent/heartbeat with the merged body + returns the session token', async () => {
    stub([{ json: { sessionToken: 'abc-123-token', sessionId: '00000000-0000-0000-0000-000000000001' } }]);
    const handler = makeAgentHeartbeatHandler(client);
    const result = await handler({
      status: 'working',
      capabilities: ['writes-tickets'],
      clientInfo: { name: 'claude-code' },
    });
    expect(result.structuredContent).toMatchObject({
      sessionToken: 'abc-123-token',
      sessionId: '00000000-0000-0000-0000-000000000001',
    });
    expect((result.content[0] as { text: string }).text).toContain('heartbeat ack');
  });
});

describe('orboto_agent_presence', () => {
  it('GETs /v1/agent/inventory and renders one line per session', async () => {
    stub([{
      json: [
        {
          userId: '00000000-0000-0000-0000-000000000001',
          userEmail: 'alice@x.test',
          userFullName: 'Alice', kind: 'human', isBot: false, actsAs: null, owner: null, autonomyPaused: false, lane: null, projects: [], connections: [], workSessions: [],
          sessionId: '00000000-0000-0000-0000-000000000010',
          status: 'working',
          workingOnTicket: { id: '00000000-0000-0000-0000-000000000020', key: 'ORB-42', title: 'Test', projectKey: 'ORB' },
          capabilities: ['writes-tickets'],
          clientInfo: { name: 'claude-code' },
          lastSeenAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        },
        {
          userId: '00000000-0000-0000-0000-000000000002',
          userEmail: 'bot@x.test',
          userFullName: null, kind: 'agent', isBot: true, actsAs: null, owner: { id: '00000000-0000-0000-0000-000000000001', name: 'Alice', email: 'alice@x.test' },
          autonomyPaused: false, lane: null, projects: [{ id: '00000000-0000-0000-0000-000000000030', key: 'ORB', name: 'orboto' }], connections: [{ type: 'api_key', label: 'dispatcher' }], workSessions: [],
          sessionId: '00000000-0000-0000-0000-000000000011',
          status: 'idle',
          workingOnTicket: null,
          capabilities: [],
          clientInfo: { name: 'dispatcher-daemon' },
          lastSeenAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        },
      ],
    }]);
    const handler = makeAgentPresenceHandler(client);
    const result = await handler();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('2 active session(s)');
    expect(text).toContain('Alice <alice@x.test> (claude-code, instance 00000000-0000-0000-0000-000000000010) - working · working on [ORB] ORB-42');
    expect(text).toContain('bot@x.test <bot@x.test> (dispatcher-daemon, instance 00000000-0000-0000-0000-000000000011) - idle; owner: Alice');
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('https://orboto.example.com/v1/agent/inventory');
    expect((result.structuredContent as { sessions: unknown[] }).sessions).toHaveLength(2);
  });

  it('handles an empty workspace gracefully', async () => {
    stub([{ json: [] }]);
    const handler = makeAgentPresenceHandler(client);
    const result = await handler();
    expect((result.content[0] as { text: string }).text).toBe('No active agent sessions in the workspace.');
  });

  const presenceRows = () => [
    { userId: '00000000-0000-0000-0000-000000000001', userEmail: 'alice@x.test', userFullName: 'Alice', kind: 'human', isBot: false, actsAs: null, owner: null, autonomyPaused: false, lane: null, projects: [{ id: '00000000-0000-0000-0000-000000000030', key: 'ORB', name: 'orboto' }], connections: [{ type: 'api_key', label: 'laptop' }], workSessions: [], sessionId: '00000000-0000-0000-0000-000000000010', status: 'working', workingOnTicket: null, capabilities: [], clientInfo: { name: 'claude-code' }, lastSeenAt: new Date().toISOString(), createdAt: new Date().toISOString() },
    { userId: '00000000-0000-0000-0000-000000000002', userEmail: 'worker@x.test', userFullName: null, kind: 'agent', isBot: true, actsAs: null, owner: { id: '00000000-0000-0000-0000-000000000001', name: 'Alice', email: 'alice@x.test' }, autonomyPaused: false, lane: { id: '00000000-0000-0000-0000-000000000040', name: 'worker-1', role: 'implementation', paused: false }, projects: [{ id: '00000000-0000-0000-0000-000000000031', key: 'ACME', name: 'Acme' }, { id: '00000000-0000-0000-0000-000000000030', key: 'ORB', name: 'orboto' }], connections: [{ type: 'lane', label: 'worker-1' }, { type: 'live_events', label: 'MCP live events' }], workSessions: [], sessionId: '00000000-0000-0000-0000-000000000011', status: 'idle', workingOnTicket: null, capabilities: [], clientInfo: { name: 'pi' }, lastSeenAt: new Date().toISOString(), createdAt: new Date().toISOString() },
    { userId: '00000000-0000-0000-0000-000000000001', userEmail: 'alice@x.test', userFullName: 'Alice', kind: 'agent', isBot: true, actsAs: { id: '00000000-0000-0000-0000-000000000001', name: 'Alice', email: 'alice@x.test' }, owner: null, autonomyPaused: false, lane: null, projects: [], connections: [{ type: 'oauth', label: 'claude.ai' }], workSessions: [], sessionId: '00000000-0000-0000-0000-000000000012', status: 'idle', workingOnTicket: null, capabilities: [], clientInfo: {}, lastSeenAt: new Date().toISOString(), createdAt: new Date().toISOString() },
  ];

  it('filters by projectKey (case-insensitive, projects only) and kind on the client side (ORB-2135)', async () => {
    const handler = makeAgentPresenceHandler(client);
    const ids = async (args: { projectKey?: string; kind?: 'agent' | 'human' }) => {
      stub([{ json: presenceRows() }]);
      const result = await handler(args);
      expect(vi.mocked(fetch).mock.calls.at(-1)?.[0]).toBe('https://orboto.example.com/v1/agent/inventory');
      return (result.structuredContent as { sessions: Array<{ sessionId: string }> }).sessions.map((s) => s.sessionId.slice(-2));
    };
    expect(await ids({})).toEqual(['10', '11', '12']);
    expect(await ids({ kind: 'agent' })).toEqual(['11', '12']);
    expect(await ids({ kind: 'human' })).toEqual(['10']);
    expect(await ids({ projectKey: 'acme' })).toEqual(['11']);
    expect(await ids({ projectKey: 'ORB', kind: 'human' })).toEqual(['10']);
    expect(await ids({ projectKey: 'NONE' })).toEqual([]);
  });

  it('says when a filter matched nothing but the workspace is not empty', async () => {
    stub([{ json: presenceRows() }]);
    const result = await makeAgentPresenceHandler(client)({ projectKey: 'NONE' });
    expect((result.content[0] as { text: string }).text).toBe('No active agent sessions match the filter (3 active in the workspace).');
  });

  it('renders acts-as, lane, projects and connection types on each line', async () => {
    stub([{ json: presenceRows() }]);
    const text = ((await makeAgentPresenceHandler(client)({ kind: 'agent' })).content[0] as { text: string }).text;
    expect(text).toContain('2 active session(s)');
    expect(text).toContain('owner: Alice; lane: worker-1; projects: ACME, ORB; connections: lane, live_events');
    expect(text).toContain('owner: acts as Alice; connections: oauth');
  });
});

describe('orboto_agent_notify', () => {
  it('POSTs to /v1/agent/notify with the body the user supplied', async () => {
    const capturedBody: unknown[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody.push(JSON.parse((init?.body as string) ?? '{}'));
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ ok: true }),
        text: async () => '',
      } as unknown as Response;
    });

    const handler = makeAgentNotifyHandler(client);
    const result = await handler({
      targetEmail: 'bob@example.com',
      kind: 'request',
      subject: 'Please review ORB-42',
      payload: { ticketKey: 'ORB-42' },
    });

    expect(capturedBody[0]).toMatchObject({
      targetEmail: 'bob@example.com',
      kind: 'request',
      subject: 'Please review ORB-42',
      payload: { ticketKey: 'ORB-42' },
    });
    expect((result.content[0] as { text: string }).text).toContain('notified bob@example.com');
    expect(result.structuredContent).toMatchObject({ ok: true });
    expect((capturedBody[0] as { senderRef?: string }).senderRef).toMatch(/^mcp-/);
  });

  it('ORB-1742: senderRef prefers the per-connection MCP session id, and an explicit ref wins outright', async () => {
    const capturedBody: unknown[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody.push(JSON.parse((init?.body as string) ?? '{}'));
      return {
        ok: true, status: 200, statusText: 'OK',
        json: async () => ({ ok: true, messageId: '00000000-0000-4000-8000-000000000000' }),
        text: async () => '',
      } as unknown as Response;
    });
    const handler = makeAgentNotifyHandler(client);
    await handler({ targetEmail: 'bob@example.com', subject: 'hi' }, { sessionId: 'abc123' });
    expect((capturedBody[0] as { senderRef?: string }).senderRef).toBe('mcp-abc123');
    await handler({ targetEmail: 'bob@example.com', subject: 'hi', senderRef: 'runner:custom' }, { sessionId: 'abc123' });
    expect((capturedBody[1] as { senderRef?: string }).senderRef).toBe('runner:custom');
  });
});

describe('orboto_messages (ORB-1742 self-echo exclusion)', () => {
  it('fetches with excludeRef = the session ref by default; includeOwnSends drops the filter', async () => {
    const urls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      urls.push(String(url));
      return {
        ok: true, status: 200, statusText: 'OK',
        json: async () => ({ messages: [] }),
        text: async () => '',
      } as unknown as Response;
    });
    const handler = makeAgentMessagesHandler(client);
    await handler({}, { sessionId: 'abc123' });
    expect(urls[0]).toContain('excludeRef=mcp-abc123');
    await handler({ includeOwnSends: true }, { sessionId: 'abc123' });
    expect(urls[1]).not.toContain('excludeRef');
  });
});

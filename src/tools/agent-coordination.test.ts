/**
 * ORB-705 - Multi-Agent Coordination MCP tools.
 *
 * Pins the contract that each tool wraps the right REST endpoint
 * with the right body shape and surfaces the response. The actual
 * end-to-end push behaviour is covered by the API-side tests in
 * agent-sessions.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { OrbotoApiError, OrbotoClient } from '../orboto-client.js';
import {
  NOTIFY_PRIORITIES,
  NOTIFY_ROUTED_TO,
  agentNotifyToolConfig,
  reminderSentNotice,
  reminderTooSoonText,
  repeatedSendNotice,
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
  it('GETs the inventory through /v1/agent/who and renders one line per session with its origin and state (ORB-2544)', async () => {
    stub([{
      json: { sessions: [], inventory: [
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
          origin: { host: 'build-host', repo: 'sample-repo', pid: 4242, client: 'orboto-cli', clientVersion: '1.2.3', harness: 'claude-code', startedAt: null },
          state: 'orphaned',
        },
      ] },
    }]);
    const handler = makeAgentPresenceHandler(client);
    const result = await handler();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('2 active session(s)');
    expect(text).toContain('Alice <alice@x.test> (claude-code, instance 00000000-0000-0000-0000-000000000010) - working · working on [ORB] ORB-42');
    expect(text).toContain('bot@x.test <bot@x.test> (dispatcher-daemon, instance 00000000-0000-0000-0000-000000000011) - idle [orphaned] on build-host sample-repo pid 4242 claude-code orboto-cli 1.2.3; owner: Alice');
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('https://orboto.example.com/v1/agent/who?include=inventory&limit=4');
    expect((result.structuredContent as { sessions: unknown[] }).sessions).toHaveLength(2);
  });

  it('handles an empty workspace gracefully', async () => {
    stub([{ json: { sessions: [], inventory: [] } }]);
    const handler = makeAgentPresenceHandler(client);
    const result = await handler();
    expect((result.content[0] as { text: string }).text).toBe('No active agent sessions in the workspace.');
  });

  const presenceRows = () => [
    { userId: '00000000-0000-0000-0000-000000000001', userEmail: 'alice@x.test', userFullName: 'Alice', kind: 'human', isBot: false, actsAs: null, owner: null, autonomyPaused: false, lane: null, projects: [{ id: '00000000-0000-0000-0000-000000000030', key: 'ORB', name: 'orboto' }], connections: [{ type: 'api_key', label: 'laptop' }], workSessions: [], sessionId: '00000000-0000-0000-0000-000000000010', status: 'working', workingOnTicket: null, capabilities: [], clientInfo: { name: 'claude-code' }, lastSeenAt: new Date().toISOString(), createdAt: new Date().toISOString() },
    { userId: '00000000-0000-0000-0000-000000000002', userEmail: 'worker@x.test', userFullName: null, kind: 'agent', isBot: true, actsAs: null, owner: { id: '00000000-0000-0000-0000-000000000001', name: 'Alice', email: 'alice@x.test' }, autonomyPaused: false, lane: { id: '00000000-0000-0000-0000-000000000040', name: 'worker-1', role: 'implementation', paused: false }, projects: [{ id: '00000000-0000-0000-0000-000000000031', key: 'ACME', name: 'Acme' }, { id: '00000000-0000-0000-0000-000000000030', key: 'ORB', name: 'orboto' }], connections: [{ type: 'lane', label: 'worker-1' }, { type: 'live_events', label: 'MCP live events' }], workSessions: [], sessionId: '00000000-0000-0000-0000-000000000011', status: 'idle', workingOnTicket: null, capabilities: [], clientInfo: { name: 'pi' }, lastSeenAt: new Date().toISOString(), createdAt: new Date().toISOString() },
    { userId: '00000000-0000-0000-0000-000000000001', userEmail: 'alice@x.test', userFullName: 'Alice', kind: 'agent', isBot: true, actsAs: { id: '00000000-0000-0000-0000-000000000001', name: 'Alice', email: 'alice@x.test' }, owner: null, autonomyPaused: false, lane: null, projects: [], connections: [{ type: 'oauth', label: 'claude.ai' }], workSessions: [], sessionId: '00000000-0000-0000-0000-000000000012', status: 'idle', workingOnTicket: null, capabilities: [], clientInfo: {}, lastSeenAt: new Date().toISOString(), createdAt: new Date().toISOString() },
  ];

  it('ORB-2548: sends every filter to the one presence read, projectKey as project, four rows a page by default', async () => {
    const handler = makeAgentPresenceHandler(client);
    const url = async (args: Parameters<typeof handler>[0]) => {
      stub([{ json: { sessions: [], inventory: [] } }]);
      await handler(args);
      return String(vi.mocked(fetch).mock.calls.at(-1)?.[0]);
    };
    expect(await url({})).toBe('https://orboto.example.com/v1/agent/who?include=inventory&limit=4');
    expect(await url({ projectKey: 'acme', kind: 'agent' })).toBe('https://orboto.example.com/v1/agent/who?include=inventory&project=acme&kind=agent&limit=4');
    expect(await url({ email: 'w@x.test', sessionId: 'c785946f', role: 'worker', wake: 'on_call', state: 'live', limit: 2, cursor: 'next-1' }))
      .toBe('https://orboto.example.com/v1/agent/who?include=inventory&role=worker&state=live&email=w%40x.test&sessionId=c785946f&wake=on_call&cursor=next-1&limit=2');
  });

  it('ORB-2548: a projectKey that is unknown or not visible answers in one line instead of a raw 404', async () => {
    stub([{ ok: false, status: 404, json: { errorKey: 'errors.agents.message_project_not_found' } }]);
    const result = await makeAgentPresenceHandler(client)({ projectKey: 'nope' });
    expect(result.isError).toBeUndefined();
    expect((result.content[0] as { text: string }).text).toBe('Project "NOPE" is unknown or not visible to you - no session is listed for it.');
    expect(result.structuredContent).toEqual({ sessions: [], nextCursor: null });
    stub([{ ok: false, status: 404, json: {} }]);
    await expect(makeAgentPresenceHandler(client)({ email: 'x@y.test' })).rejects.toThrow();
  });

  it('says when a filter matched nothing', async () => {
    stub([{ json: { sessions: [], inventory: [] } }]);
    const result = await makeAgentPresenceHandler(client)({ projectKey: 'NONE' });
    expect((result.content[0] as { text: string }).text).toBe('No active agent session matches the filter.');
  });

  it('renders acts-as, lane, scope, projects and connection types on each line and returns the compact row', async () => {
    const rows = presenceRows().filter((row) => row.kind === 'agent').map((row, i) => (i === 0 ? { ...row, scope: { role: 'worker', projectKeys: ['ACME'] }, wake: 'channel' } : row));
    stub([{ json: { sessions: [], inventory: rows, nextCursor: 'cursor-2' } }]);
    const result = await makeAgentPresenceHandler(client)({ kind: 'agent' });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('2 active session(s) on this page');
    expect(text).toContain('owner: Alice; lane: worker-1; scope: worker on ACME; projects: ACME, ORB; connections: lane, live_events; reachable by channel');
    expect(text).toContain('owner: acts as Alice; connections: oauth');
    expect(text).toContain('More sessions: call again with cursor "cursor-2"');
    const structured = result.structuredContent as { sessions: Array<Record<string, unknown>>; nextCursor: string | null };
    expect(structured.nextCursor).toBe('cursor-2');
    expect(structured.sessions[0]).toEqual({
      sessionId: '00000000-0000-0000-0000-000000000011', userEmail: 'worker@x.test', userFullName: null, kind: 'agent', owner: 'Alice',
      status: 'idle', lane: 'worker-1', scope: { role: 'worker', projectKeys: ['ACME'] }, memberProjects: 2, connections: ['lane', 'live_events'],
      wake: 'channel', origin: null, workingOn: null, lastSeenAt: rows[0]!.lastSeenAt,
    });
    expect(structured.sessions[1]).toMatchObject({ owner: 'acts as Alice', memberProjects: 0, connections: ['oauth'] });
  });

  it('names the member count instead of listing more than eight projects', async () => {
    const many = Array.from({ length: 99 }, (_, i) => ({ id: '00000000-0000-0000-0000-000000000030', key: `P${i}`, name: `Project ${i}` }));
    stub([{ json: { sessions: [], inventory: [{ ...presenceRows()[1], projects: many }] } }]);
    const text = ((await makeAgentPresenceHandler(client)({})).content[0] as { text: string }).text;
    expect(text).toContain('; member of 99 projects;');
    expect(text).not.toContain('P98');
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
    const refused = await handler({ targetEmail: 'bob@example.com', kind: 'request', subject: 'Please review ORB-42' });
    expect(refused.isError).toBe(true);
    expect((refused.content[0] as { text: string }).text).toContain('`outcome` is required for a request');
    const noOutcome = await handler({ targetEmail: 'bob@example.com', kind: 'complete', subject: 'Done' });
    expect((noOutcome.content[0] as { text: string }).text).toContain('`outcome` is required for a complete');
    expect(capturedBody).toHaveLength(0);

    const bareEmail = await handler({ targetEmail: 'bob@example.com', kind: 'request', subject: 'Please review ORB-42', outcome: 'ORB-42 has a review verdict' });
    expect(bareEmail.isError).toBeUndefined();
    expect(capturedBody).toHaveLength(1);
    capturedBody.length = 0;

    const result = await handler({
      targetEmail: 'bob@example.com',
      kind: 'request',
      subject: 'Please review ORB-42',
      outcome: 'ORB-42 has a review verdict',
      project: 'ORB',
      payload: { ticketKey: 'ORB-42' },
    });

    expect(capturedBody[0]).toMatchObject({
      targetEmail: 'bob@example.com',
      kind: 'request',
      subject: 'Please review ORB-42',
      outcome: 'ORB-42 has a review verdict',
      project: 'ORB',
      payload: { ticketKey: 'ORB-42' },
    });
    expect((result.content[0] as { text: string }).text).toContain('notified bob@example.com');
    expect(result.structuredContent).toMatchObject({ ok: true });
    expect((capturedBody[0] as { senderRef?: string }).senderRef).toMatch(/^agent-/);
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

describe('orboto_agent_notify routing (ORB-2263)', () => {
  it('mirrors the routedTo values of the shared schema', () => {
    const shared = readFileSync(new URL('../../../../packages/shared-schema/src/agent-message-kinds.ts', import.meta.url), 'utf8');
    const match = shared.match(/AgentNotifyRoutedToSchema = z\.enum\(\[([^\]]+)\]\)/);
    expect(match).not.toBeNull();
    const values = match![1].split(',').map((v) => v.trim().replace(/'/g, ''));
    expect(values).toEqual([...NOTIFY_ROUTED_TO]);
    expect(agentNotifyToolConfig.description).toContain('routedTo');
    expect(agentNotifyToolConfig.description).toContain('no session declared KEY');
  });

  it('answers routedTo account with the routing note so the sender escalates', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
      ok: true, status: 200, statusText: 'OK',
      json: async () => ({ ok: true, messageId: '00000000-0000-4000-8000-000000000000', toSessionId: null, routedTo: 'account', routingNote: 'no session declared HIVE - the message waits in the account inbox and wakes no session; escalate or address a session instead of assuming delivery' }),
      text: async () => '',
    } as unknown as Response));
    const result = await makeAgentNotifyHandler(client)({ targetEmail: 'bot@example.org', kind: 'request', subject: 'build HIVE-720', outcome: 'HIVE-720 is built and in review', project: 'HIVE' });
    expect(result.structuredContent).toMatchObject({ routedTo: 'account', routingNote: expect.stringContaining('no session declared HIVE') });
    expect((result.content[0] as { text: string }).text).toContain('routed to account - no session declared HIVE');
  });

  it('ORB-2465: passes the agent-broadcast live hint on in the text, not in the output schema', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
      ok: true, status: 200, statusText: 'OK',
      json: async () => ({ ok: true, messageId: '00000000-0000-4000-8000-000000000000', toSessionId: null, routedTo: 'account', hint: 'account mail without --project wakes no particular session; send orboto agent-broadcast live' }),
      text: async () => '',
    } as unknown as Response));
    const result = await makeAgentNotifyHandler(client)({ targetEmail: 'bot@example.org', kind: 'info', subject: 'restart' });
    expect((result.content[0] as { text: string }).text).toContain('\nhint: account mail without --project');
    expect(result.structuredContent).not.toHaveProperty('hint');
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
    expect(urls[1]).toContain('includeOwn=true');
  });

  it('ORB-2547: an own send renders as sent with the recipient session, its delivered/read state and the thread', async () => {
    const party = (label: string, sessionId: string | null) => ({ userId: 'u', email: 'e', sessionId, role: null, label });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
      ok: true, status: 200, statusText: 'OK',
      json: async () => ({ sessionId: '11111111-1111-4111-8111-111111111111', messages: [
        { id: '22222222-2222-4222-8222-222222222222', fromUserId: 'u', toUserId: 'v', from: party('me (11111111)', '11111111'), to: party('peer (44444444)', '44444444'), kind: 'complete', subject: 'done', payload: null, threadId: '33333333-3333-4333-8333-333333333333', projectKey: 'ALPHA', createdAt: '2026-10-16T10:00:00Z', deliveredAt: '2026-10-16T10:00:05Z', readAt: null, dismissed: null, own: true },
      ] }),
      text: async () => '',
    } as unknown as Response));
    const result = await makeAgentMessagesHandler(client)({ includeOwnSends: true }, { sessionId: 'abc123' });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('[sent] delivered 2026-10-16T10:00:05Z, unread [complete] [ALPHA] done (from me (11111111) to peer (44444444)');
    expect(text).toContain('thread 33333333-3333-4333-8333-333333333333');
    expect((result.structuredContent as { messages: Array<Record<string, unknown>> }).messages[0]).toMatchObject({ own: true, deliveredAt: '2026-10-16T10:00:05Z', threadId: '33333333-3333-4333-8333-333333333333' });
  });
});

describe('ORB-2136 - session addressing', () => {
  it('agent_notify forwards toSessionRef and sends this MCP session as x-orboto-agent-session', async () => {
    const seen: Array<{ body: Record<string, unknown>; headers: Record<string, string> }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      seen.push({ body: JSON.parse((init?.body as string) ?? '{}'), headers: (init?.headers ?? {}) as Record<string, string> });
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ ok: true, messageId: '00000000-0000-4000-8000-000000000000', toSessionId: 'cbb52195-0000-4000-8000-000000000000' }), text: async () => '' } as unknown as Response;
    });
    const result = await makeAgentNotifyHandler(client)({ targetEmail: 'bob@example.com', subject: 'hi', toSessionRef: 'cbb52195' }, { sessionId: 'abc123' });
    expect(seen[0].body).toMatchObject({ toSessionRef: 'cbb52195', senderRef: 'mcp-abc123' });
    expect(seen[0].headers['x-orboto-agent-session']).toBe('mcp-abc123');
    expect((result.content[0] as { text: string }).text).toContain('bob@example.com session cbb52195');
    expect(result.structuredContent).toMatchObject({ toSessionId: 'cbb52195-0000-4000-8000-000000000000' });
  });

  it('ORB-2548: toSessionRef alone is a recipient - sent without to or targetEmail, the answer names the session', async () => {
    const seen: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      seen.push(JSON.parse((init?.body as string) ?? '{}'));
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ ok: true, messageId: '00000000-0000-4000-8000-000000000000', toSessionId: 'cbb52195-0000-4000-8000-000000000000', routedTo: 'session' }), text: async () => '' } as unknown as Response;
    });
    const result = await makeAgentNotifyHandler(client)({ subject: 'hi', toSessionRef: 'cbb52195' }, { sessionId: 'abc123' });
    expect(result.isError).toBeUndefined();
    expect(seen[0]).toMatchObject({ toSessionRef: 'cbb52195', subject: 'hi' });
    expect(seen[0]).not.toHaveProperty('to');
    expect((result.content[0] as { text: string }).text).toContain('notified session cbb52195 (message');
    vi.restoreAllMocks();
    const none = await makeAgentNotifyHandler(client)({ subject: 'hi' });
    expect(none.isError).toBe(true);
    expect((none.content[0] as { text: string }).text).toContain('`toSessionRef` (a session id or its short id)');
  });

  it('orboto_messages identifies this session on the fetch and renders sender and receiver identities', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      seen.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
      return {
        ok: true, status: 200, statusText: 'OK',
        json: async () => ({ sessionId: 'cbb52195-0000-4000-8000-000000000000', messages: [{
          id: 'm1', fromUserId: 'u1', toUserId: 'u2', fromSessionId: 's1', toSessionId: 's2',
          from: { userId: 'u1', email: 'spec@orboto.io', sessionId: 's1', role: 'spec', label: 'spec@orboto.io (spec, s1)' },
          to: { userId: 'u2', email: 'claude@orboto.io', sessionId: 's2', role: 'integrator', label: 'claude@orboto.io (integrator, s2)' },
          kind: 'request', subject: 'ticket-ready:ORB-1', payload: null, threadId: null, projectKey: 'ORB', createdAt: 'now', deliveredAt: null, readAt: null,
        }] }),
        text: async () => '',
      } as unknown as Response;
    });
    const result = await makeAgentMessagesHandler(client)({}, { sessionId: 'abc123' });
    expect(seen[0].headers['x-orboto-agent-session']).toBe('mcp-abc123');
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('from spec@orboto.io (spec, s1) to claude@orboto.io (integrator, s2)');
    expect(text).toContain('This session: cbb52195 (ref mcp-abc123)');
    expect(result.structuredContent).toMatchObject({ sessionId: 'cbb52195-0000-4000-8000-000000000000', messages: [{ from: { role: 'spec' }, to: { sessionId: 's2' } }] });
  });

  it('agent_heartbeat carries the scope and the session header', async () => {
    const seen: Array<{ body: Record<string, unknown>; headers: Record<string, string> }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      seen.push({ body: JSON.parse((init?.body as string) ?? '{}'), headers: (init?.headers ?? {}) as Record<string, string> });
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ sessionToken: 'mcp-abc123', sessionId: 'cbb52195-0000-4000-8000-000000000000', scope: { role: 'integrator', projectKeys: ['ORB'] } }), text: async () => '' } as unknown as Response;
    });
    const result = await makeAgentHeartbeatHandler(client)({ scope: { role: 'integrator', projectKeys: ['orb'] } }, { sessionId: 'abc123' });
    expect(seen[0].body).toMatchObject({ scope: { role: 'integrator', projectKeys: ['orb'] } });
    expect(seen[0].headers['x-orboto-agent-session']).toBe('mcp-abc123');
    expect(result.structuredContent).toMatchObject({ scope: { role: 'integrator', projectKeys: ['ORB'] } });
  });

  it('agent_heartbeat names the starter and answers the recorded one (ORB-2449)', async () => {
    const starter = '5a1c0d2e-7b3f-4c11-9e2a-0c0ffee00001';
    const seen: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      seen.push(JSON.parse((init?.body as string) ?? '{}'));
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ sessionToken: 'mcp-abc123', sessionId: 'cbb52195-0000-4000-8000-000000000000', scope: { role: 'worker' }, startedBy: starter }), text: async () => '' } as unknown as Response;
    });
    const result = await makeAgentHeartbeatHandler(client)({ scope: { role: 'worker' }, startedBy: starter }, { sessionId: 'abc123' });
    expect(seen[0]).toMatchObject({ startedBy: starter });
    expect(result.structuredContent).toMatchObject({ startedBy: starter });
  });
});

describe('orboto_agent_notify role addresses (ORB-2264)', () => {
  it('sends `to` as written, lists every recipient and needs no targetEmail', async () => {
    const bodies: unknown[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(String((init as RequestInit).body)));
      return {
        ok: true, status: 200, statusText: 'OK', text: async () => '',
        json: async () => ({
          ok: true, messageId: '00000000-0000-4000-8000-000000000001', toSessionId: '00000000-0000-4000-8000-0000000000aa', routedTo: 'session',
          messageIds: ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'],
          recipients: [{ label: 'claude@orboto.io (integrator, aaaaaaaa)', sessionId: 'a' }, { label: 'claude+b@orboto.io (integrator, bbbbbbbb)', sessionId: 'b' }],
        }),
      } as unknown as Response;
    });
    const result = await makeAgentNotifyHandler(client)({ to: 'integrator@ORB', kind: 'request', subject: 'release 0.212.0', outcome: 'the release is tagged and deployed' });
    expect(bodies[0]).toMatchObject({ to: 'integrator@ORB', kind: 'request' });
    expect((bodies[0] as { targetEmail?: string }).targetEmail).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ routedTo: 'session', recipients: ['claude@orboto.io (integrator, aaaaaaaa)', 'claude+b@orboto.io (integrator, bbbbbbbb)'] });
  });

  it('turns 409 no_recipient into a tool error that names the live sessions and the queue option', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
      ok: false, status: 409, statusText: 'Conflict', json: async () => ({}),
      text: async () => JSON.stringify({
        error: 'x', errorKey: 'errors.agents.no_recipient',
        errorParams: { address: 'review@ORB', reason: 'no_recipient', liveSessions: [{ shortId: 'f072e1c5', email: 'claude@orboto.io', addresses: ['integrator@ORB'] }] },
      }),
    } as unknown as Response));
    const result = await makeAgentNotifyHandler(client)({ to: 'review@ORB', kind: 'request', subject: 'review ORB-1', outcome: 'ORB-1 is reviewed with findings' });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('review@ORB');
    expect(text).toContain('integrator@ORB (claude@orboto.io, f072e1c5)');
    expect(text).toContain('queue: true');
  });

  it('refuses a message without any recipient before calling the API', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const result = await makeAgentNotifyHandler(client)({ subject: 'nobody' });
    expect(result.isError).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(agentNotifyToolConfig.description).toContain('integrator@KEY');
  });
});

describe('orboto_agent_notify body and refusals (ORB-2555)', () => {
  const sentBodies = () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(String((init as RequestInit).body)));
      return { ok: true, status: 200, statusText: 'OK', text: async () => '', json: async () => ({ ok: true, messageId: '00000000-0000-4000-8000-000000000001', toSessionId: null, routedTo: 'account' }) } as unknown as Response;
    });
    return bodies;
  };

  it('maps body into payload.body next to other payload keys and carries text beyond the outcome cap', async () => {
    const bodies = sentBodies();
    const long = 'detail line\n'.repeat(400);
    await makeAgentNotifyHandler(client)({ to: 'worker@ORB', kind: 'complete', subject: 'report', outcome: 'the report is delivered in full', body: long, payload: { ticketKey: 'ORB-1' } });
    expect(bodies[0]!.payload).toEqual({ ticketKey: 'ORB-1', body: long.trimEnd() });
    expect(bodies[0]!.body).toBeUndefined();
    await makeAgentNotifyHandler(client)({ to: 'worker@ORB', subject: 'plain', body: 'text' });
    expect(bodies[1]!.payload).toEqual({ body: 'text' });
  });

  it('trims trailing newlines of the body and counts its limit in bytes like the CLI', async () => {
    const bodies = sentBodies();
    const handler = makeAgentNotifyHandler(client);
    await handler({ to: 'worker@ORB', subject: 's', body: 'text\r\n\n' });
    expect(bodies[0]!.payload).toEqual({ body: 'text' });
    const tooBig = await handler({ to: 'worker@ORB', subject: 's', body: 'ä'.repeat(500 * 1024) });
    expect((tooBig.content[0] as { text: string }).text).toContain('bytes, at most 921600 (900 KiB)');
    expect(bodies).toHaveLength(1);
  });

  it('refuses an outcome over 1000 characters with the remedy and a complete example, sending nothing', async () => {
    const bodies = sentBodies();
    const result = await makeAgentNotifyHandler(client)({ to: 'integrator@ORB', kind: 'complete', subject: 'report', outcome: 'x'.repeat(1001) });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('`outcome` has 1001 characters, at most 1000');
    expect(text).toContain('put the long text into `body`');
    expect(text).toContain('Example: orboto_agent_notify { to: "integrator@ORB", kind: "complete"');
    expect(bodies).toHaveLength(0);
  });

  it('names the missing field with an example per kind', async () => {
    const bodies = sentBodies();
    const handler = makeAgentNotifyHandler(client);
    const text = async (args: Parameters<typeof handler>[0]) => ((await handler(args)).content[0] as { text: string }).text;
    expect(await text({ to: 'integrator@ORB', kind: 'request', subject: 's' })).toContain('outcome: "<what must be true when it is done>", body: "<details, any length>"');
    expect(await text({ to: 'integrator@ORB', kind: 'error', subject: 's', outcome: 'short' })).toContain('`outcome` has 5 characters, at least 10');
    expect(await text({ to: 'integrator@ORB', subject: 's', body: '  ' })).toContain('`body` is empty');
    expect(await text({ to: 'integrator@ORB', subject: 's', body: 'x', payload: { body: 'y' } })).toContain('`body` and `payload.body` are both set');
    expect(await text({ subject: 's' })).toContain('Example: orboto_agent_notify { to: "integrator@KEY", kind: "info"');
    expect(bodies).toHaveLength(0);
  });

  it('turns the ambiguous account 409 into a tool error listing the sessions and asking for toSessionRef', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
      ok: false, status: 409, statusText: 'Conflict', json: async () => ({}),
      text: async () => JSON.stringify({
        errorKey: 'errors.agents.no_recipient',
        errorParams: { address: 'claude@orboto.io', reason: 'ambiguous_account', liveSessions: [
          { shortId: 'f072e1c5', email: 'claude@orboto.io', addresses: ['worker@ORB'] }, { shortId: 'a072e1c5', email: 'claude@orboto.io', addresses: ['review@ORB'] },
        ] },
      }),
    } as unknown as Response));
    const result = await makeAgentNotifyHandler(client)({ targetEmail: 'claude@orboto.io', kind: 'request', subject: 's', outcome: 'ORB-1 is reviewed with findings' });
    const text = (result.content[0] as { text: string }).text;
    expect(result.isError).toBe(true);
    expect(text).toContain('has 2 live sessions');
    expect(text).toContain('worker@ORB (claude@orboto.io, f072e1c5)');
    expect(text).toContain('`toSessionRef`');
    expect(text).toContain('integrator@KEY');
  });

  it('names every way on when the account has no live session', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
      ok: false, status: 409, statusText: 'Conflict', json: async () => ({}),
      text: async () => JSON.stringify({ errorKey: 'errors.agents.no_recipient', errorParams: { address: 'claude@orboto.io', reason: 'no_recipient', project: null, liveSessions: [] } }),
    } as unknown as Response));
    const result = await makeAgentNotifyHandler(client)({ targetEmail: 'claude@orboto.io', kind: 'request', subject: 's', outcome: 'ORB-1 is reviewed with findings' });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('a role address in `to` (integrator@KEY)');
    expect(text).toContain('`toSessionRef`');
    expect(text).toContain('`queue: true` with `project`');
  });
});

describe('orboto_agent_notify dedupe and reminders (ORB-2563)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('mirrors the priorities and sender lines of the shared schema', () => {
    const shared = readFileSync(new URL('../../../../packages/shared-schema/src/agent-message-dedupe.ts', import.meta.url), 'utf8');
    const match = shared.match(/AGENT_MESSAGE_PRIORITIES = \[([^\]]+)\]/);
    expect(match![1].split(',').map((v) => v.trim().replace(/'/g, ''))).toEqual([...NOTIFY_PRIORITIES]);
    expect(shared).toContain('`already delivered (sent ${repeatCount} times), not sent again`');
    expect(shared).toContain('`reminder ${reminderCount} sent (sent ${repeatCount} times)`');
    expect(repeatedSendNotice(3)).toBe('already delivered (sent 3 times), not sent again');
    expect(reminderSentNotice(1, 4)).toBe('reminder 1 sent (sent 4 times)');
    expect(agentNotifyToolConfig.description).toContain('remind: true');
    expect(agentNotifyToolConfig.description).toContain('Loops and retries never set remind or urgent');
  });

  it('says a deduplicated send was not sent again, and a reminder that it notified again', async () => {
    const answers = [
      { ok: true, messageId: '00000000-0000-4000-8000-000000000001', toSessionId: null, routedTo: 'account', deduplicated: true, repeatCount: 8 },
      { ok: true, messageId: '00000000-0000-4000-8000-000000000001', toSessionId: null, routedTo: 'account', deduplicated: true, repeatCount: 9, reminded: true, reminderCount: 1 },
    ];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      const body = answers.shift();
      return { ok: true, status: 200, statusText: 'OK', json: async () => body, text: async () => '' } as unknown as Response;
    });
    const handler = makeAgentNotifyHandler(client);
    const silent = await handler({ targetEmail: 'bob@example.com', subject: 'hi' });
    expect((silent.content[0] as { text: string }).text).toContain('already delivered (sent 8 times), not sent again');
    expect(silent.structuredContent).toMatchObject({ messageId: '00000000-0000-4000-8000-000000000001' });
    const reminder = await handler({ targetEmail: 'bob@example.com', subject: 'hi', remind: true, urgent: true });
    expect((reminder.content[0] as { text: string }).text).toContain('reminder 1 sent (sent 9 times)');
    const sent = JSON.parse(String((fetch as unknown as { mock: { calls: Array<[unknown, { body: string }]> } }).mock.calls[1]![1].body));
    expect(sent).toMatchObject({ remind: true, priority: 'urgent' });
    expect(sent).not.toHaveProperty('urgent');
  });

  it('turns the 429 reminder_too_soon into a tool error with the wait', () => {
    const err = new OrbotoApiError(429, JSON.stringify({ errorKey: 'errors.agents.reminder_too_soon', errorParams: { messageId: 'm-1', retryAfter: 300 } }), 'http://x');
    expect(reminderTooSoonText(err)).toContain('allowed in 300 seconds');
    expect(reminderTooSoonText(new OrbotoApiError(409, '{}', 'http://x'))).toBeNull();
  });
});

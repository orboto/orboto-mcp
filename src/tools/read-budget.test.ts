/**
 * ORB-2548 - the evidence cases of the OCP integrator (2026-10-16) answered
 * inside the 4,000-character budget: presence returned 236,455 characters
 * with 1 of 32 rows kept, and finding one session took ~230 kB of expand
 * calls; the inbox needed one to three expand calls.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import { DEFAULT_BUDGET_CHARS, applyResponseBudget, budgetFor, measureHalves } from '../response-budget.js';
import { makeAgentPresenceHandler } from './agent-coordination.js';
import { makeAgentWhoHandler } from './agent-who.js';
import { makeAgentMessagesHandler } from './agent-messages.js';

afterEach(() => { vi.restoreAllMocks(); });

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_test' });
const uuid = (n: number, tail = 0) => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(tail).padStart(12, '0')}`;

/** One inventory row in the shape the evidence measured: a bot account that is a member of 80 projects (~10 kB, the live rows measured 1.7 to 10.3 kB). */
function inventoryRow(i: number) {
  const account = Math.floor(i / 4);
  return {
    userId: uuid(account, 1), userEmail: `agent-${account}-f82fd0ea@agents.internal`, userFullName: `Agent ${account}`, kind: 'agent', isBot: true,
    actsAs: null, owner: { id: uuid(900, 2), name: 'Operator Person', email: 'operator@example.test' }, autonomyPaused: false,
    sessionId: uuid(i, 3), status: 'idle', lane: null,
    projects: Array.from({ length: 80 }, (_, p) => ({ id: uuid(p, 4), key: `P${String(p).padStart(3, '0')}`, name: `Project number ${p} - long name` })),
    connections: [{ type: 'api_key', label: 'agent key for the build host' }, { type: 'channel', label: 'claude-code wake channel' }],
    wake: 'channel', workingOnTicket: { id: uuid(i, 5), key: `ORB-${2500 + i}`, title: 'A ticket title of ordinary length for a working session', projectKey: 'ORB' },
    workSessions: [{ ticketId: uuid(i, 5), ticketKey: `ORB-${2500 + i}`, role: 'implementation', leaseUntil: '2026-10-16T10:15:00.000Z', resourceClaims: [] }],
    capabilities: ['writes-tickets', 'reviews'],
    clientInfo: { name: 'claude-code', host: 'build-host.fritz.box', channel: 'claude-code', credential: 'api_key', credentialId: uuid(i, 6), credentialActor: 'agent', channelStart: 'orboto-claude', contextReportedAt: '2026-10-16T09:51:55.631Z' },
    scope: { projectKeys: ['OCP'], role: i === 17 ? 'integrator' : 'worker' },
    unreadMessages: 3, wakes: { count: 4, precision: 1, wrongWakeContextTokens: 0, backlogSeen: 0 },
    guard: { held: 0, released: 2, stalled: 0, consecutiveHolds: 0, lastOutcome: 'released', lastReason: null, lastAt: '2026-10-16T09:50:00.000Z', paused: false },
    knowledge: { writes: 0, asks: 1, lastAt: null, localPending: false },
    restartPending: false, restartReason: null, restartable: true, reconnects: 2, lastReconnectAt: '2026-10-16T09:40:00.000Z',
    lastSeenAt: '2026-10-16 09:54:00.504+00', createdAt: '2026-10-16 08:01:12.719715+00',
    origin: { host: 'build-host', machineId: '4ea7904991187bf1', repo: 'orboto-control-plane', pid: 15503 + i, startedAt: '2026-10-16T08:00:00.000Z', client: 'orboto-mcp', clientVersion: '0.224.0', harness: 'claude-code', credential: 'api_key', known: true },
    state: 'live', activity: 'live', touchedAt: '2026-10-16 09:54:00.504+00',
  };
}

const WORKSPACE = Array.from({ length: 32 }, (_, i) => inventoryRow(i));

/** The presence read as the API answers it: the ORB-2548 filters and the page on the server (the API side is tested in apps/api). */
function servePresence() {
  const urls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(String(input));
    urls.push(url.pathname + url.search);
    const q = url.searchParams;
    const rows = WORKSPACE.filter((r) => (!q.get('sessionId') || r.sessionId.startsWith(q.get('sessionId')!))
      && (!q.get('email') || r.userEmail === q.get('email'))
      && (!q.get('role') || r.scope.role === q.get('role')));
    const start = q.get('cursor') ? Number(q.get('cursor')) : 0;
    const limit = Number(q.get('limit') ?? rows.length);
    const page = rows.slice(start, start + limit);
    const nextCursor = start + limit < rows.length ? String(start + limit) : null;
    const sessions = page.map((r) => ({
      sessionId: r.sessionId, shortId: r.sessionId.slice(0, 8), userId: r.userId, email: r.userEmail, isBot: true, role: r.scope.role,
      projectKeys: r.scope.projectKeys, ticketKeys: [], addresses: [`${r.scope.role}@OCP`], lastSeenAt: r.lastSeenAt,
      channel: { announced: 'claude-code', online: true }, wake: r.wake, currentTicket: { key: r.workingOnTicket.key, title: r.workingOnTicket.title },
      status: r.status, host: 'build-host.fritz.box', origin: r.origin, state: r.state, activity: r.activity, createdAt: r.createdAt,
    }));
    const body = q.get('include') === 'inventory' ? { sessions, inventory: page, nextCursor } : { sessions, nextCursor };
    return { ok: true, status: 200, statusText: 'OK', json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
  });
  return urls;
}

function underBudget(tool: string, result: Awaited<ReturnType<ReturnType<typeof makeAgentPresenceHandler>>>) {
  const halves = measureHalves(result);
  const outcome = applyResponseBudget(tool, result, {});
  return { ...halves, truncated: outcome.truncatedChars, budget: budgetFor(tool, {}) };
}

describe('ORB-2548 - presence reads fit the MCP response budget', () => {
  it('reproduces the evidence: the unfiltered inventory of 32 sessions is over 230 kB, far over the 4,000 budget', () => {
    const all = JSON.stringify({ sessions: WORKSPACE }).length;
    expect(all).toBeGreaterThan(230_000);
    expect(budgetFor('orboto_agent_presence', {})).toBe(DEFAULT_BUDGET_CHARS);
  });

  it('one session by its short id comes back whole, under budget, without an expand handle', async () => {
    const urls = servePresence();
    const result = await makeAgentPresenceHandler(client)({ sessionId: uuid(17, 3).slice(0, 8) });
    const m = underBudget('orboto_agent_presence', result);
    expect(urls[0]).toBe(`/v1/agent/who?include=inventory&sessionId=${uuid(17, 3).slice(0, 8)}&limit=4`);
    expect(m.truncated).toBe(0);
    expect(m.structuredChars).toBeLessThan(DEFAULT_BUDGET_CHARS);
    expect(m.textChars).toBeLessThan(DEFAULT_BUDGET_CHARS);
    const { sessions } = result.structuredContent as { sessions: Array<{ sessionId: string; scope: { role: string } }> };
    expect(sessions).toEqual([expect.objectContaining({ sessionId: uuid(17, 3), scope: { projectKeys: ['OCP'], role: 'integrator' } })]);
    expect((result.content[0] as { text: string }).text).toContain(`instance ${uuid(17, 3)}`);
  });

  it('an account email with four sessions, and the unfiltered first page of four, stay under budget with nextCursor for the rest', async () => {
    servePresence();
    const byEmail = await makeAgentPresenceHandler(client)({ email: 'agent-2-f82fd0ea@agents.internal' });
    expect((byEmail.structuredContent as { sessions: unknown[] }).sessions).toHaveLength(4);
    expect(underBudget('orboto_agent_presence', byEmail)).toMatchObject({ truncated: 0 });
    const first = await makeAgentPresenceHandler(client)({});
    const m = underBudget('orboto_agent_presence', first);
    expect(m.truncated).toBe(0);
    expect(Math.max(m.textChars, m.structuredChars)).toBeLessThan(DEFAULT_BUDGET_CHARS);
    expect((first.structuredContent as { nextCursor: string | null }).nextCursor).toBe('4');
    expect((first.content[0] as { text: string }).text).toContain('call again with cursor "4"');
  });

  it('orboto_who answers the same filtered set under budget', async () => {
    const urls = servePresence();
    const result = await makeAgentWhoHandler(client)({ role: 'integrator' });
    expect(urls[0]).toBe('/v1/agent/who?role=integrator&limit=4');
    expect((result.structuredContent as { sessions: Array<{ sessionId: string }> }).sessions.map((s) => s.sessionId)).toEqual([uuid(17, 3)]);
    expect(underBudget('orboto_who', result)).toMatchObject({ truncated: 0 });
    const page = await makeAgentWhoHandler(client)({});
    expect(underBudget('orboto_who', page)).toMatchObject({ truncated: 0 });
  });
});

const party = (n: number, role: string) => ({ userId: uuid(n, 7), email: `agent-${n}@orboto.io`, sessionId: uuid(n, 8), role, label: `agent-${n}@orboto.io (${role}, ${uuid(n, 8).slice(0, 8)})` });

/** An inbox message in the measured live shape: a 182-character subject, a 1 kB payload, the compact excerpt. */
function message(i: number, threadId: string | null) {
  const body = `${'Status of the rollout on the tenant hosts, with the commands that ran and their exit codes. '.repeat(11)}`;
  return {
    id: uuid(100 + i, 9), fromUserId: uuid(1, 7), toUserId: uuid(2, 7), fromSessionId: uuid(1, 8), toSessionId: null,
    from: party(1, 'integrator'), to: party(2, 'worker'), kind: i % 2 ? 'complete' : 'request',
    subject: `OCP-${800 + i}: ${'rollout of the verified release to every tenant host, the backup first and core before the tenants, '.repeat(2).slice(0, 172)}`,
    payload: { body }, threadId, projectKey: 'OCP', createdAt: `2026-10-16 09:${String(10 + i).padStart(2, '0')}:00.504123+00`,
    deliveredAt: null, readAt: null, dismissed: null, excerpt: `body: ${body.slice(0, 294)}`, payloadChars: body.length + 6,
  };
}

function serveInbox(messages: ReturnType<typeof message>[]) {
  const urls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(String(input));
    urls.push(url.pathname + url.search);
    const q = url.searchParams;
    const rows = messages.filter((m) => (!q.get('threadId') || m.id === q.get('threadId') || m.threadId === q.get('threadId')) && (!q.get('kind') || m.kind === q.get('kind')));
    const limit = Number(q.get('limit'));
    const body = { messages: rows.slice(0, limit), sessionId: uuid(2, 8), counts: { unread: rows.length, olderThan7Days: 0 }, nextCursor: rows.length > limit ? 'next-page' : null };
    return { ok: true, status: 200, statusText: 'OK', json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
  });
  return urls;
}

describe('ORB-2548 - inbox reads fit the MCP response budget', () => {
  const inbox = [...Array.from({ length: 12 }, (_, i) => message(i, null)), ...Array.from({ length: 4 }, (_, i) => message(20 + i, uuid(100, 9)))];

  it('the default compact page (4) of full-size messages fits; the old default of 10 did not', async () => {
    serveInbox(inbox);
    const page = await makeAgentMessagesHandler(client)({});
    const m = underBudget('orboto_messages', page);
    expect(m.truncated).toBe(0);
    expect(Math.max(m.textChars, m.structuredChars)).toBeLessThan(DEFAULT_BUDGET_CHARS);
    expect((page.structuredContent as { nextCursor: string | null }).nextCursor).toBe('next-page');
    serveInbox(inbox);
    const old = await makeAgentMessagesHandler(client)({ limit: 10 });
    expect(underBudget('orboto_messages', old).truncated).toBeGreaterThan(0);
  });

  it('one thread and one kind are filtered on the server and come back under budget', async () => {
    const urls = serveInbox(inbox);
    const thread = await makeAgentMessagesHandler(client)({ threadId: uuid(100, 9) });
    expect(urls[0]).toContain(`threadId=${uuid(100, 9)}`);
    expect((thread.structuredContent as { messages: unknown[]; nextCursor: string | null })).toMatchObject({ nextCursor: 'next-page' });
    expect((thread.structuredContent as { messages: unknown[] }).messages).toHaveLength(4);
    expect(underBudget('orboto_messages', thread)).toMatchObject({ truncated: 0 });
    const sent = await makeAgentMessagesHandler(client)({ direction: 'sent', kind: 'request', limit: 3 });
    expect(urls[1]).toContain('direction=sent');
    expect(urls[1]).toContain('kind=request');
    expect(urls[1]).not.toContain('excludeRef');
    expect(underBudget('orboto_messages', sent)).toMatchObject({ truncated: 0 });
  });
});

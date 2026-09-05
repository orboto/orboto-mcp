/**
 * ORB-1611 - unit tests for orboto_work_start, the bundled acquire +
 * context-bundle tool. Mirrors work-sessions.test.ts's stub pattern; the
 * behaviours worth pinning: the bundle renders every section, the
 * instance token still rides unprompted, the per-connection rules-hash
 * cache round-trips across two calls, and the 409 paths (lease held,
 * claim conflict) read the same as orboto_work_session_start's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import { makeWorkStartHandler } from './work-sessions.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

function stub(responses: Array<{ ok?: boolean; status?: number; json?: unknown; text?: string }>) {
  const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push({
      url: url.toString(),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    const r = responses.shift();
    if (!r) throw new Error('unexpected extra fetch');
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      statusText: 'OK',
      json: async () => ('json' in r ? r.json : {}),
      text: async () => r.text ?? '',
    } as unknown as Response;
  });
  return calls;
}

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });
const PROJ = { id: 'p1', key: 'ACME', name: 'Acme', description: null, status: 'active' };
const TICKET = { id: 't1', ticketKey: 'ACME-42', title: 'Do the thing', projectId: 'p1' };

const SESSION = {
  id: 'ws1',
  ticketId: 't1',
  role: 'implementation',
  status: 'active',
  startedAt: '2026-07-24T10:00:00Z',
  leaseUntil: '2026-07-24T10:15:00Z',
  activeTimerId: 'timer1',
  commitSha: null,
  ticketKey: 'ACME-42',
};

const BUNDLE = {
  session: SESSION,
  reused: false,
  rulesHash: 'abc123',
  rulesUnchanged: false,
  rules: 'Follow the ticket-first rule.',
  primer: { markdown: '# Primer\nProject conventions.', totalTokens: 42 },
  ticket: {
    ticketKey: 'ACME-42',
    title: 'Do the thing',
    description: 'Needs doing.',
    status: 'IN_PROGRESS',
    statusName: 'In Progress',
    priority: 'high',
    type: 'task',
  },
  checklists: [
    {
      title: 'Acceptance criteria',
      triggersDone: true,
      progress: { done: 0, total: 1 },
      items: [{ content: 'Write a test', effectiveCompleted: false, linkedTicketKey: null, linkedTicketStatusCategory: null }],
    },
  ],
  dependencies: {
    blockedBy: [{ ticketKey: 'ACME-41', title: 'Blocker', statusName: 'To Do' }],
    blocks: [],
  },
  gitHealth: [],
  siblingSessions: [],
};

describe('orboto_work_start', () => {
  it('acquires the lease and renders every bundle section', async () => {
    const calls = stub([
      { json: [PROJ] },
      { json: TICKET },
      { json: BUNDLE },
    ]);
    const res = await makeWorkStartHandler(client)({ ticketKey: 'ACME-42' });
    const post = calls[calls.length - 1];
    expect(post.method).toBe('POST');
    expect(post.url).toContain('/work-sessions/start');
    expect(post.body?.ticketId).toBe('t1');
    // The instance token must be sent unprompted, same contract as
    // orboto_work_session_start.
    expect(String(post.body?.agentSessionToken)).toMatch(/^mcp-/);

    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('Started a implementation work session on ACME-42');
    expect(text).toContain('ws1');
    expect(text).toContain('## Working rules');
    expect(text).toContain('Follow the ticket-first rule.');
    expect(text).toContain('## Project primer');
    expect(text).toContain('Project conventions.');
    expect(text).toContain('## Ticket: ACME-42');
    expect(text).toContain('Needs doing.');
    expect(text).toContain('## Checklists');
    expect(text).toContain('Write a test');
    expect(text).toContain('## Dependencies');
    expect(text).toContain('ACME-41');
    expect(text).toContain('## Other sessions on this ticket');
    expect((res.structuredContent as { ticket: { ticketKey: string } }).ticket.ticketKey).toBe('ACME-42');
  });

  it('caches the rules hash across calls on the same connection and sends it back', async () => {
    const handler = makeWorkStartHandler(client);

    stub([{ json: [PROJ] }, { json: TICKET }, { json: BUNDLE }]);
    await handler({ ticketKey: 'ACME-42' });

    const calls2 = stub([
      { json: [PROJ] },
      { json: TICKET },
      { json: { ...BUNDLE, reused: true, rulesUnchanged: true, rules: undefined } },
    ]);
    const res2 = await handler({ ticketKey: 'ACME-42' });
    const post2 = calls2[calls2.length - 1];
    expect(post2.body?.knownRulesHash).toBe('abc123');
    const text2 = (res2.content[0] as { text: string }).text;
    expect(text2).toContain('Unchanged since your last work-start');
    expect(text2).toContain('not currently in your context');
    expect(text2).toContain('rulesOnly: true');
    expect(text2).not.toContain('keep following what you already loaded');
    expect(text2).toContain('Renewed your existing');
  });

  it('surfaces the lease holder on a 409 instead of throwing', async () => {
    const holder = {
      sessionId: 'other-session',
      userEmail: 'rival@orboto.test',
      userFullName: 'Rival Bot',
      role: 'implementation',
      startedAt: '2026-07-24T09:00:00Z',
      leaseUntil: '2026-07-24T09:15:00Z',
    };
    stub([
      { json: [PROJ] },
      { json: TICKET },
      { ok: false, status: 409, text: JSON.stringify({ error: 'held', errorKey: 'errors.work_sessions.lease_held', holder }) },
    ]);
    const res = await makeWorkStartHandler(client)({ ticketKey: 'ACME-42' });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('Rival Bot');
    expect(text).toContain('takeover=true');
    expect((res.structuredContent as { holder: { sessionId: string } }).holder.sessionId).toBe('other-session');
  });

  it('surfaces claim conflicts distinctly from a lease conflict on 409', async () => {
    const conflicts = [{
      claim: { kind: 'named', value: 'unity-editor:main', mode: 'write' },
      holders: [{ sessionId: 's2', ticketKey: 'ACME-9', userEmail: 'rival@orboto.test', userFullName: 'Rival Bot', claim: { kind: 'named', value: 'unity-editor:main', mode: 'write' } }],
    }];
    stub([
      { json: [PROJ] },
      { json: TICKET },
      { ok: false, status: 409, text: JSON.stringify({ error: 'held', errorKey: 'errors.work_sessions.claim_conflict', claimConflicts: conflicts }) },
    ]);
    const res = await makeWorkStartHandler(client)({
      ticketKey: 'ACME-42',
      resourceClaims: [{ kind: 'named', value: 'unity-editor:main', mode: 'write' }],
    });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('Rival Bot');
    expect(text).toContain('unity-editor:main');
    expect((res.structuredContent as { claimConflict: boolean }).claimConflict).toBe(true);
  });

  it('reports an unresolvable ticket as a text error instead of throwing', async () => {
    stub([{ ok: false, status: 404, text: '' }]);
    const res = await makeWorkStartHandler(client)({ ticketKey: 'ACME-999' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain('not found');
  });
});

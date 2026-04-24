/**
 * ORB-244 Phase B — end-to-end shape tests for the read-tool suite.
 *
 * Each tool gets one happy-path test that confirms it hits the
 * expected API endpoints in order and produces structured content
 * with the advertised keys. Error-path coverage lives in
 * `shared.test.ts` (key-resolution) + `orbit-client.test.ts` (HTTP
 * transport).
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { OrbitClient } from '../orbit-client.js';
import { makeGetProjectHandler } from './get-project.js';
import { makeListTicketsHandler } from './list-tickets.js';
import { makeGetTicketHandler } from './get-ticket.js';
import { makeMyTicketsHandler } from './my-tickets.js';
import { makeListMilestonesHandler, makeGetMilestoneHandler } from './milestones.js';
import { makeSearchHandler } from './search.js';
import { makeListDocSpacesHandler, makeGetDocHandler } from './docs.js';
import { makeGetTimerHandler } from './get-timer.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

function stub(responses: Array<{ ok?: boolean; status?: number; json?: unknown }>) {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    calls.push(url.toString());
    const r = responses.shift();
    if (!r) throw new Error(`unexpected extra fetch to ${url}`);
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      statusText: 'OK',
      json: async () => r.json ?? {},
      text: async () => '',
    } as unknown as Response;
  });
  return calls;
}

const client = new OrbitClient({ baseUrl: 'https://orbit.example.com', apiKey: 'orb_x' });

const PROJ = { id: 'p1', key: 'ACME', name: 'Acme', description: 'Customer portal', status: 'active' };

describe('orbit_get_project', () => {
  it('aggregates project + milestones + labels + members into structured content', async () => {
    const calls = stub([
      { json: PROJ },
      { json: [{ id: 'm1', name: 'v1', status: 'active', startDate: '2026-01-01', endDate: '2026-03-01' }] },
      { json: [{ id: 'l1', name: 'bug', color: '#f00' }] },
      { json: [{ userId: 'u1', fullName: 'Ada', email: 'ada@acme', roleName: 'developer' }] },
    ]);
    const res = await makeGetProjectHandler(client)({ projectKey: 'acme' });
    expect(calls).toHaveLength(4);
    expect(calls[1]).toContain('/projects/p1/milestones');
    expect(calls[2]).toContain('/projects/p1/labels');
    expect(calls[3]).toContain('/projects/p1/members');
    const sc = res.structuredContent as { milestones: unknown[]; labels: unknown[]; members: unknown[] };
    expect(sc.milestones).toHaveLength(1);
    expect(sc.labels).toHaveLength(1);
    expect(sc.members).toHaveLength(1);
  });
});

describe('orbit_list_tickets', () => {
  it('passes limit + statusCategory to the API', async () => {
    const calls = stub([
      { json: PROJ },
      { json: { items: [], nextCursor: null } },
    ]);
    await makeListTicketsHandler(client)({ projectKey: 'ACME', statusCategory: 'in_progress', limit: 10 });
    expect(calls[1]).toContain('/projects/p1/tickets?');
    expect(calls[1]).toContain('statusCategory=in_progress');
    expect(calls[1]).toContain('limit=10');
  });

  it('resolves milestone name → milestoneId query param', async () => {
    const calls = stub([
      { json: PROJ },
      { json: [{ id: 'm1', name: 'v1' }, { id: 'm2', name: 'v2' }] },
      { json: { items: [], nextCursor: null } },
    ]);
    await makeListTicketsHandler(client)({ projectKey: 'ACME', milestone: 'v2' });
    expect(calls[2]).toContain('milestoneId=m2');
  });

  it('throws when the milestone name does not exist', async () => {
    stub([
      { json: PROJ },
      { json: [{ id: 'm1', name: 'v1' }] },
    ]);
    await expect(
      makeListTicketsHandler(client)({ projectKey: 'ACME', milestone: 'ghost' })
    ).rejects.toThrow(/Milestone "ghost" not found/);
  });
});

describe('orbit_get_ticket', () => {
  it('fetches comments + checklists, skips git when count is 0', async () => {
    const calls = stub([
      { json: PROJ },
      { json: { id: 't1', projectId: 'p1', ticketKey: 'ACME-5', title: 'Bug', status: 'TODO', statusName: 'To Do', type: 'bug', priority: 'normal', gitActivityCount: 0 } },
      { json: [] }, // comments
      { json: [] }, // checklists
    ]);
    await makeGetTicketHandler(client)({ ticketKey: 'ACME-5' });
    // Calls: by-key project, by-key ticket, comments, checklists (no git).
    expect(calls).toHaveLength(4);
    expect(calls.some((c) => c.includes('/git-activity'))).toBe(false);
  });

  it('fetches git activity when gitActivityCount > 0', async () => {
    const calls = stub([
      { json: PROJ },
      { json: { id: 't1', projectId: 'p1', ticketKey: 'ACME-6', title: 'Feature', status: 'IN_PROGRESS', gitActivityCount: 2 } },
      { json: [] },
      { json: [] },
      { json: [{ type: 'pr', title: 'fix', state: 'open', externalId: '1', authorName: 'x', createdAt: 'now', url: 'x' }] },
    ]);
    await makeGetTicketHandler(client)({ ticketKey: 'ACME-6' });
    expect(calls.some((c) => c.includes('/git-activity'))).toBe(true);
  });
});

describe('orbit_my_tickets', () => {
  it('defaults to TODO,IN_PROGRESS,IN_REVIEW when no category is given', async () => {
    const calls = stub([{ json: { items: [], nextCursor: null } }]);
    await makeMyTicketsHandler(client)({});
    expect(calls[0]).toContain('statuses=TODO%2CIN_PROGRESS%2CIN_REVIEW');
  });

  it('maps category → legacy status for the API', async () => {
    const calls = stub([{ json: { items: [], nextCursor: null } }]);
    await makeMyTicketsHandler(client)({ statusCategory: 'done' });
    expect(calls[0]).toContain('statuses=DONE');
  });
});

describe('milestone tools', () => {
  it('list: returns structured milestones array', async () => {
    stub([
      { json: PROJ },
      { json: [{ id: 'm1', name: 'v1', status: 'active', startDate: null, endDate: null, isPrivate: false }] },
    ]);
    const res = await makeListMilestonesHandler(client)({ projectKey: 'ACME' });
    const sc = res.structuredContent as { milestones: Array<{ name: string }> };
    expect(sc.milestones[0].name).toBe('v1');
  });

  it('get: pulls progress alongside metadata', async () => {
    const calls = stub([
      { json: PROJ },
      { json: [{ id: 'm1', name: 'v1', status: 'active', startDate: null, endDate: null, isPrivate: false, description: null }] },
      { json: { total: 10, done: 5, inProgress: 3, todo: 2, percentDone: 50, loggedMinutes: 1200, estimatedMinutes: 2400 } },
    ]);
    const res = await makeGetMilestoneHandler(client)({ projectKey: 'ACME', milestone: 'v1' });
    expect(calls[2]).toContain('/projects/p1/milestones/m1/progress');
    const sc = res.structuredContent as { progress: { percentDone: number } };
    expect(sc.progress.percentDone).toBe(50);
  });
});

describe('orbit_search', () => {
  it('includes projectId when projectKey filter is set', async () => {
    const calls = stub([
      { json: PROJ },
      { json: { items: [], total: 0 } },
    ]);
    await makeSearchHandler(client)({ query: 'foo', projectKey: 'ACME' });
    expect(calls[1]).toContain('projectId=p1');
  });

  it('renders multi-type hit snippets in text output', async () => {
    stub([
      {
        json: {
          items: [
            { type: 'ticket', id: 't1', title: 'Bug', snippet: '…login fails…', rank: 1, ticketKey: 'ACME-1' },
            { type: 'doc', id: 'd1', title: 'Runbook', snippet: '…restart…', rank: 0.5 },
          ],
          total: 2,
        },
      },
    ]);
    const res = await makeSearchHandler(client)({ query: 'login' });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('[TICKET ACME-1]');
    expect(text).toContain('[DOC');
  });
});

describe('doc tools', () => {
  it('list: renders project-scoped vs workspace-wide scope label', async () => {
    stub([{ json: [
      { id: 's1', name: 'Team', description: null, projectId: 'p1', projectName: 'Acme' },
      { id: 's2', name: 'Global', description: null, projectId: null, projectName: null },
    ] }]);
    const res = await makeListDocSpacesHandler(client)();
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('project Acme');
    expect(text).toContain('workspace-wide');
  });

  it('get: fetches doc + backlinks in parallel, surfaces body', async () => {
    stub([
      { json: { id: 'd1', spaceId: 's1', title: 'Runbook', body: '# Restart\n\n1. Kill…', parentDocId: null, visibility: 'workspace', icon: null, updatedAt: 'now' } },
      { json: [{ sourceId: 't1', sourceType: 'ticket', sourceTitle: 'Service down' }] },
    ]);
    const res = await makeGetDocHandler(client)({ docId: '00000000-0000-0000-0000-000000000001' });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('# Runbook');
    expect(text).toContain('1. Kill');
  });
});

describe('orbit_get_timer', () => {
  it('returns null when no timer is running', async () => {
    stub([{ json: { timer: null } }]);
    const res = await makeGetTimerHandler(client)();
    expect(res.structuredContent).toEqual({ timer: null });
  });

  it('computes totalSeconds including elapsed time since startedAt', async () => {
    const startedAt = new Date(Date.now() - 120_000).toISOString(); // 2 min ago
    stub([{ json: { timer: { id: 'tm1', ticketId: 't1', ticketKey: 'ACME-1', ticketTitle: 'Bug', startedAt, pausedAt: null, accumulatedSeconds: 300 } } }]);
    const res = await makeGetTimerHandler(client)();
    const sc = res.structuredContent as { timer: { totalSeconds: number; paused: boolean } };
    // 300 accumulated + ~120 elapsed. Allow ±5s for test timing jitter.
    expect(sc.timer.totalSeconds).toBeGreaterThanOrEqual(418);
    expect(sc.timer.totalSeconds).toBeLessThanOrEqual(425);
    expect(sc.timer.paused).toBe(false);
  });
});

/**
 * ORB-244 Phase B — end-to-end shape tests for the read-tool suite.
 *
 * Each tool gets one happy-path test that confirms it hits the
 * expected API endpoints in order and produces structured content
 * with the advertised keys. The fixtures below use the REAL shapes
 * from `@orbit/shared-schema` — if a schema drift lands, these tests
 * break, which is exactly what we want.
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
      // `'json' in r` so an explicit `json: null` preserves null;
      // `r.json ?? {}` would collapse null → {} and hide nullable
      // endpoints (e.g. GET /time/timer returns the row or null).
      json: async () => ('json' in r ? r.json : {}),
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
      // Members endpoint response: nested user + role objects per the real schema.
      { json: [{ userId: 'u1', projectId: 'p1', roleId: 'r1',
        user: { id: 'u1', email: 'ada@acme', fullName: 'Ada', avatarUrl: null },
        role: { id: 'r1', name: 'developer' } }] },
    ]);
    const res = await makeGetProjectHandler(client)({ projectKey: 'acme' });
    expect(calls).toHaveLength(4);
    expect(calls[1]).toContain('/projects/p1/milestones');
    expect(calls[2]).toContain('/projects/p1/labels');
    expect(calls[3]).toContain('/projects/p1/members');
    const sc = res.structuredContent as { members: Array<{ fullName: string; email: string; roleName: string }> };
    expect(sc.members[0]).toEqual({
      userId: 'u1', fullName: 'Ada', email: 'ada@acme', roleName: 'developer',
    });
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

  it('resolves assigneeEmail via the nested members shape', async () => {
    const calls = stub([
      { json: PROJ },
      {
        json: [
          { userId: 'u1', user: { email: 'alice@acme' } },
          { userId: 'u2', user: { email: 'bob@acme' } },
        ],
      },
      { json: { items: [], nextCursor: null } },
    ]);
    await makeListTicketsHandler(client)({ projectKey: 'ACME', assigneeEmail: 'bob@acme' });
    expect(calls[2]).toContain('assigneeId=u2');
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
  it('fetches cursor-paged comments + checklists, skips git when count is 0', async () => {
    const calls = stub([
      { json: PROJ },
      { json: { id: 't1', projectId: 'p1', ticketKey: 'ACME-5', title: 'Bug', status: 'TODO', statusName: 'To Do', type: 'bug', priority: 'normal', gitActivityCount: 0 } },
      // Comments endpoint: cursor-paged {items, nextCursor}
      { json: { items: [], nextCursor: null } },
      { json: [] }, // checklists — flat array
    ]);
    await makeGetTicketHandler(client)({ ticketKey: 'ACME-5' });
    // Calls: by-key project, by-key ticket, comments, checklists (no git).
    expect(calls).toHaveLength(4);
    expect(calls[2]).toContain('/tickets/t1/comments?limit=');
    expect(calls.some((c) => c.includes('/git-activity'))).toBe(false);
  });

  it('surfaces hasMoreComments + content field from cursor page', async () => {
    stub([
      { json: PROJ },
      { json: { id: 't1', projectId: 'p1', ticketKey: 'ACME-6', title: 'X', status: 'TODO', gitActivityCount: 0 } },
      {
        json: {
          items: [{ id: 'c1', ticketId: 't1', userId: 'u1', content: 'first thought', isInternal: false, createdAt: 'now', userName: 'Ada' }],
          nextCursor: 'next-page-token',
        },
      },
      { json: [] },
    ]);
    const res = await makeGetTicketHandler(client)({ ticketKey: 'ACME-6' });
    const sc = res.structuredContent as {
      comments: Array<{ body: string; author: string }>;
      commentsHasMore: boolean;
    };
    expect(sc.comments[0]).toEqual({
      body: 'first thought',
      author: 'Ada',
      createdAt: 'now',
      editedAt: null,
      isInternal: false,
    });
    expect(sc.commentsHasMore).toBe(true);
  });

  it('fetches git activity when gitActivityCount > 0', async () => {
    const calls = stub([
      { json: PROJ },
      { json: { id: 't1', projectId: 'p1', ticketKey: 'ACME-7', title: 'Feature', status: 'IN_PROGRESS', gitActivityCount: 2 } },
      { json: { items: [], nextCursor: null } },
      { json: [] },
      { json: [{ type: 'pr', title: 'fix', state: 'open', externalId: '1', authorName: 'x', createdAt: 'now', url: 'x' }] },
    ]);
    await makeGetTicketHandler(client)({ ticketKey: 'ACME-7' });
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
      { json: [{ id: 'm1', projectId: 'p1', name: 'v1', status: 'active', startDate: null, endDate: null, isPrivate: false }] },
    ]);
    const res = await makeListMilestonesHandler(client)({ projectKey: 'ACME' });
    const sc = res.structuredContent as { milestones: Array<{ name: string }> };
    expect(sc.milestones[0].name).toBe('v1');
  });

  it('get: maps byStatus into percent + per-category counts', async () => {
    const calls = stub([
      { json: PROJ },
      { json: [{ id: 'm1', projectId: 'p1', name: 'v1', status: 'active', startDate: null, endDate: null, isPrivate: false }] },
      { json: { total: 10, byStatus: { DONE: 5, IN_PROGRESS: 3, TODO: 2 } } },
    ]);
    const res = await makeGetMilestoneHandler(client)({ projectKey: 'ACME', milestone: 'v1' });
    expect(calls[2]).toContain('/projects/p1/milestones/m1/progress');
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('50% done (5/10)');
    expect(text).toContain('to do: 2 · in progress: 3');
  });
});

describe('orbit_search', () => {
  it('includes projectId when projectKey filter is set', async () => {
    const calls = stub([
      { json: PROJ },
      { json: { items: [], nextCursor: null, total: 0 } },
    ]);
    await makeSearchHandler(client)({ query: 'foo', projectKey: 'ACME' });
    expect(calls[1]).toContain('projectId=p1');
  });

  it('renders real SearchResult shape with excerpt field + hasMore flag', async () => {
    stub([
      {
        json: {
          items: [
            { type: 'ticket', id: 't1', title: 'Bug', excerpt: '…login fails…', projectId: 'p1', projectName: 'Acme', spaceId: null, spaceName: null, url: '/projects/acme/tickets/ACME-1', ticketKey: 'ACME-1', rank: 1 },
            { type: 'doc', id: 'd1', title: 'Runbook', excerpt: '…restart…', projectId: null, projectName: null, spaceId: 's1', spaceName: 'Ops', url: '/spaces/ops/docs/runbook', rank: 0.5 },
          ],
          nextCursor: 'more',
          total: 42,
        },
      },
    ]);
    const res = await makeSearchHandler(client)({ query: 'login' });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('[TICKET ACME-1 · Acme]');
    expect(text).toContain('login fails');
    const sc = res.structuredContent as { total: number; hasMore: boolean };
    expect(sc.total).toBe(42);
    expect(sc.hasMore).toBe(true);
  });
});

describe('doc tools', () => {
  it('list: uses DocSpace.type to label scope, not a joined projectName', async () => {
    stub([{ json: [
      { id: 's1', name: 'Team', slug: 'team', type: 'project', description: null, icon: null, projectId: 'p1', isPublic: false },
      { id: 's2', name: 'Global', slug: 'global', type: 'global', description: null, icon: null, projectId: null, isPublic: true },
    ] }]);
    const res = await makeListDocSpacesHandler(client)();
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('project-scoped');
    expect(text).toContain('workspace-wide');
  });

  it('get: reads doc.content (not body) + backlink.sourceDocTitle', async () => {
    stub([
      { json: { id: 'd1', spaceId: 's1', parentDocId: null, title: 'Runbook', content: '# Restart\n\n1. Kill the process.', slug: 'runbook', visibility: 'workspace', sortOrder: 0, icon: null, updatedAt: 'now' } },
      { json: [{ type: 'ticket', id: 't1', label: null, sourceDocId: 'd2', sourceDocTitle: 'Incident playbook', sourceSpaceId: 's1' }] },
    ]);
    const res = await makeGetDocHandler(client)({ docId: '00000000-0000-0000-0000-000000000001' });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('# Runbook');
    expect(text).toContain('1. Kill');
    expect(text).toContain('Incident playbook');
  });
});

describe('orbit_get_timer', () => {
  it('returns null when the endpoint returns null directly (not wrapped)', async () => {
    stub([{ json: null }]);
    const res = await makeGetTimerHandler(client)();
    expect(res.structuredContent).toEqual({ timer: null });
  });

  it('computes totalSeconds including elapsed time since startedAt', async () => {
    const startedAt = new Date(Date.now() - 120_000).toISOString(); // 2 min ago
    stub([{ json: { id: 'tm1', userId: 'u1', ticketId: 't1', ticketTitle: 'Bug', startedAt, pausedAt: null, accumulatedSeconds: 300, description: 'debug' } }]);
    const res = await makeGetTimerHandler(client)();
    const sc = res.structuredContent as { timer: { totalSeconds: number; paused: boolean; ticketTitle: string | null } };
    // 300 accumulated + ~120 elapsed. Allow ±5s for test timing jitter.
    expect(sc.timer.totalSeconds).toBeGreaterThanOrEqual(418);
    expect(sc.timer.totalSeconds).toBeLessThanOrEqual(425);
    expect(sc.timer.paused).toBe(false);
    expect(sc.timer.ticketTitle).toBe('Bug');
  });
});

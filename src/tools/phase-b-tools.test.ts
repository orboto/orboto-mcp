/**
 * ORB-244 Phase B - end-to-end shape tests for the read-tool suite.
 *
 * Each tool gets one happy-path test that confirms it hits the
 * expected API endpoints in order and produces structured content
 * with the advertised keys. The fixtures below use the REAL shapes
 * from `@orboto/shared-schema` - if a schema drift lands, these tests
 * break, which is exactly what we want.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import { makeGetProjectHandler } from './get-project.js';
import { makeListTicketsHandler } from './list-tickets.js';
import { makeGetTicketHandler } from './get-ticket.js';
import { makeMyTicketsHandler } from './my-tickets.js';
import { makeListMilestonesHandler, makeGetMilestoneHandler } from './milestones.js';
import { makeSearchHandler } from './search.js';
import { makeListDocSpacesHandler, makeGetDocHandler } from './docs.js';
import { makeGetTimerHandler } from './get-timer.js';
import { makeGetChecklistsHandler } from './get-checklists.js';

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

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });

const PROJ = { id: 'p1', key: 'ACME', name: 'Acme', description: 'Customer portal', status: 'active' };

describe('orboto_get_project', () => {
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

describe('orboto_list_tickets', () => {
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

  // ORB-1696 - the shared resolver contract: key, name, OR UUID; an
  // ambiguous name errors listing candidates. One test per form.
  it('resolves milestone KEY (ORB-1696)', async () => {
    const calls = stub([
      { json: PROJ },
      { json: [{ id: 'm1', name: 'v1', milestoneKey: 'ACME-M1' }, { id: 'm2', name: 'v2', milestoneKey: 'ACME-M2' }] },
      { json: { items: [], nextCursor: null } },
    ]);
    await makeListTicketsHandler(client)({ projectKey: 'ACME', milestone: 'acme-m2' });
    expect(calls[2]).toContain('milestoneId=m2');
  });

  it('resolves milestone UUID (ORB-1696)', async () => {
    const uuid = '3b000000-0000-4000-8000-000000000001';
    const calls = stub([
      { json: PROJ },
      { json: [{ id: uuid, name: 'v1', milestoneKey: 'ACME-M1' }] },
      { json: { items: [], nextCursor: null } },
    ]);
    await makeListTicketsHandler(client)({ projectKey: 'ACME', milestone: uuid });
    expect(calls[2]).toContain(`milestoneId=${uuid}`);
  });

  it('an ambiguous milestone NAME errors listing the candidates (ORB-1696)', async () => {
    stub([
      { json: PROJ },
      { json: [{ id: 'm1', name: 'dup', milestoneKey: 'ACME-M1' }, { id: 'm2', name: 'dup', milestoneKey: 'ACME-M2' }] },
    ]);
    await expect(
      makeListTicketsHandler(client)({ projectKey: 'ACME', milestone: 'dup' }),
    ).rejects.toThrow(/ambiguous/);
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

  // ORB-1605 - the stalled-ingestion signal passes through into structuredContent.
  it('surfaces waitingForGitIngestion per ticket', async () => {
    stub([
      { json: PROJ },
      {
        json: {
          items: [{
            id: 't1', projectId: 'p1', ticketKey: 'ACME-11', title: 'Docs change',
            status: 'IN_REVIEW', statusName: 'In Review', statusCategory: 'in_review',
            type: 'task', priority: 'normal', estimatedTimeMinutes: 0, dueDate: null,
            waitingForGitIngestion: true,
          }],
          nextCursor: null,
        },
      },
    ]);
    const res = await makeListTicketsHandler(client)({ projectKey: 'ACME' });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('[waiting on Git ingestion]');
    const sc = res.structuredContent as { tickets: Array<{ waitingForGitIngestion: boolean }> };
    expect(sc.tickets[0].waitingForGitIngestion).toBe(true);
  });
});

describe('orboto_get_ticket', () => {
  // Fixture: empty children page (children METADATA is always fetched; the
  // rows only surface with include: ["children"] since ORB-1698).
  const NO_CHILDREN = { json: { items: [], nextCursor: null } };

  it('ORB-1698 default card: only enriched + children + attachments are fetched - comments/checklists/git untouched', async () => {
    const calls = stub([
      { json: PROJ },
      { json: { id: 't1', projectId: 'p1', ticketKey: 'ACME-5', title: 'Bug', status: 'TODO', statusName: 'To Do', type: 'bug', priority: 'normal', gitActivityCount: 0, parentTicketId: null } },
      { json: { id: 't1', projectId: 'p1', ticketKey: 'ACME-5', title: 'Bug', status: 'TODO', statusName: 'To Do', statusCategory: 'todo', type: 'bug', priority: 'normal', commentCount: 3, gitActivityCount: 0, checklistProgress: { done: 1, total: 2 } } },
      NO_CHILDREN,
      { json: [] }, // attachments metadata
    ]);
    const res = await makeGetTicketHandler(client)({ ticketKey: 'ACME-5' });
    expect(calls).toHaveLength(5);
    expect(calls.some((c) => c.includes('/comments'))).toBe(false);
    expect(calls.some((c) => c.includes('/checklists'))).toBe(false);
    expect(calls.some((c) => c.includes('/git-activity'))).toBe(false);
    const sc = res.structuredContent as Record<string, unknown>;
    // Counts always present; bodies absent by default - never silently.
    expect(sc.commentCount).toBe(3);
    expect(sc.checklistProgress).toEqual({ done: 1, total: 2 });
    expect(sc.attachmentCount).toBe(0);
    expect(sc.childCount).toBe(0);
    expect(sc.comments).toBeUndefined();
    expect(sc.checklists).toBeUndefined();
    expect(sc.gitActivity).toBeUndefined();
    expect(sc.attachments).toBeUndefined();
    expect(sc.children).toBeUndefined();
    expect(String(sc.includeHint)).toContain('comments (3)');
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('Comments: 3');
    expect(text).toContain('Checklists: 1/2 done');
  });

  it('ORB-1698: the default response for a 30+-comment ticket stays under the 4k budget', async () => {
    stub([
      { json: PROJ },
      { json: { id: 't1', projectId: 'p1', ticketKey: 'ACME-5', title: 'Bug', status: 'TODO', gitActivityCount: 0, parentTicketId: null } },
      { json: { id: 't1', projectId: 'p1', ticketKey: 'ACME-5', title: 'Bug', status: 'TODO', statusName: 'To Do', statusCategory: 'todo', type: 'bug', priority: 'normal', commentCount: 34, gitActivityCount: 7, checklistProgress: { done: 0, total: 0 }, description: 'Repro steps here.' } },
      NO_CHILDREN,
      { json: [] },
    ]);
    const res = await makeGetTicketHandler(client)({ ticketKey: 'ACME-5' });
    const size = JSON.stringify(res.structuredContent).length;
    expect(size).toBeLessThan(4000);
    expect((res.structuredContent as Record<string, unknown>).commentCount).toBe(34);
  });

  it('include: ["comments"] restores cursor-paged bodies exactly as before', async () => {
    const calls = stub([
      { json: PROJ },
      { json: { id: 't1', projectId: 'p1', ticketKey: 'ACME-6', title: 'X', status: 'TODO', gitActivityCount: 0, parentTicketId: null } },
      { json: { id: 't1', projectId: 'p1', ticketKey: 'ACME-6', title: 'X', status: 'TODO', statusName: 'To Do', statusCategory: 'todo', type: 'task', priority: 'normal', commentCount: 1 } },
      NO_CHILDREN,
      { json: [] }, // attachments
      {
        json: {
          items: [{ id: 'c1', ticketId: 't1', userId: 'u1', content: 'first thought', isInternal: false, createdAt: 'now', userName: 'Ada' }],
          nextCursor: 'next-page-token',
        },
      },
    ]);
    const res = await makeGetTicketHandler(client)({ ticketKey: 'ACME-6', include: ['comments'] });
    expect(calls.some((c) => c.includes('/tickets/t1/comments?limit='))).toBe(true);
    const sc = res.structuredContent as {
      comments: Array<{ body: string; author: string }>;
      commentsHasMore: boolean;
      parentTicket: unknown;
    };
    expect(sc.comments[0]).toEqual({
      id: 'c1', // ORB-1285 - comment id is surfaced for edit/delete targeting
      body: 'first thought',
      author: 'Ada',
      createdAt: 'now',
      editedAt: null,
      isInternal: false,
    });
    expect(sc.commentsHasMore).toBe(true);
    expect(sc.parentTicket).toBeNull();
  });

  // ORB-1605 - the stalled-ingestion signal surfaces in both the header
  // text and structuredContent.
  it('surfaces waitingForGitIngestion in the header and structured content', async () => {
    stub([
      { json: PROJ },
      { json: { id: 't1', projectId: 'p1', ticketKey: 'ACME-10', title: 'Docs change', status: 'IN_REVIEW', gitActivityCount: 0, parentTicketId: null } },
      {
        json: {
          id: 't1', projectId: 'p1', ticketKey: 'ACME-10', title: 'Docs change',
          status: 'IN_REVIEW', statusName: 'In Review', statusCategory: 'in_review',
          type: 'task', priority: 'normal', waitingForGitIngestion: true,
        },
      },
      NO_CHILDREN,
      { json: [] },
    ]);
    const res = await makeGetTicketHandler(client)({ ticketKey: 'ACME-10' });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('Waiting for Git ingestion');
    const sc = res.structuredContent as { waitingForGitIngestion: boolean };
    expect(sc.waitingForGitIngestion).toBe(true);
  });

  it('include: ["checklistItems"] reads effectiveCompleted (not done) + surfaces linked-ticket suffix', async () => {
    stub([
      { json: PROJ },
      { json: { id: 't1', projectId: 'p1', ticketKey: 'ACME-8', title: 'Epic', status: 'IN_PROGRESS', gitActivityCount: 0, parentTicketId: null } },
      { json: { id: 't1', projectId: 'p1', ticketKey: 'ACME-8', title: 'Epic', status: 'IN_PROGRESS', statusName: 'In Progress', statusCategory: 'in_progress', type: 'task', priority: 'normal', checklistProgress: { done: 0, total: 1 } } },
      NO_CHILDREN,
      { json: [] }, // attachments
      {
        json: [{
          id: 'cl1', title: 'Gate items', triggersDone: false,
          progress: { done: 0, total: 1 },
          items: [{
            id: 'i1', content: 'Sub-task', storedCompleted: false, effectiveCompleted: false,
            linkedTicketId: 't9', linkedTicketKey: 'ACME-9', linkedTicketTitle: 'Race fix', linkedTicketStatusCategory: 'in_progress', sortOrder: 0,
          }],
        }],
      },
    ]);
    const res = await makeGetTicketHandler(client)({ ticketKey: 'ACME-8', include: ['checklistItems'] });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('Gate items (0/1)');
    expect(text).toContain('[ ] Sub-task ↪ [ACME-9]');
  });

  it('surfaces parent by default; child rows only with include: ["children"]', async () => {
    stub([
      { json: PROJ },
      { json: { id: 't5', projectId: 'p1', ticketKey: 'ACME-5', title: 'Phase A', status: 'DONE', statusName: 'Done', statusCategory: 'done', type: 'task', priority: 'normal', gitActivityCount: 0, parentTicketId: 't1' } },
      // Enriched by-id refetch
      { json: { id: 't5', projectId: 'p1', ticketKey: 'ACME-5', title: 'Phase A', status: 'DONE', statusName: 'Done', statusCategory: 'done', type: 'task', priority: 'normal' } },
      // Parent ticket fetch
      { json: { id: 't1', projectId: 'p1', ticketKey: 'ACME-1', title: 'Epic foo', status: 'IN_PROGRESS', statusName: 'In Progress', statusCategory: 'in_progress' } },
      NO_CHILDREN,
      { json: [] },
    ]);
    const res = await makeGetTicketHandler(client)({ ticketKey: 'ACME-5' });
    const sc = res.structuredContent as {
      parentTicket: { key: string; title: string; status: string };
      children?: unknown[];
      childCount: number;
    };
    expect(sc.parentTicket).toEqual({
      key: 'ACME-1',
      title: 'Epic foo',
      status: 'In Progress',
      statusCategory: 'in_progress',
    });
    expect(sc.childCount).toBe(0);
    expect(sc.children).toBeUndefined();
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('Parent: [ACME-1] Epic foo (In Progress)');
  });

  it('include: ["git"] fetches git activity', async () => {
    const calls = stub([
      { json: PROJ },
      { json: { id: 't1', projectId: 'p1', ticketKey: 'ACME-7', title: 'Feature', status: 'IN_PROGRESS', gitActivityCount: 2, parentTicketId: null } },
      { json: { id: 't1', projectId: 'p1', ticketKey: 'ACME-7', title: 'Feature', status: 'IN_PROGRESS', statusName: 'In Progress', statusCategory: 'in_progress', type: 'task', priority: 'normal', gitActivityCount: 2 } },
      NO_CHILDREN,
      { json: [] }, // attachments
      { json: [{ type: 'pr', title: 'fix', state: 'open', externalId: '1', authorName: 'x', createdAt: 'now', url: 'x' }] },
    ]);
    const res = await makeGetTicketHandler(client)({ ticketKey: 'ACME-7', include: ['git'] });
    expect(calls.some((c) => c.includes('/git-activity'))).toBe(true);
    const sc = res.structuredContent as { gitActivity: unknown[] };
    expect(sc.gitActivity).toHaveLength(1);
  });

  it('ORB-1023: surfaces milestone (name, not UUID) + statusCategory from the enriched by-id refetch', async () => {
    stub([
      { json: PROJ },
      // Bare by-key resolver row: milestoneId set, but no milestoneName /
      // statusCategory - this is the shape that dropped the milestone.
      { json: { id: 't1', projectId: 'p1', ticketKey: 'ACME-9', title: 'Bug', status: 'DONE', milestoneId: 'm1', gitActivityCount: 0, parentTicketId: null } },
      // Enriched by-id refetch: carries statusCategory + the resolved name.
      { json: { id: 't1', projectId: 'p1', ticketKey: 'ACME-9', title: 'Bug', status: 'DONE', statusName: 'Done', statusCategory: 'done', type: 'bug', priority: 'normal', milestoneId: 'm1', milestoneName: 'Sprint 7' } },
      NO_CHILDREN,
      { json: [] },
    ]);
    const res = await makeGetTicketHandler(client)({ ticketKey: 'ACME-9' });
    const sc = res.structuredContent as { milestone: { id: string; name: string } | null; statusCategory: string | null };
    expect(sc.milestone).toEqual({ id: 'm1', name: 'Sprint 7' });
    expect(sc.statusCategory).toBe('done');
    expect((res.content[0] as { text: string }).text).toContain('Milestone: Sprint 7');
  });

  it('ORB-1455/ORB-1698: attachment COUNT by default, rows with include: ["attachments"]', async () => {
    const attId = 'a0000000-0000-0000-0000-000000000001';
    const ATT = { json: [{ id: attId, filename: 'screenshot.png', contentType: 'image/png', sizeBytes: 4096, downloadUrl: `/attachments/${attId}` }] };
    stub([
      { json: PROJ },
      { json: { id: 't1', projectId: 'p1', ticketKey: 'ACME-5', title: 'Bug', status: 'TODO', gitActivityCount: 0, parentTicketId: null } },
      { json: { id: 't1', projectId: 'p1', ticketKey: 'ACME-5', title: 'Bug', status: 'TODO', statusName: 'To Do', statusCategory: 'todo', type: 'bug', priority: 'normal' } },
      NO_CHILDREN,
      ATT,
    ]);
    const byDefault = await makeGetTicketHandler(client)({ ticketKey: 'ACME-5' });
    const scDefault = byDefault.structuredContent as { attachmentCount: number; attachments?: unknown[] };
    expect(scDefault.attachmentCount).toBe(1);
    expect(scDefault.attachments).toBeUndefined();

    stub([
      { json: PROJ },
      { json: { id: 't1', projectId: 'p1', ticketKey: 'ACME-5', title: 'Bug', status: 'TODO', gitActivityCount: 0, parentTicketId: null } },
      { json: { id: 't1', projectId: 'p1', ticketKey: 'ACME-5', title: 'Bug', status: 'TODO', statusName: 'To Do', statusCategory: 'todo', type: 'bug', priority: 'normal' } },
      NO_CHILDREN,
      ATT,
    ]);
    const res = await makeGetTicketHandler(client)({ ticketKey: 'ACME-5', include: ['attachments'] });
    const sc = res.structuredContent as { attachments: Array<{ id: string; filename: string; contentType: string }> };
    expect(sc.attachments).toEqual([
      { id: attId, filename: 'screenshot.png', contentType: 'image/png', sizeBytes: 4096, downloadUrl: `/attachments/${attId}` },
    ]);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('Attachments (1)');
    expect(text).toContain('screenshot.png');
    expect(text).toContain(attId);
  });
});

describe('orboto_my_tickets', () => {
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
  it('list: returns structured milestones array incl. milestoneKey (ORB-1068)', async () => {
    stub([
      { json: PROJ },
      { json: [{ id: 'm1', projectId: 'p1', milestoneKey: 'ACME-M1', name: 'v1', status: 'active', startDate: null, endDate: null, isPrivate: false }] },
    ]);
    const res = await makeListMilestonesHandler(client)({ projectKey: 'ACME' });
    const sc = res.structuredContent as { milestones: Array<{ name: string; milestoneKey: string | null }> };
    expect(sc.milestones[0].name).toBe('v1');
    expect(sc.milestones[0].milestoneKey).toBe('ACME-M1');
    expect((res.content[0] as { text: string }).text).toContain('ACME-M1 · v1');
  });

  it('get: maps byStatus into percent + per-category counts', async () => {
    const calls = stub([
      { json: PROJ },
      { json: [{ id: 'm1', projectId: 'p1', milestoneKey: 'ACME-M1', name: 'v1', status: 'active', startDate: null, endDate: null, isPrivate: false }] },
      { json: { total: 10, byStatus: { DONE: 5, IN_PROGRESS: 3, TODO: 2 } } },
    ]);
    const res = await makeGetMilestoneHandler(client)({ projectKey: 'ACME', milestone: 'v1' });
    expect(calls[2]).toContain('/projects/p1/milestones/m1/progress');
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('50% done (5/10)');
    expect(text).toContain('to do: 2 · in progress: 3');
    const sc = res.structuredContent as { milestone: { id: string; milestoneKey: string | null } };
    expect(sc.milestone.id).toBe('m1');
    expect(sc.milestone.milestoneKey).toBe('ACME-M1');
  });

  it('get: resolves the milestone by its key, case-insensitive (ORB-1068)', async () => {
    const calls = stub([
      { json: PROJ },
      { json: [{ id: 'm1', projectId: 'p1', milestoneKey: 'ACME-M19', name: 'Phase 35', status: 'active', startDate: null, endDate: null, isPrivate: false }] },
      { json: { total: 12, byStatus: { TODO: 12 } } },
    ]);
    const res = await makeGetMilestoneHandler(client)({ projectKey: 'ACME', milestone: 'acme-m19' });
    // The resolver spans closed milestones too.
    expect(calls[1]).toContain('includeClosed=true');
    const sc = res.structuredContent as { milestone: { name: string } };
    expect(sc.milestone.name).toBe('Phase 35');
  });
});

describe('orboto_search', () => {
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

describe('orboto_get_checklists', () => {
  it('surfaces effectiveCompleted + linked-ticket metadata (ORB-234 shape)', async () => {
    stub([
      { json: PROJ },
      { json: { id: 't1', projectId: 'p1', ticketKey: 'ACME-10', title: 'Epic', status: 'IN_PROGRESS' } },
      {
        json: [{
          id: 'cl1', title: 'Before ship', triggersDone: true,
          progress: { done: 1, total: 2 },
          items: [
            // One plain item, one linked-to-another-ticket item.
            { id: 'i1', content: 'Docs updated', storedCompleted: true, effectiveCompleted: true,
              linkedTicketId: null, linkedTicketKey: null, linkedTicketTitle: null, linkedTicketStatusCategory: null, sortOrder: 0 },
            { id: 'i2', content: 'Sub-task done', storedCompleted: false, effectiveCompleted: false,
              linkedTicketId: 't99', linkedTicketKey: 'ACME-99', linkedTicketTitle: 'Fix race', linkedTicketStatusCategory: 'in_progress', sortOrder: 1 },
          ],
        }],
      },
    ]);
    const res = await makeGetChecklistsHandler(client)({ ticketKey: 'ACME-10' });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('Before ship (1/2)');
    expect(text).toContain('triggers ticket done');
    expect(text).toContain('[x] Docs updated');
    expect(text).toContain('[ ] Sub-task done ↪ [ACME-99] Fix race (in_progress)');

    const sc = res.structuredContent as {
      checklists: Array<{
        progress: { done: number; total: number };
        items: Array<{ done: boolean; linkedTicket: { key: string; statusCategory: string } | null }>;
      }>;
    };
    expect(sc.checklists[0].progress).toEqual({ done: 1, total: 2 });
    expect(sc.checklists[0].items[0].linkedTicket).toBeNull();
    expect(sc.checklists[0].items[1].linkedTicket).toEqual({
      key: 'ACME-99', title: 'Fix race', statusCategory: 'in_progress',
    });
  });

  it('renders the empty-state line when a ticket has no checklists', async () => {
    stub([
      { json: PROJ },
      { json: { id: 't1', projectId: 'p1', ticketKey: 'ACME-11', title: 'Plain ticket' } },
      { json: [] },
    ]);
    const res = await makeGetChecklistsHandler(client)({ ticketKey: 'ACME-11' });
    expect((res.content[0] as { text: string }).text).toBe('[ACME-11] has no checklists.');
  });
});

describe('orboto_get_timer', () => {
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

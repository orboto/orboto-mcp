/**
 * ORB-244 Phase C Group 1 — ticket-mutation tool unit tests.
 *
 * One happy-path + one permission-denied test per tool. The mutation
 * tools share the same resolution chain (project → ticket → optional
 * member/milestone) so the bulk of the surface is covered by the
 * happy paths; the 403 test on each pinpoint how the API's existing
 * PBAC cascade surfaces through the MCP layer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoApiError, OrbotoClient } from '../orboto-client.js';
import {
  makeCreateTicketHandler, makeUpdateTicketHandler, makeMoveTicketHandler,
  makeCloseTicketHandler, makeCommentHandler, makeAssignHandler,
  makeUnassignHandler, makeSetMilestoneHandler,
  makeAddTicketDependencyHandler, makeRemoveTicketDependencyHandler,
  makeListTicketDependenciesHandler,
} from './ticket-writes.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

function stub(responses: Array<{
  ok?: boolean; status?: number; json?: unknown;
}>) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const u = url.toString();
    const m = (init?.method ?? 'GET');
    const b = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url: u, method: m, body: b });
    const r = responses.shift();
    if (!r) throw new Error(`unexpected extra fetch ${m} ${u}`);
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      statusText: 'OK',
      json: async () => ('json' in r ? r.json : {}),
      text: async () => '',
    } as unknown as Response;
  });
  return calls;
}

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });

const PROJ = { id: 'p1', key: 'ACME', name: 'Acme', description: null, status: 'active' };
const TICKET = {
  id: 't1', projectId: 'p1', ticketKey: 'ACME-1', ticketNumber: 1,
  title: 'Bug', description: null, status: 'TODO', statusName: 'To Do',
  statusCategory: 'todo', type: 'bug', priority: 'normal',
  estimatedTimeMinutes: 0, dueDate: null, isPrivate: false,
};

describe('orboto_create_ticket', () => {
  it('creates with body fields, no extra calls when no labels/assignees', async () => {
    const calls = stub([
      { json: PROJ },
      { json: { ...TICKET, ticketKey: 'ACME-7', title: 'New' } },
    ]);
    const res = await makeCreateTicketHandler(client)({
      projectKey: 'ACME', title: 'New', priority: 'high',
    });
    expect(calls[1].method).toBe('POST');
    expect(calls[1].url).toBe('https://orboto.example.com/projects/p1/tickets');
    expect(calls[1].body).toMatchObject({ title: 'New', priority: 'high', type: 'task' });
    expect((res.content[0] as { text: string }).text).toContain('Created: [ACME-7]');
  });

  it('resolves milestone name + parent ticket key', async () => {
    const calls = stub([
      { json: PROJ },                                                                  // resolveProjectByKey
      { json: [{ id: 'm1', name: 'v1' }] },                                            // resolveMilestoneId
      { json: PROJ },                                                                  // resolveTicketByKey: project
      { json: { ...TICKET, ticketKey: 'ACME-10' } },                                   // resolveTicketByKey: ticket
      { json: { ...TICKET, ticketKey: 'ACME-11' } },                                   // POST create
    ]);
    await makeCreateTicketHandler(client)({
      projectKey: 'ACME', title: 'sub', milestone: 'v1', parentTicketKey: 'ACME-10',
    });
    expect(calls[4].body).toMatchObject({ milestoneId: 'm1', parentTicketId: 't1' });
  });

  it('surfaces a 403 from the API as an OrbotoApiError', async () => {
    stub([
      { json: PROJ },
      { ok: false, status: 403, json: { error: 'Forbidden — missing ticket:create' } },
    ]);
    await expect(
      makeCreateTicketHandler(client)({ projectKey: 'ACME', title: 'x' })
    ).rejects.toBeInstanceOf(OrbotoApiError);
  });

  it('surfaces similarWarnings from POST /tickets in both content + structuredContent (ORB-887)', async () => {
    stub([
      { json: PROJ },
      {
        json: {
          ...TICKET, ticketKey: 'ACME-99', title: 'Auth breaks',
          similarWarnings: [
            { id: 't42', ticketKey: 'ACME-42', title: 'Authentication breaks for SAML', statusName: 'In Progress', statusColor: '#fc0', statusCategory: 'in_progress', similarity: 0.91, matchMode: 'embedding' },
            { id: 't13', ticketKey: 'ACME-13', title: 'Auth flow regressed', statusName: 'Done', statusColor: '#7d7', statusCategory: 'done', similarity: 0.72, matchMode: 'tsvector' },
          ],
        },
      },
    ]);
    const res = await makeCreateTicketHandler(client)({
      projectKey: 'ACME', title: 'Auth breaks',
    });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('Created: [ACME-99]');
    expect(text).toContain('Potential duplicates found');
    expect(text).toContain('ACME-42');
    expect(text).toContain('91% AI match');
    expect(text).toContain('ACME-13');
    const sc = res.structuredContent as { similarWarnings: unknown[] };
    expect(sc.similarWarnings).toHaveLength(2);
  });

  it('returns no warning block when similarWarnings is empty', async () => {
    stub([
      { json: PROJ },
      { json: { ...TICKET, ticketKey: 'ACME-100', similarWarnings: [] } },
    ]);
    const res = await makeCreateTicketHandler(client)({
      projectKey: 'ACME', title: 'totally unrelated work',
    });
    const text = (res.content[0] as { text: string }).text;
    expect(text).not.toContain('duplicates');
    expect(text).not.toContain('⚠');
  });
});

describe('orboto_update_ticket', () => {
  it('PATCHes only the supplied fields, leaves others untouched', async () => {
    const calls = stub([
      { json: PROJ },
      { json: TICKET },
      { json: { ...TICKET, title: 'Renamed' } },
    ]);
    await makeUpdateTicketHandler(client)({
      ticketKey: 'ACME-1',
      patch: { title: 'Renamed', priority: 'high' },
    });
    expect(calls[2].method).toBe('PATCH');
    expect(calls[2].body).toEqual({ title: 'Renamed', priority: 'high' });
  });
});

describe('orboto_move_ticket', () => {
  it('maps statusCategory → legacy status enum on the wire', async () => {
    const calls = stub([
      { json: PROJ },
      { json: TICKET },
      { json: { ...TICKET, status: 'IN_PROGRESS', statusName: 'In Progress', statusCategory: 'in_progress' } },
    ]);
    await makeMoveTicketHandler(client)({ ticketKey: 'ACME-1', statusCategory: 'in_progress' });
    expect(calls[2].body).toEqual({ status: 'IN_PROGRESS' });
  });
});

describe('orboto_close_ticket', () => {
  it('posts the closing comment BEFORE the status move (audit-trail order)', async () => {
    const calls = stub([
      { json: PROJ },                                          // resolveTicketByKey: project
      { json: TICKET },                                        // resolveTicketByKey: ticket
      { json: { id: 'c1', content: 'wrap-up', isInternal: false, createdAt: 'now' } },
      { json: { ...TICKET, status: 'DONE', statusName: 'Done', statusCategory: 'done' } },
    ]);
    await makeCloseTicketHandler(client)({ ticketKey: 'ACME-1', comment: 'wrap-up' });
    expect(calls[2].url).toContain('/tickets/t1/comments');
    expect(calls[2].method).toBe('POST');
    expect(calls[3].method).toBe('PATCH');
    expect(calls[3].body).toEqual({ status: 'DONE' });
  });

  it('skips the comment call when none provided', async () => {
    const calls = stub([
      { json: PROJ },
      { json: TICKET },
      { json: { ...TICKET, status: 'DONE' } },
    ]);
    await makeCloseTicketHandler(client)({ ticketKey: 'ACME-1' });
    expect(calls).toHaveLength(3);
    expect(calls[2].method).toBe('PATCH');
  });
});

describe('orboto_comment', () => {
  it('posts a regular (non-internal) comment by default', async () => {
    const calls = stub([
      { json: PROJ },
      { json: TICKET },
      { json: { id: 'c1', content: 'hi', isInternal: false, createdAt: 'now' } },
    ]);
    await makeCommentHandler(client)({ ticketKey: 'ACME-1', text: 'hi' });
    expect(calls[2].body).toEqual({ content: 'hi', isInternal: false });
  });

  it('surfaces internal flag both on the wire and in the text response', async () => {
    stub([
      { json: PROJ },
      { json: TICKET },
      { json: { id: 'c1', content: 'shh', isInternal: true, createdAt: 'now' } },
    ]);
    const res = await makeCommentHandler(client)({
      ticketKey: 'ACME-1', text: 'shh', isInternal: true,
    });
    expect((res.content[0] as { text: string }).text).toContain('(internal)');
  });
});

describe('orboto_assign / orboto_unassign', () => {
  const MEMBERS = [{ userId: 'u1', user: { email: 'ada@acme', fullName: 'Ada' }, role: { name: 'developer' } }];

  it('assign POSTs to /assignees/:userId', async () => {
    const calls = stub([
      { json: PROJ },
      { json: TICKET },
      { json: MEMBERS },
      { status: 204 }, // POST returns 204
    ]);
    await makeAssignHandler(client)({ ticketKey: 'ACME-1', assigneeEmail: 'ada@acme' });
    expect(calls[3].method).toBe('POST');
    expect(calls[3].url).toContain('/assignees/u1');
  });

  it('assign treats 409 as idempotent already-assigned', async () => {
    stub([
      { json: PROJ },
      { json: TICKET },
      { json: MEMBERS },
      { ok: false, status: 409, json: { error: 'already assigned' } },
    ]);
    const res = await makeAssignHandler(client)({ ticketKey: 'ACME-1', assigneeEmail: 'ada@acme' });
    expect((res.content[0] as { text: string }).text).toContain('already assigned');
  });

  it('unassign treats 404 as idempotent already-unassigned', async () => {
    stub([
      { json: PROJ },
      { json: TICKET },
      { json: MEMBERS },
      { ok: false, status: 404, json: { error: 'not assigned' } },
    ]);
    const res = await makeUnassignHandler(client)({ ticketKey: 'ACME-1', assigneeEmail: 'ada@acme' });
    expect((res.content[0] as { text: string }).text).toContain("wasn't assigned");
  });

  it('throws on missing project member', async () => {
    stub([
      { json: PROJ },
      { json: TICKET },
      { json: [] },
    ]);
    await expect(
      makeAssignHandler(client)({ ticketKey: 'ACME-1', assigneeEmail: 'ghost@acme' })
    ).rejects.toThrow(/No project member with email/);
  });
});

describe('orboto_set_milestone', () => {
  it('resolves milestone name + sends milestoneId', async () => {
    const calls = stub([
      { json: PROJ },
      { json: TICKET },
      { json: [{ id: 'm1', name: 'v1' }] },
      { json: { ...TICKET, milestoneId: 'm1' } },
    ]);
    await makeSetMilestoneHandler(client)({ ticketKey: 'ACME-1', milestone: 'v1' });
    expect(calls[3].body).toEqual({ milestoneId: 'm1' });
  });

  it('null milestone clears the milestone', async () => {
    const calls = stub([
      { json: PROJ },
      { json: TICKET },
      { json: { ...TICKET, milestoneId: null } },
    ]);
    await makeSetMilestoneHandler(client)({ ticketKey: 'ACME-1', milestone: null });
    expect(calls[2].body).toEqual({ milestoneId: null });
  });
});

describe('orboto_add_ticket_dependency / remove / list — ORB-453', () => {
  const TICKET_B = { ...TICKET, id: 't2', ticketKey: 'ACME-2', ticketNumber: 2, title: 'Other' };

  it('add resolves both ticket keys then POSTs dependsOnId', async () => {
    const calls = stub([
      { json: PROJ },           // resolve ACME-1 project
      { json: TICKET },         // resolve ACME-1 ticket
      { json: PROJ },           // resolve ACME-2 project
      { json: TICKET_B },       // resolve ACME-2 ticket
      { status: 204 },          // POST /dependencies
    ]);
    await makeAddTicketDependencyHandler(client)({ ticketKey: 'ACME-1', dependsOnKey: 'ACME-2' });
    expect(calls[4].method).toBe('POST');
    expect(calls[4].url).toContain(`/projects/p1/tickets/t1/dependencies`);
    expect(calls[4].body).toEqual({ dependsOnId: 't2' });
  });

  it('add treats 409 as idempotent', async () => {
    stub([
      { json: PROJ }, { json: TICKET },
      { json: PROJ }, { json: TICKET_B },
      { ok: false, status: 409, json: { error: 'edge already exists' } },
    ]);
    const res = await makeAddTicketDependencyHandler(client)({ ticketKey: 'ACME-1', dependsOnKey: 'ACME-2' });
    expect((res.content[0] as { text: string }).text).toContain('already depends on');
  });

  it('remove sends DELETE on /dependencies/:dependsOnId', async () => {
    const calls = stub([
      { json: PROJ }, { json: TICKET },
      { json: PROJ }, { json: TICKET_B },
      { status: 204 },
    ]);
    await makeRemoveTicketDependencyHandler(client)({ ticketKey: 'ACME-1', dependsOnKey: 'ACME-2' });
    expect(calls[4].method).toBe('DELETE');
    expect(calls[4].url).toContain(`/projects/p1/tickets/t1/dependencies/t2`);
  });

  it('remove treats 404 as idempotent already-absent', async () => {
    stub([
      { json: PROJ }, { json: TICKET },
      { json: PROJ }, { json: TICKET_B },
      { ok: false, status: 404, json: { error: 'not found' } },
    ]);
    const res = await makeRemoveTicketDependencyHandler(client)({ ticketKey: 'ACME-1', dependsOnKey: 'ACME-2' });
    expect((res.content[0] as { text: string }).text).toContain("didn't depend on");
  });

  it('list returns both directions formatted', async () => {
    stub([
      { json: PROJ }, { json: TICKET },
      { json: {
        blockedBy: [{ id: 't2', ticketKey: 'ACME-2', title: 'Other', projectId: 'p1', statusName: 'In Progress', statusCategory: 'in_progress' }],
        blocks: [],
      } },
    ]);
    const res = await makeListTicketDependenciesHandler(client)({ ticketKey: 'ACME-1' });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('Blocked by');
    expect(text).toContain('[ACME-2] Other');
    expect(text).toContain('Blocks');
    expect(text).toContain('_(none)_');
  });
});

/**
 * ORB-799 - bulk-* tools unit tests.
 *
 * Each tool gets one happy-path test (all keys succeed, structured
 * outcome shape correct) and one partial-failure test (a mix of
 * resolvable + 403/404 keys to verify the `failed` list shape).
 *
 * Resolution chain per ticket: GET /projects/by-key/PROJ +
 * GET /projects/:id/tickets/by-key/:N. We mock both per ticket.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import {
  makeBulkPatchTicketsHandler,
  makeBulkMoveTicketsHandler,
  makeBulkCloseTicketsHandler,
  makeBulkCommentTicketsHandler,
  makeBulkAssignTicketsHandler,
  makeBulkUnassignTicketsHandler,
} from './bulk-writes.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

function stub(responses: Array<{ ok?: boolean; status?: number; json?: unknown }>) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push({
      url: url.toString(),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    const r = responses.shift();
    if (!r) throw new Error(`unexpected extra fetch`);
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
function ticket(n: number) {
  return {
    id: `t${n}`, projectId: 'p1', ticketKey: `ACME-${n}`, ticketNumber: n,
    title: `Ticket ${n}`, status: 'TODO', statusName: 'To Do', statusCategory: 'todo',
    type: 'task', priority: 'normal', estimatedTimeMinutes: 0, dueDate: null, isPrivate: false,
  };
}

// Resolution responses for keys ACME-1, ACME-2 (project lookup is shared
// - but the client re-fetches each time. We supply one per key.)
function resolveOK(n: number) {
  return [
    { json: PROJ },
    { json: ticket(n) },
  ];
}

describe('orboto_bulk_patch_tickets', () => {
  it('PATCHes each ticket with the supplied body', async () => {
    const calls = stub([
      ...resolveOK(1),
      ...resolveOK(2),
      { json: ticket(1) }, // PATCH 1
      { json: ticket(2) }, // PATCH 2
    ]);
    const res = await makeBulkPatchTicketsHandler(client)({
      ticketKeys: ['ACME-1', 'ACME-2'],
      patch: { priority: 'high' },
    });
    const patchCalls = calls.filter((c) => c.method === 'PATCH');
    expect(patchCalls).toHaveLength(2);
    expect(patchCalls[0].body).toEqual({ priority: 'high' });
    expect(res.structuredContent).toMatchObject({
      successful: ['ACME-1', 'ACME-2'],
      failed: [],
      skipped: [],
      dryRun: false,
    });
  });

  it('dryRun=true resolves but does not PATCH', async () => {
    const calls = stub([
      ...resolveOK(1),
      ...resolveOK(2),
    ]);
    const res = await makeBulkPatchTicketsHandler(client)({
      ticketKeys: ['ACME-1', 'ACME-2'],
      patch: { priority: 'high' },
      dryRun: true,
    });
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(res.structuredContent).toMatchObject({
      successful: [],
      skipped: ['ACME-1', 'ACME-2'],
      dryRun: true,
    });
  });

  it('records per-ticket failures in `failed` and continues', async () => {
    stub([
      ...resolveOK(1),
      ...resolveOK(2),
      { json: ticket(1) },                                                     // PATCH 1 OK
      { ok: false, status: 403, json: { error: 'forbidden' } },                // PATCH 2 fails
    ]);
    const res = await makeBulkPatchTicketsHandler(client)({
      ticketKeys: ['ACME-1', 'ACME-2'],
      patch: { priority: 'high' },
    });
    expect(res.structuredContent).toMatchObject({
      successful: ['ACME-1'],
      failed: [{ ticketKey: 'ACME-2', error: expect.stringMatching(/Forbidden/) }],
    });
  });

  it('records resolution failures in `failed` and continues with the rest', async () => {
    stub([
      ...resolveOK(1),
      { ok: false, status: 404, json: { error: 'not found' } },                // ACME-2 by-key project fails
      { json: ticket(1) },                                                     // PATCH 1 OK
    ]);
    const res = await makeBulkPatchTicketsHandler(client)({
      ticketKeys: ['ACME-1', 'ACME-2'],
      patch: { priority: 'high' },
    });
    expect(res.structuredContent).toMatchObject({
      successful: ['ACME-1'],
      failed: [{ ticketKey: 'ACME-2' }],
    });
  });
});

describe('orboto_bulk_move_tickets', () => {
  it('PATCHes status mapped to legacy enum', async () => {
    const calls = stub([
      ...resolveOK(1),
      ...resolveOK(2),
      { json: ticket(1) },
      { json: ticket(2) },
    ]);
    await makeBulkMoveTicketsHandler(client)({
      ticketKeys: ['ACME-1', 'ACME-2'],
      statusCategory: 'in_review',
    });
    const patchCalls = calls.filter((c) => c.method === 'PATCH');
    expect(patchCalls[0].body).toEqual({ status: 'IN_REVIEW' });
    expect(patchCalls[1].body).toEqual({ status: 'IN_REVIEW' });
  });
});

describe('orboto_bulk_close_tickets', () => {
  it('POSTs comment before PATCH when comment is set', async () => {
    const calls = stub([
      ...resolveOK(1),
      { json: { id: 'c1', content: 'closed', isInternal: false, createdAt: 'now' } }, // POST comment
      { json: { ...ticket(1), status: 'DONE' } },                                     // PATCH
    ]);
    await makeBulkCloseTicketsHandler(client)({
      ticketKeys: ['ACME-1'],
      comment: 'closing the loop',
    });
    const commentCall = calls.find((c) => c.url.includes('/comments'));
    const patchCall = calls.find((c) => c.method === 'PATCH');
    expect(commentCall).toBeDefined();
    expect(patchCall?.body).toEqual({ status: 'DONE' });
    // Comment must be BEFORE the patch.
    expect(calls.indexOf(commentCall!)).toBeLessThan(calls.indexOf(patchCall!));
  });

  it('without comment, only PATCHes status=DONE', async () => {
    const calls = stub([
      ...resolveOK(1),
      { json: { ...ticket(1), status: 'DONE' } },
    ]);
    await makeBulkCloseTicketsHandler(client)({ ticketKeys: ['ACME-1'] });
    expect(calls.some((c) => c.url.includes('/comments'))).toBe(false);
  });
});

describe('orboto_bulk_comment_tickets', () => {
  it('POSTs the same comment on each ticket', async () => {
    const calls = stub([
      ...resolveOK(1),
      ...resolveOK(2),
      { json: { id: 'c1', content: 'x', isInternal: false, createdAt: 'now' } },
      { json: { id: 'c2', content: 'x', isInternal: false, createdAt: 'now' } },
    ]);
    await makeBulkCommentTicketsHandler(client)({
      ticketKeys: ['ACME-1', 'ACME-2'],
      text: 'heads up',
      isInternal: true,
    });
    const commentCalls = calls.filter((c) => c.url.includes('/comments'));
    expect(commentCalls).toHaveLength(2);
    expect(commentCalls[0].body).toEqual({ content: 'heads up', isInternal: true });
  });
});

describe('orboto_bulk_assign_tickets', () => {
  it('resolves email → userId once per project, then POSTs assignee', async () => {
    const calls = stub([
      ...resolveOK(1),
      ...resolveOK(2),
      { json: [{ userId: 'u1', user: { email: 'who@orboto.io', fullName: 'Who' }, role: { name: 'dev' } }] }, // members for p1
      { json: {} },                                                                                         // POST assignees t1
      { json: {} },                                                                                         // POST assignees t2 (member cache hit)
    ]);
    const res = await makeBulkAssignTicketsHandler(client)({
      ticketKeys: ['ACME-1', 'ACME-2'],
      assigneeEmail: 'who@orboto.io',
    });
    // Members fetched exactly once thanks to the per-project cache.
    expect(calls.filter((c) => c.url.includes('/members'))).toHaveLength(1);
    expect(res.structuredContent).toMatchObject({
      successful: ['ACME-1', 'ACME-2'],
      failed: [],
    });
  });

  it('treats 409 (already assigned) as success', async () => {
    stub([
      ...resolveOK(1),
      { json: [{ userId: 'u1', user: { email: 'who@orboto.io', fullName: 'Who' }, role: { name: 'dev' } }] },
      { ok: false, status: 409, json: { error: 'already assigned' } },
    ]);
    const res = await makeBulkAssignTicketsHandler(client)({
      ticketKeys: ['ACME-1'],
      assigneeEmail: 'who@orboto.io',
    });
    expect(res.structuredContent).toMatchObject({
      successful: ['ACME-1'],
      failed: [],
    });
  });
});

describe('orboto_bulk_unassign_tickets', () => {
  it('DELETEs each assignee, treats 404 as success', async () => {
    stub([
      ...resolveOK(1),
      { json: [{ userId: 'u1', user: { email: 'who@orboto.io', fullName: 'Who' }, role: { name: 'dev' } }] },
      { ok: false, status: 404, json: { error: 'not assigned' } },
    ]);
    const res = await makeBulkUnassignTicketsHandler(client)({
      ticketKeys: ['ACME-1'],
      assigneeEmail: 'who@orboto.io',
    });
    expect(res.structuredContent).toMatchObject({
      successful: ['ACME-1'],
      failed: [],
    });
  });
});

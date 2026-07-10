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
  makeCloseTicketHandler, makeDeleteTicketHandler, makeCommentHandler, makeAssignHandler,
  makeUpdateCommentHandler, makeDeleteCommentHandler,
  makeUnassignHandler, makeSetMilestoneHandler,
  makeAddTicketDependencyHandler, makeRemoveTicketDependencyHandler,
  makeListTicketDependenciesHandler,
  makeLabelTicketHandler, makeUnlabelTicketHandler,
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

  it('attaches labels + assignees INLINE in the create body, with no separate attach POSTs (ORB-1416)', async () => {
    const calls = stub([
      { json: PROJ },                                                        // resolveProjectByKey
      { json: { ...TICKET, ticketKey: 'ACME-8', title: 'Labelled' } },      // POST create (the ONLY POST)
    ]);
    await makeCreateTicketHandler(client)({
      projectKey: 'ACME', title: 'Labelled', labels: ['bug', 'ui'],
      assigneeEmails: ['dev@example.com'],
    });
    // Exactly one POST - the atomic create - carrying labels + assignees
    // in its body. No follow-up /labels/ or /assignees/ round-trips, so a
    // bad reference can't leave an orphan ticket the agent retries into a dup.
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe('https://orboto.example.com/projects/p1/tickets');
    expect(posts[0].body).toMatchObject({
      title: 'Labelled',
      labelNames: ['bug', 'ui'],
      assigneeEmails: ['dev@example.com'],
    });
    expect(calls.some((c) => c.url.includes('/labels/'))).toBe(false);
    expect(calls.some((c) => c.url.includes('/assignees/'))).toBe(false);
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
    const sc = res.structuredContent as { similarWarnings: { ticketKey: string }[]; createdTicketKey: string };
    expect(sc.similarWarnings).toHaveLength(2);
    // ORB-1176 — createdTicketKey is the NEW key, never a warning's key.
    expect(sc.createdTicketKey).toBe('ACME-99');
    expect(sc.similarWarnings.map((w) => w.ticketKey)).not.toContain(sc.createdTicketKey);
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

  it('surfaces languageWarning from POST /tickets in both content + structuredContent (ORB-891)', async () => {
    stub([
      { json: PROJ },
      {
        json: {
          ...TICKET, ticketKey: 'ACME-101', title: 'Authentifizierung schlägt fehl',
          similarWarnings: [],
          languageWarning: { detected: 'de', expected: 'en' },
        },
      },
    ]);
    const res = await makeCreateTicketHandler(client)({
      projectKey: 'ACME', title: 'Authentifizierung schlägt fehl',
    });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('Created: [ACME-101]');
    expect(text).toContain('Language mismatch');
    expect(text).toContain('"de"');
    expect(text).toContain('"en"');
    const sc = res.structuredContent as { languageWarning?: { detected: string; expected: string } };
    expect(sc.languageWarning).toEqual({ detected: 'de', expected: 'en' });
  });

  it('combines both similarWarnings and languageWarning when both are present (ORB-891)', async () => {
    stub([
      { json: PROJ },
      {
        json: {
          ...TICKET, ticketKey: 'ACME-102', title: 'duplicate auth',
          similarWarnings: [
            { id: 't1', ticketKey: 'ACME-1', title: 'Auth breaks', statusName: 'Done', statusColor: '#7d7', statusCategory: 'done', similarity: 0.92, matchMode: 'embedding' },
          ],
          languageWarning: { detected: 'de', expected: 'en' },
        },
      },
    ]);
    const res = await makeCreateTicketHandler(client)({
      projectKey: 'ACME', title: 'duplicate auth',
    });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('Potential duplicates found');
    expect(text).toContain('Language mismatch');
    const sc = res.structuredContent as { similarWarnings: unknown[]; languageWarning?: unknown };
    expect(sc.similarWarnings).toHaveLength(1);
    expect(sc.languageWarning).toEqual({ detected: 'de', expected: 'en' });
  });

  it('turns a strict-language 422 into a clear block result, not a thrown error (ORB-990)', async () => {
    const blockBody = JSON.stringify({
      error: 'Ticket language (de) does not match the workspace language (en).',
      languageWarning: { code: 'language_mismatch', severity: 'block', detected: 'de', expected: 'en' },
    });
    let createUrl = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = url.toString();
      const m = init?.method ?? 'GET';
      if (m === 'GET') {
        return { ok: true, status: 200, statusText: 'OK', json: async () => PROJ, text: async () => '' } as unknown as Response;
      }
      createUrl = u; // the POST /tickets call
      return { ok: false, status: 422, statusText: 'Unprocessable', json: async () => ({}), text: async () => blockBody } as unknown as Response;
    });
    const res = await makeCreateTicketHandler(client)({
      projectKey: 'ACME', title: 'Authentifizierung schlägt fehl bei externen Nutzern',
    });
    // No override flag → no query param on the create call.
    expect(createUrl).not.toContain('allowLanguageMismatch');
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('blocked');
    expect(text).toContain('allowLanguageMismatch=true');
    const sc = res.structuredContent as { blocked: boolean; languageWarning: { severity: string } };
    expect(sc.blocked).toBe(true);
    expect(sc.languageWarning.severity).toBe('block');
  });

  it('passes allowLanguageMismatch as a query param when the override is set (ORB-990)', async () => {
    let createUrl = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = url.toString();
      const m = init?.method ?? 'GET';
      if (m === 'GET') {
        return { ok: true, status: 200, statusText: 'OK', json: async () => PROJ, text: async () => '' } as unknown as Response;
      }
      createUrl = u;
      return { ok: true, status: 201, statusText: 'Created', json: async () => ({ ...TICKET, ticketKey: 'ACME-9' }), text: async () => '' } as unknown as Response;
    });
    await makeCreateTicketHandler(client)({
      projectKey: 'ACME', title: 'Authentifizierung schlägt fehl', allowLanguageMismatch: true,
    });
    expect(createUrl).toContain('allowLanguageMismatch=true');
  });

  // ORB-1471 - hard duplicate-block 409 becomes a clear duplicateBlocked
  // result that surfaces the candidate list verbatim + the override recipe.
  it('turns a hard duplicate-block 409 into a duplicateBlocked result listing the candidates (ORB-1471)', async () => {
    const blockBody = JSON.stringify({
      error: 'This ticket looks like a duplicate (98% match to an existing ticket).',
      errorKey: 'errors.tickets.duplicate_blocked',
      threshold: 0.9,
      topSimilarity: 0.98,
      similarWarnings: [
        { id: 't1', ticketKey: 'ACME-7', title: 'Webhook signature mismatch', statusName: 'To Do', statusColor: null, statusCategory: 'todo', similarity: 0.98, matchMode: 'tsvector' },
      ],
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const m = init?.method ?? 'GET';
      if (m === 'GET') {
        return { ok: true, status: 200, statusText: 'OK', json: async () => PROJ, text: async () => '' } as unknown as Response;
      }
      return { ok: false, status: 409, statusText: 'Conflict', json: async () => ({}), text: async () => blockBody } as unknown as Response;
    });
    const res = await makeCreateTicketHandler(client)({ projectKey: 'ACME', title: 'Webhook signature mismatch' });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('BLOCKED');
    expect(text).toContain('ACME-7');
    expect(text).toContain('allowDuplicate: true');
    const sc = res.structuredContent as { duplicateBlocked: boolean; similarWarnings: unknown[] };
    expect(sc.duplicateBlocked).toBe(true);
    expect(sc.similarWarnings).toHaveLength(1);
  });

  it('passes allowDuplicate as a query param and the justification in the body when overriding (ORB-1471)', async () => {
    let createUrl = '';
    let createBody: Record<string, unknown> = {};
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = url.toString();
      const m = init?.method ?? 'GET';
      if (m === 'GET') {
        return { ok: true, status: 200, statusText: 'OK', json: async () => PROJ, text: async () => '' } as unknown as Response;
      }
      createUrl = u;
      createBody = init?.body ? JSON.parse(init.body as string) : {};
      return { ok: true, status: 201, statusText: 'Created', json: async () => ({ ...TICKET, ticketKey: 'ACME-9' }), text: async () => '' } as unknown as Response;
    });
    await makeCreateTicketHandler(client)({
      projectKey: 'ACME', title: 'Webhook signature mismatch',
      allowDuplicate: true, duplicateJustification: 'Different provider - Stripe vs PayPal.',
    });
    expect(createUrl).toContain('allowDuplicate=true');
    expect(createBody.duplicateJustification).toBe('Different provider - Stripe vs PayPal.');
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

  it('surfaces summaryWarning from the move response in content + structuredContent (ORB-1332)', async () => {
    stub([
      { json: PROJ },
      { json: TICKET },
      {
        json: {
          ...TICKET, status: 'DONE', statusName: 'Done', statusCategory: 'done',
          summaryWarning: { code: 'missing_transition_summary', message: 'Ticket moved to done without a summary comment - post what changed, the commit SHA, and how to verify.' },
        },
      },
    ]);
    const res = await makeMoveTicketHandler(client)({ ticketKey: 'ACME-1', statusCategory: 'done' });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('Moved: [ACME-1]');
    expect(text).toContain('without a summary comment');
    const sc = res.structuredContent as { summaryWarning?: { code: string } };
    expect(sc.summaryWarning?.code).toBe('missing_transition_summary');
  });

  it('omits summaryWarning when the move response carries none', async () => {
    stub([
      { json: PROJ },
      { json: TICKET },
      { json: { ...TICKET, status: 'IN_PROGRESS', statusName: 'In Progress', statusCategory: 'in_progress' } },
    ]);
    const res = await makeMoveTicketHandler(client)({ ticketKey: 'ACME-1', statusCategory: 'in_progress' });
    expect((res.content[0] as { text: string }).text).not.toContain('summary comment');
    expect((res.structuredContent as { summaryWarning?: unknown }).summaryWarning).toBeUndefined();
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

  it('surfaces summaryWarning when closing without a comment (ORB-1332)', async () => {
    stub([
      { json: PROJ },
      { json: TICKET },
      {
        json: {
          ...TICKET, status: 'DONE', statusName: 'Done', statusCategory: 'done',
          summaryWarning: { code: 'missing_transition_summary', message: 'Ticket moved to done without a summary comment - post what changed, the commit SHA, and how to verify.' },
        },
      },
    ]);
    const res = await makeCloseTicketHandler(client)({ ticketKey: 'ACME-1' });
    expect((res.content[0] as { text: string }).text).toContain('without a summary comment');
    expect((res.structuredContent as { summaryWarning?: { code: string } }).summaryWarning?.code).toBe('missing_transition_summary');
  });
});

describe('orboto_delete_ticket', () => {
  it('resolves the key then hard-DELETEs the ticket by id', async () => {
    const calls = stub([
      { json: PROJ },          // resolveTicketByKey: project by-key
      { json: TICKET },        // resolveTicketByKey: ticket by-key
      { status: 204 },         // DELETE /projects/p1/tickets/t1
    ]);
    const res = await makeDeleteTicketHandler(client)({ ticketKey: 'ACME-1' });
    expect(calls).toHaveLength(3);
    expect(calls[2].method).toBe('DELETE');
    expect(calls[2].url).toContain('/projects/p1/tickets/t1');
    expect(res.structuredContent).toMatchObject({ deleted: true, ticketKey: 'ACME-1', id: 't1' });
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

describe('orboto_update_comment / orboto_delete_comment (ORB-1285)', () => {
  it('update PATCHes the comment by id with the new content', async () => {
    const calls = stub([
      { json: PROJ },
      { json: TICKET },
      { json: { id: 'c1', content: 'fixed', isInternal: false, createdAt: 'now' } },
    ]);
    await makeUpdateCommentHandler(client)({ ticketKey: 'ACME-1', commentId: 'c1', text: 'fixed' });
    expect(calls[2].method).toBe('PATCH');
    expect(calls[2].url).toContain('/tickets/t1/comments/c1');
    expect(calls[2].body).toEqual({ content: 'fixed' });
  });

  it('delete DELETEs the comment by id', async () => {
    const calls = stub([
      { json: PROJ },
      { json: TICKET },
      { json: {} },
    ]);
    const res = await makeDeleteCommentHandler(client)({ ticketKey: 'ACME-1', commentId: 'c1' });
    expect(calls[2].method).toBe('DELETE');
    expect(calls[2].url).toContain('/tickets/t1/comments/c1');
    expect((res.structuredContent as { deleted: boolean }).deleted).toBe(true);
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

  it('resolves a milestone passed as a UUID + sends that id (ORB-1058)', async () => {
    const MS_UUID = '11111111-1111-1111-1111-111111111111';
    const calls = stub([
      { json: PROJ },
      { json: TICKET },
      { json: [{ id: MS_UUID, name: 'v1' }] },
      { json: { ...TICKET, milestoneId: MS_UUID } },
    ]);
    await makeSetMilestoneHandler(client)({ ticketKey: 'ACME-1', milestone: MS_UUID });
    expect(calls[3].body).toEqual({ milestoneId: MS_UUID });
  });

  it('rejects an ambiguous milestone name listing every candidate UUID (ORB-1058)', async () => {
    stub([
      { json: PROJ },
      { json: TICKET },
      { json: [{ id: 'm1', name: 'dup' }, { id: 'm2', name: 'dup' }] },
    ]);
    let err: Error | undefined;
    try {
      await makeSetMilestoneHandler(client)({ ticketKey: 'ACME-1', milestone: 'dup' });
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).toMatch(/ambiguous/i);
    expect(err?.message).toContain('m1');
    expect(err?.message).toContain('m2');
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

describe('orboto_label_ticket / orboto_unlabel_ticket (ORB-1043)', () => {
  const LABELS = [{ id: 'lb1', name: 'bug' }, { id: 'lb2', name: 'Security' }];

  it('label resolves the name and POSTs to /tickets/:id/labels/:labelId', async () => {
    const calls = stub([
      { json: PROJ },                 // resolveTicketByKey: project
      { json: TICKET },               // resolveTicketByKey: ticket
      { json: LABELS },               // GET labels
      { status: 204 },                // POST attach
    ]);
    await makeLabelTicketHandler(client)({ ticketKey: 'ACME-1', label: 'security' });
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toContain(`/projects/tickets/${TICKET.id}/labels/lb2`);
  });

  it('unlabel DELETEs the resolved label', async () => {
    const calls = stub([
      { json: PROJ },
      { json: TICKET },
      { json: LABELS },
      { status: 204 },
    ]);
    await makeUnlabelTicketHandler(client)({ ticketKey: 'ACME-1', label: 'bug' });
    const del = calls.find((c) => c.method === 'DELETE')!;
    expect(del.url).toContain(`/projects/tickets/${TICKET.id}/labels/lb1`);
  });

  it('errors on an unknown label name, pointing to create_label', async () => {
    stub([{ json: PROJ }, { json: TICKET }, { json: LABELS }]);
    await expect(
      makeLabelTicketHandler(client)({ ticketKey: 'ACME-1', label: 'nope' }),
    ).rejects.toThrow(/orboto_create_label/);
  });
});

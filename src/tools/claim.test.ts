/**
 * ORB-799 — `orboto_claim` / `orboto_unclaim` unit tests.
 *
 * Covers the composite happy paths, the idempotent re-claim shortcut,
 * the `sole=true` destructive take-over, the `force=true` reopen-done
 * guard, and the `noTimer=true` skip. The timer-warning branch (where
 * a 409 surfaces from `/time/timer/start`) is exercised in the
 * dedicated test below.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoApiError, OrbotoClient } from '../orboto-client.js';
import { makeClaimHandler, makeUnclaimHandler } from './claim.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

function stub(responses: Array<{
  ok?: boolean; status?: number; json?: unknown;
}>) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push({
      url: url.toString(),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    const r = responses.shift();
    if (!r) throw new Error(`unexpected extra fetch ${init?.method ?? 'GET'} ${url}`);
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

const ME = { id: 'me1', email: 'agent-e@orboto.io', fullName: 'Agent E' };
const PROJ = { id: 'p1', key: 'ACME', name: 'Acme', description: null, status: 'active' };
const TICKET_TODO = {
  id: 't1', projectId: 'p1', ticketKey: 'ACME-1', ticketNumber: 1,
  title: 'Bug', description: null, status: 'TODO', statusName: 'To Do',
  statusCategory: 'todo', type: 'bug', priority: 'normal',
  estimatedTimeMinutes: 0, dueDate: null, isPrivate: false, assignees: [],
};

describe('orboto_claim', () => {
  it('happy path: assigns self + moves to in_progress + starts timer (no active timer)', async () => {
    const calls = stub([
      { json: ME },                                                            // /users/me
      { json: PROJ },                                                          // resolveTicketByKey: by-key project
      { json: TICKET_TODO },                                                   // resolveTicketByKey: ticket
      { json: {} },                                                            // POST assignees/me
      { json: { ...TICKET_TODO, status: 'IN_PROGRESS', statusName: 'In Progress', statusCategory: 'in_progress' } }, // PATCH status
      { json: null },                                                          // GET /time/timer (no active)
      { json: { id: 'tm1', ticketId: 't1', startedAt: '2026-05-14T16:00:00Z' } }, // POST timer/start
    ]);
    const res = await makeClaimHandler(client)({ ticketKey: 'ACME-1' });
    expect(calls[3]).toMatchObject({
      method: 'POST',
      url: 'https://orboto.example.com/projects/p1/tickets/t1/assignees/me1',
    });
    expect(calls[4]).toMatchObject({
      method: 'PATCH',
      url: 'https://orboto.example.com/projects/p1/tickets/t1',
      body: { status: 'IN_PROGRESS' },
    });
    expect(calls[6]).toMatchObject({
      method: 'POST',
      url: 'https://orboto.example.com/time/timer/start',
      body: { ticketId: 't1' },
    });
    expect(res.structuredContent).toMatchObject({
      ticketKey: 'ACME-1',
      timerStarted: true,
      timerWarning: null,
      noop: false,
    });
  });

  it('idempotent: skip assign POST + status PATCH when already-in-progress + already-assigned', async () => {
    const calls = stub([
      { json: ME },
      { json: PROJ },
      { json: {
        ...TICKET_TODO, status: 'IN_PROGRESS', statusName: 'In Progress', statusCategory: 'in_progress',
        assignees: [{ id: 'me1', email: 'agent-e@orboto.io', fullName: 'Agent E' }],
      } },
      { json: { ticketId: 't1' } }, // GET /time/timer — already on same ticket
    ]);
    const res = await makeClaimHandler(client)({ ticketKey: 'ACME-1' });
    // 4 calls total: /users/me, by-key project, by-key ticket, GET /time/timer.
    // No POST /assignees, no PATCH status, no POST /timer/start.
    expect(calls).toHaveLength(4);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(calls.some((c) => c.url.includes('/timer/start'))).toBe(false);
    expect(res.structuredContent).toMatchObject({
      ticketKey: 'ACME-1',
      noop: true,
    });
  });

  it('sole=true removes every other assignee before adding self', async () => {
    const calls = stub([
      { json: ME },
      { json: PROJ },
      { json: { ...TICKET_TODO, assignees: [
        { id: 'other1', email: 'a@x', fullName: 'A' },
        { id: 'other2', email: 'b@x', fullName: 'B' },
      ] } },
      { ok: true, status: 204 },                                               // DELETE other1
      { ok: true, status: 204 },                                               // DELETE other2
      { json: {} },                                                            // POST assignees/me
      { json: { ...TICKET_TODO, status: 'IN_PROGRESS', statusName: 'In Progress', statusCategory: 'in_progress' } },
      { json: null },                                                          // GET timer
      { json: {} },                                                            // POST timer/start
    ]);
    await makeClaimHandler(client)({ ticketKey: 'ACME-1', sole: true });
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(2);
    expect(calls[3].url).toContain('/assignees/other1');
    expect(calls[4].url).toContain('/assignees/other2');
  });

  it('refuses to claim a done ticket without force=true', async () => {
    stub([
      { json: ME },
      { json: PROJ },
      { json: { ...TICKET_TODO, status: 'DONE', statusName: 'Done', statusCategory: 'done' } },
    ]);
    await expect(
      makeClaimHandler(client)({ ticketKey: 'ACME-1' }),
    ).rejects.toThrow(/Refusing to claim/);
  });

  it('force=true claims a done ticket and re-opens to in_progress', async () => {
    const calls = stub([
      { json: ME },
      { json: PROJ },
      { json: { ...TICKET_TODO, status: 'DONE', statusName: 'Done', statusCategory: 'done' } },
      { json: {} },                                                            // POST assignees/me
      { json: { ...TICKET_TODO, status: 'IN_PROGRESS', statusName: 'In Progress', statusCategory: 'in_progress' } },
      { json: null },
      { json: {} },
    ]);
    await makeClaimHandler(client)({ ticketKey: 'ACME-1', force: true });
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ status: 'IN_PROGRESS' });
  });

  it('noTimer=true skips the timer interaction', async () => {
    const calls = stub([
      { json: ME },
      { json: PROJ },
      { json: TICKET_TODO },
      { json: {} },
      { json: { ...TICKET_TODO, status: 'IN_PROGRESS', statusName: 'In Progress', statusCategory: 'in_progress' } },
    ]);
    const res = await makeClaimHandler(client)({ ticketKey: 'ACME-1', noTimer: true });
    expect(calls.some((c) => c.url.includes('/timer'))).toBe(false);
    expect(res.structuredContent).toMatchObject({ timerStarted: false });
  });

  it('timer 409 → assign/status succeed, timerWarning surfaces', async () => {
    stub([
      { json: ME },
      { json: PROJ },
      { json: TICKET_TODO },
      { json: {} },
      { json: { ...TICKET_TODO, status: 'IN_PROGRESS', statusName: 'In Progress', statusCategory: 'in_progress' } },
      { json: null },                                                          // GET /time/timer — empty
      { ok: false, status: 409, json: { error: 'timer already running' } },    // POST /timer/start fails
    ]);
    const res = await makeClaimHandler(client)({ ticketKey: 'ACME-1' });
    expect(res.structuredContent).toMatchObject({
      ticketKey: 'ACME-1',
      timerStarted: false,
    });
    expect((res.structuredContent as { timerWarning: string }).timerWarning).toMatch(/timer is already running/i);
  });
});

describe('orboto_unclaim', () => {
  it('unassigns self + moves to todo', async () => {
    const calls = stub([
      { json: ME },
      { json: PROJ },
      { json: { ...TICKET_TODO, status: 'IN_PROGRESS', statusName: 'In Progress', statusCategory: 'in_progress' } },
      { ok: true, status: 204 },                                               // DELETE assignees/me
      { json: { ...TICKET_TODO, status: 'TODO', statusName: 'To Do', statusCategory: 'todo' } },
    ]);
    const res = await makeUnclaimHandler(client)({ ticketKey: 'ACME-1' });
    expect(calls[3]).toMatchObject({ method: 'DELETE', url: 'https://orboto.example.com/projects/p1/tickets/t1/assignees/me1' });
    expect(calls[4]).toMatchObject({ method: 'PATCH', body: { status: 'TODO' } });
    expect(res.structuredContent).toMatchObject({
      ticketKey: 'ACME-1',
      alreadyUnassigned: false,
    });
  });

  it('idempotent: 404 on unassign is treated as alreadyUnassigned', async () => {
    stub([
      { json: ME },
      { json: PROJ },
      { json: TICKET_TODO },
      { ok: false, status: 404, json: { error: 'not assigned' } },
      { json: { ...TICKET_TODO, statusCategory: 'todo' } },
    ]);
    const res = await makeUnclaimHandler(client)({ ticketKey: 'ACME-1' });
    expect(res.structuredContent).toMatchObject({ alreadyUnassigned: true });
  });

  it('surfaces non-404 errors from the unassign delete', async () => {
    stub([
      { json: ME },
      { json: PROJ },
      { json: TICKET_TODO },
      { ok: false, status: 500, json: { error: 'boom' } },
    ]);
    await expect(
      makeUnclaimHandler(client)({ ticketKey: 'ACME-1' }),
    ).rejects.toBeInstanceOf(OrbotoApiError);
  });
});

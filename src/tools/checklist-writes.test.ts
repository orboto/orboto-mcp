/**
 * ORB-244 Phase C Group 3 — checklist write tool tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbitClient } from '../orbit-client.js';
import {
  makeCheckHandler, makeUncheckHandler,
  makeAddCheckHandler, makeNewChecklistHandler,
} from './checklist-writes.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

function stub(responses: Array<{ ok?: boolean; status?: number; json?: unknown }>) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const u = url.toString();
    const m = init?.method ?? 'GET';
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

const client = new OrbitClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });
const PROJ = { id: 'p1', key: 'ACME', name: 'Acme', description: null, status: 'active' };
const TICKET = { id: 't1', projectId: 'p1', ticketKey: 'ACME-1', title: 'Bug' };

const SAMPLE_LIST = {
  id: 'cl1', title: 'Before ship', triggersDone: false,
  progress: { done: 0, total: 2 },
  items: [
    { id: 'i1', content: 'Tests', storedCompleted: false, effectiveCompleted: false, linkedTicketId: null, linkedTicketKey: null, sortOrder: 0 },
    { id: 'i2', content: 'Docs', storedCompleted: false, effectiveCompleted: false, linkedTicketId: null, linkedTicketKey: null, sortOrder: 1 },
  ],
};

describe('orbit_check / orbit_uncheck', () => {
  it('check resolves a 1-based index → item UUID, then PATCHes isCompleted=true', async () => {
    const calls = stub([
      { json: PROJ },
      { json: TICKET },
      { json: [SAMPLE_LIST] },                    // GET checklists for index lookup
      { json: { id: 'i2', isCompleted: true } },  // PATCH
    ]);
    await makeCheckHandler(client)({ ticketKey: 'ACME-1', item: 2 });
    expect(calls[3].method).toBe('PATCH');
    expect(calls[3].url).toContain('/checklist-items/i2');
    expect(calls[3].body).toEqual({ isCompleted: true });
  });

  it('check accepts a UUID directly without re-resolving', async () => {
    const calls = stub([
      { json: PROJ },
      { json: TICKET },
      { json: [SAMPLE_LIST] },
      { json: { id: 'i2', isCompleted: true } },
    ]);
    await makeCheckHandler(client)({
      ticketKey: 'ACME-1',
      item: '00000000-0000-0000-0000-000000000099',
    });
    expect(calls[3].url).toContain('/checklist-items/00000000-0000-0000-0000-000000000099');
  });

  it('uncheck PATCHes isCompleted=false', async () => {
    const calls = stub([
      { json: PROJ },
      { json: TICKET },
      { json: [SAMPLE_LIST] },
      { json: { id: 'i1', isCompleted: false } },
    ]);
    await makeUncheckHandler(client)({ ticketKey: 'ACME-1', item: 1 });
    expect(calls[3].body).toEqual({ isCompleted: false });
  });

  it('rejects an out-of-range index with a clear count', async () => {
    stub([
      { json: PROJ },
      { json: TICKET },
      { json: [SAMPLE_LIST] }, // 2 items
    ]);
    await expect(
      makeCheckHandler(client)({ ticketKey: 'ACME-1', item: 99 })
    ).rejects.toThrow(/out of range — ticket has 2 items/);
  });
});

describe('orbit_add_check', () => {
  it('appends to the FIRST list by default', async () => {
    const calls = stub([
      { json: PROJ },
      { json: TICKET },
      { json: [SAMPLE_LIST] },
      { json: { id: 'i3', content: 'New item' } },
    ]);
    await makeAddCheckHandler(client)({ ticketKey: 'ACME-1', content: 'New item' });
    expect(calls[3].method).toBe('POST');
    expect(calls[3].url).toContain('/tickets/t1/checklists/cl1/items');
    expect(calls[3].body).toEqual({ content: 'New item' });
  });

  it('targets a named list when listTitle is supplied', async () => {
    const calls = stub([
      { json: PROJ },
      { json: TICKET },
      { json: [
        SAMPLE_LIST,
        { id: 'cl2', title: 'After ship', triggersDone: false, progress: { done: 0, total: 0 }, items: [] },
      ] },
      { json: { id: 'i9', content: 'Notify users' } },
    ]);
    await makeAddCheckHandler(client)({
      ticketKey: 'ACME-1', content: 'Notify users', listTitle: 'After ship',
    });
    expect(calls[3].url).toContain('/checklists/cl2/items');
  });

  it('resolves linkedTicketKey → linkedTicketId for cross-ticket items', async () => {
    const calls = stub([
      { json: PROJ },                                                                       // resolveTicketByKey: project (parent ACME-1)
      { json: TICKET },                                                                     // resolveTicketByKey: ticket (parent)
      { json: [SAMPLE_LIST] },                                                              // GET checklists
      { json: PROJ },                                                                       // resolveTicketByKey: project (linked ACME-99)
      { json: { id: 't99', projectId: 'p1', ticketKey: 'ACME-99', title: 'Race fix' } },   // resolveTicketByKey: ticket (linked)
      { json: { id: 'i9', content: 'Sub-task', linkedTicketId: 't99' } },                   // POST item
    ]);
    await makeAddCheckHandler(client)({
      ticketKey: 'ACME-1', content: 'Sub-task', linkedTicketKey: 'ACME-99',
    });
    expect(calls[5].body).toEqual({ content: 'Sub-task', linkedTicketId: 't99' });
  });

  it('throws a clear error when the ticket has no checklists yet', async () => {
    stub([
      { json: PROJ },
      { json: TICKET },
      { json: [] },
    ]);
    await expect(
      makeAddCheckHandler(client)({ ticketKey: 'ACME-1', content: 'x' })
    ).rejects.toThrow(/no checklists yet.*orbit_new_checklist/);
  });

  it('lists existing list titles when the requested one does not match', async () => {
    stub([
      { json: PROJ },
      { json: TICKET },
      { json: [SAMPLE_LIST] }, // title is "Before ship"
    ]);
    await expect(
      makeAddCheckHandler(client)({ ticketKey: 'ACME-1', content: 'x', listTitle: 'Wrong' })
    ).rejects.toThrow(/"Before ship"/);
  });
});

describe('orbit_new_checklist', () => {
  it('POSTs title + optional triggersDone + seeded items', async () => {
    const calls = stub([
      { json: PROJ },
      { json: TICKET },
      { json: { id: 'cl3', title: 'New', triggersDone: true, progress: { done: 0, total: 2 }, items: [{ id: 'i1' }, { id: 'i2' }] } },
    ]);
    await makeNewChecklistHandler(client)({
      ticketKey: 'ACME-1', title: 'New', triggersDone: true, items: ['a', 'b'],
    });
    expect(calls[2].method).toBe('POST');
    expect(calls[2].url).toContain('/tickets/t1/checklists');
    expect(calls[2].body).toEqual({
      title: 'New',
      triggersDone: true,
      items: [{ content: 'a' }, { content: 'b' }],
    });
  });

  it('rewrites a 403 from the API into a permission-clarifying error', async () => {
    stub([
      { json: PROJ },
      { json: TICKET },
      { ok: false, status: 403, json: { error: 'Forbidden' } },
    ]);
    await expect(
      makeNewChecklistHandler(client)({ ticketKey: 'ACME-1', title: 'x' })
    ).rejects.toThrow(/ticket:edit/);
  });
});

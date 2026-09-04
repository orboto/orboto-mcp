/**
 * ORB-799 - `orboto_set_parent` unit tests.
 *
 * Covers: re-parent happy path, detach (parentTicketKey=null),
 * cross-project rejection, self-parent rejection, API cycle rejection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import { makeSetParentHandler } from './set-parent.js';

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
const TICKET = {
  id: 't1', projectId: 'p1', ticketKey: 'ACME-1', ticketNumber: 1,
  title: 'Child', status: 'TODO', statusName: 'To Do', statusCategory: 'todo',
  type: 'task', priority: 'normal', estimatedTimeMinutes: 0, dueDate: null, isPrivate: false,
};
const PARENT = {
  ...TICKET, id: 't10', ticketKey: 'ACME-10', ticketNumber: 10, title: 'Parent epic', type: 'epic',
};

describe('orboto_set_parent', () => {
  it('happy path: re-parents and PATCHes parentTicketId', async () => {
    const calls = stub([
      { json: PROJ },                                                          // ticket: by-key project
      { json: TICKET },                                                        // ticket: by-key ticket
      { json: PROJ },                                                          // parent: by-key project
      { json: PARENT },                                                        // parent: by-key ticket
      { json: { ...TICKET, parentTicketId: 't10' } },                          // PATCH
    ]);
    const res = await makeSetParentHandler(client)({
      ticketKey: 'ACME-1', parentTicketKey: 'ACME-10',
    });
    expect(calls[4]).toMatchObject({
      method: 'PATCH',
      url: 'https://orboto.example.com/projects/p1/tickets/t1',
      body: { parentTicketId: 't10' },
    });
    expect(res.structuredContent).toMatchObject({
      ticketKey: 'ACME-1',
      parentTicketKey: 'ACME-10',
      parentTicketId: 't10',
    });
  });

  it('detach: parentTicketKey=null PATCHes parentTicketId=null', async () => {
    const calls = stub([
      { json: PROJ },
      { json: TICKET },
      { json: { ...TICKET, parentTicketId: null } },
    ]);
    await makeSetParentHandler(client)({
      ticketKey: 'ACME-1', parentTicketKey: null,
    });
    expect(calls[2]).toMatchObject({
      method: 'PATCH',
      body: { parentTicketId: null },
    });
  });

  it('refuses cross-project parenting', async () => {
    const OTHER_PROJ = { ...PROJ, id: 'p2', key: 'OTHER' };
    stub([
      { json: PROJ },                                                          // ACME-1 project
      { json: TICKET },                                                        // ACME-1 ticket (projectId p1)
      { json: OTHER_PROJ },                                                    // OTHER-5 project
      { json: { ...PARENT, projectId: 'p2', ticketKey: 'OTHER-5' } },          // OTHER-5 ticket
    ]);
    await expect(
      makeSetParentHandler(client)({
        ticketKey: 'ACME-1', parentTicketKey: 'OTHER-5',
      }),
    ).rejects.toThrow(/Cross-project parenting/);
  });

  it('refuses self-parenting', async () => {
    stub([
      { json: PROJ },
      { json: TICKET },
      { json: PROJ },
      { json: TICKET },                                                        // same ticket
    ]);
    await expect(
      makeSetParentHandler(client)({
        ticketKey: 'ACME-1', parentTicketKey: 'ACME-1',
      }),
    ).rejects.toThrow(/cannot be its own parent/);
  });

  it('translates a 400 from the PATCH (API cycle-detection) into a clear message', async () => {
    stub([
      { json: PROJ },
      { json: TICKET },
      { json: PROJ },
      { json: PARENT },
      { ok: false, status: 400, json: { error: 'cycle detected' } },
    ]);
    await expect(
      makeSetParentHandler(client)({
        ticketKey: 'ACME-1', parentTicketKey: 'ACME-10',
      }),
    ).rejects.toThrow(/Re-parent rejected by the API/);
  });
});

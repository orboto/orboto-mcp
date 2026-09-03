/**
 * ORB-799 — milestone CRUD additions to `milestones.ts`.
 *
 * `list_milestones` + `get_milestone` already have coverage in
 * `phase-b-tools.test.ts`. This file covers the new write surface:
 * create, close (incl. archive), update.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoApiError, OrbotoClient } from '../orboto-client.js';
import {
  makeCreateMilestoneHandler,
  makeCloseMilestoneHandler,
  makeUpdateMilestoneHandler,
} from './milestones.js';

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
const MILESTONE = {
  id: 'm1', projectId: 'p1', name: 'v1.0', status: 'active',
  startDate: null, endDate: null, isPrivate: false,
};

describe('orboto_create_milestone', () => {
  it('POSTs name only (dates omitted) when no dates supplied (ORB-1825)', async () => {
    const calls = stub([
      { json: PROJ },
      { json: { ...MILESTONE, name: 'v2.0' } },
    ]);
    const res = await makeCreateMilestoneHandler(client)({
      projectKey: 'ACME', name: 'v2.0',
    });
    // ORB-1825 - startDate/endDate are nullable().optional() on the API's
    // create body now; an absent key means the same thing as null, so the
    // tool no longer forces `?? null` and the wire body simply omits them.
    expect(calls[1]).toMatchObject({
      method: 'POST',
      url: 'https://orboto.example.com/projects/p1/milestones',
      body: { name: 'v2.0', isPrivate: false },
    });
    expect(calls[1].body).not.toHaveProperty('startDate');
    expect(calls[1].body).not.toHaveProperty('endDate');
    expect(res.structuredContent).toMatchObject({ name: 'v2.0', projectKey: 'ACME' });
  });

  it('passes dates + isPrivate through verbatim', async () => {
    const calls = stub([
      { json: PROJ },
      { json: { ...MILESTONE, name: 'Q3', startDate: '2026-07-01', endDate: '2026-09-30', isPrivate: true } },
    ]);
    await makeCreateMilestoneHandler(client)({
      projectKey: 'ACME', name: 'Q3', startDate: '2026-07-01', endDate: '2026-09-30', isPrivate: true,
    });
    expect(calls[1].body).toEqual({
      name: 'Q3',
      startDate: '2026-07-01',
      endDate: '2026-09-30',
      isPrivate: true,
    });
  });

  it('surfaces a 403 on POST as OrbotoApiError', async () => {
    stub([
      { json: PROJ },
      { ok: false, status: 403, json: { error: 'forbidden' } },
    ]);
    await expect(
      makeCreateMilestoneHandler(client)({ projectKey: 'ACME', name: 'v1' }),
    ).rejects.toBeInstanceOf(OrbotoApiError);
  });
});

describe('orboto_close_milestone', () => {
  it('looks up by name including closed milestones, then PATCHes status=completed', async () => {
    const calls = stub([
      { json: PROJ },
      { json: [MILESTONE] },                                                    // includeClosed=true lookup
      { json: { ...MILESTONE, status: 'completed' } },
    ]);
    const res = await makeCloseMilestoneHandler(client)({
      projectKey: 'ACME', milestone: 'v1.0',
    });
    expect(calls[1].url).toContain('includeClosed=true');
    expect(calls[2]).toMatchObject({
      method: 'PATCH',
      body: { status: 'completed' },
    });
    expect(res.structuredContent).toMatchObject({ status: 'completed' });
  });

  it('archive=true PATCHes status=archived', async () => {
    const calls = stub([
      { json: PROJ },
      { json: [MILESTONE] },
      { json: { ...MILESTONE, status: 'archived' } },
    ]);
    await makeCloseMilestoneHandler(client)({
      projectKey: 'ACME', milestone: 'v1.0', archive: true,
    });
    expect(calls[2].body).toEqual({ status: 'archived' });
  });

  it('looks up by UUID when the input matches the UUID regex', async () => {
    const calls = stub([
      { json: PROJ },
      { json: [MILESTONE, { ...MILESTONE, id: '11111111-2222-3333-4444-555555555555', name: 'other' }] },
      { json: { ...MILESTONE, status: 'completed' } },
    ]);
    await makeCloseMilestoneHandler(client)({
      projectKey: 'ACME', milestone: '11111111-2222-3333-4444-555555555555',
    });
    // PATCH URL should hit the UUID, not the first row.
    expect(calls[2].url).toContain('/milestones/11111111-2222-3333-4444-555555555555');
  });

  it('throws a clear error when milestone is not found', async () => {
    stub([
      { json: PROJ },
      { json: [] },
    ]);
    await expect(
      makeCloseMilestoneHandler(client)({ projectKey: 'ACME', milestone: 'ghost' }),
    ).rejects.toThrow(/Milestone "ghost" not found/);
  });
});

describe('orboto_update_milestone', () => {
  it('PATCHes only the supplied fields', async () => {
    const calls = stub([
      { json: PROJ },
      { json: [MILESTONE] },
      { json: { ...MILESTONE, name: 'v1.0.1' } },
    ]);
    await makeUpdateMilestoneHandler(client)({
      projectKey: 'ACME', milestone: 'v1.0', patch: { name: 'v1.0.1' },
    });
    expect(calls[2].body).toEqual({ name: 'v1.0.1' });
  });

  it('surfaces a 403 on PATCH', async () => {
    stub([
      { json: PROJ },
      { json: [MILESTONE] },
      { ok: false, status: 403, json: { error: 'forbidden' } },
    ]);
    await expect(
      makeUpdateMilestoneHandler(client)({
        projectKey: 'ACME', milestone: 'v1.0', patch: { isPrivate: true },
      }),
    ).rejects.toBeInstanceOf(OrbotoApiError);
  });
});

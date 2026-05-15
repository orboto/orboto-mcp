/**
 * ORB-885 — unit tests for `orboto_update_project`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoApiError, OrbotoClient } from '../orboto-client.js';
import { makeUpdateProjectHandler } from './update-project.js';

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
    if (!r) throw new Error('unexpected extra fetch');
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

describe('orboto_update_project', () => {
  it('PATCHes only the supplied fields', async () => {
    const calls = stub([
      { json: PROJ },
      { json: { ...PROJ, description: 'A new description.' } },
    ]);
    const res = await makeUpdateProjectHandler(client)({
      projectKey: 'ACME', patch: { description: 'A new description.' },
    });
    expect(calls[1]).toMatchObject({
      method: 'PATCH',
      url: 'https://orboto.example.com/projects/p1',
      body: { description: 'A new description.' },
    });
    expect(res.structuredContent).toMatchObject({
      key: 'ACME', description: 'A new description.',
    });
  });

  it('passes null for description to clear it', async () => {
    const calls = stub([
      { json: { ...PROJ, description: 'old' } },
      { json: { ...PROJ, description: null } },
    ]);
    await makeUpdateProjectHandler(client)({
      projectKey: 'ACME', patch: { description: null },
    });
    expect(calls[1].body).toEqual({ description: null });
  });

  it('passes status + name together when both are in the patch', async () => {
    const calls = stub([
      { json: PROJ },
      { json: { ...PROJ, name: 'Acme Renamed', status: 'archived' } },
    ]);
    const res = await makeUpdateProjectHandler(client)({
      projectKey: 'ACME', patch: { name: 'Acme Renamed', status: 'archived' },
    });
    expect(calls[1].body).toEqual({ name: 'Acme Renamed', status: 'archived' });
    expect(res.structuredContent).toMatchObject({ name: 'Acme Renamed', status: 'archived' });
  });

  it('surfaces a 403 on PATCH as OrbotoApiError', async () => {
    stub([
      { json: PROJ },
      { ok: false, status: 403, json: { error: 'forbidden' } },
    ]);
    await expect(
      makeUpdateProjectHandler(client)({
        projectKey: 'ACME', patch: { description: 'whatever' },
      }),
    ).rejects.toBeInstanceOf(OrbotoApiError);
  });

  it('throws a clear error when the project key is unknown', async () => {
    stub([
      { ok: false, status: 404, json: { error: 'not found' } },
    ]);
    await expect(
      makeUpdateProjectHandler(client)({
        projectKey: 'GHOST', patch: { description: 'x' },
      }),
    ).rejects.toThrow(/Project "GHOST" not found/);
  });
});

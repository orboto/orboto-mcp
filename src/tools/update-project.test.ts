/**
 * ORB-885 — unit tests for `orboto_update_project`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoApiError, OrbotoClient } from '../orboto-client.js';
import {
  makeUpdateProjectHandler,
  makeCreateProjectHandler,
  makeArchiveProjectHandler,
} from './update-project.js';

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

describe('orboto_create_project', () => {
  it('POSTs name + key when both supplied', async () => {
    const calls = stub([
      { json: { id: 'new1', key: 'ACME', name: 'Acme', description: null, status: 'active' } },
    ]);
    const res = await makeCreateProjectHandler(client)({ name: 'Acme', key: 'ACME' });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: 'https://orboto.example.com/projects',
      body: { name: 'Acme', key: 'ACME' },
    });
    expect(res.structuredContent).toMatchObject({ key: 'ACME', name: 'Acme', status: 'active' });
  });

  it('omits optional fields when not supplied so the API auto-derives the key', async () => {
    const calls = stub([
      { json: { id: 'new2', key: 'NN', name: 'No Name', description: null, status: 'active' } },
    ]);
    await makeCreateProjectHandler(client)({ name: 'No Name' });
    expect(calls[0].body).toEqual({ name: 'No Name' });
  });

  it('passes description + customerId through verbatim', async () => {
    const calls = stub([
      { json: { id: 'new3', key: 'CUS', name: 'Custom', description: 'hello', status: 'active' } },
    ]);
    await makeCreateProjectHandler(client)({
      name: 'Custom', description: 'hello', customerId: '11111111-2222-3333-4444-555555555555',
    });
    expect(calls[0].body).toEqual({
      name: 'Custom',
      description: 'hello',
      customerId: '11111111-2222-3333-4444-555555555555',
    });
  });

  it('surfaces a 409 (duplicate key) as OrbotoApiError', async () => {
    stub([
      { ok: false, status: 409, json: { error: 'project key already exists' } },
    ]);
    await expect(
      makeCreateProjectHandler(client)({ name: 'Dup', key: 'ACME' }),
    ).rejects.toBeInstanceOf(OrbotoApiError);
  });

  it('surfaces a 403 as OrbotoApiError', async () => {
    stub([
      { ok: false, status: 403, json: { error: 'forbidden' } },
    ]);
    await expect(
      makeCreateProjectHandler(client)({ name: 'NoPerms' }),
    ).rejects.toBeInstanceOf(OrbotoApiError);
  });
});

describe('orboto_archive_project', () => {
  it('resolves the project, then PATCHes status=archived', async () => {
    const calls = stub([
      { json: PROJ },
      { json: { ...PROJ, status: 'archived' } },
    ]);
    const res = await makeArchiveProjectHandler(client)({ projectKey: 'ACME' });
    expect(calls[0].url).toContain('/projects/by-key/ACME');
    expect(calls[1]).toMatchObject({
      method: 'PATCH',
      url: 'https://orboto.example.com/projects/p1',
      body: { status: 'archived' },
    });
    expect(res.structuredContent).toMatchObject({ status: 'archived', alreadyArchived: false });
  });

  it('is idempotent — short-circuits with no PATCH when already archived', async () => {
    const calls = stub([
      { json: { ...PROJ, status: 'archived' } },
    ]);
    const res = await makeArchiveProjectHandler(client)({ projectKey: 'ACME' });
    expect(calls).toHaveLength(1);                       // only the resolve, no PATCH
    expect((res.content[0] as { text: string }).text).toMatch(/already archived/);
    expect(res.structuredContent).toMatchObject({ alreadyArchived: true });
  });

  it('throws a clear error when the project is unknown', async () => {
    stub([
      { ok: false, status: 404, json: { error: 'not found' } },
    ]);
    await expect(
      makeArchiveProjectHandler(client)({ projectKey: 'GHOST' }),
    ).rejects.toThrow(/Project "GHOST" not found/);
  });

  it('surfaces a 403 on PATCH as OrbotoApiError', async () => {
    stub([
      { json: PROJ },
      { ok: false, status: 403, json: { error: 'forbidden' } },
    ]);
    await expect(
      makeArchiveProjectHandler(client)({ projectKey: 'ACME' }),
    ).rejects.toBeInstanceOf(OrbotoApiError);
  });
});

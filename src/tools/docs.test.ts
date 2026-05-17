/**
 * ORB-912 — doc-spaces CRUD + list-docs-in-space tool tests.
 *
 * Same fetch-stub harness as docs-ai.test.ts. Each test asserts both
 * the outgoing wire shape (URL + method + body) and the structured
 * content the model gets back, because the API's response Zod
 * validator rejects off-shape rows and we want to catch drift at the
 * unit-test layer rather than against a live API.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoApiError, OrbotoClient } from '../orboto-client.js';
import {
  makeCreateDocSpaceHandler,
  makeUpdateDocSpaceHandler,
  makeDeleteDocSpaceHandler,
  makeListDocsInSpaceHandler,
  makeCreateDocHandler,
  makeUpdateDocHandler,
  makeDeleteDocHandler,
  makeMoveDocHandler,
} from './docs.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

function stubJSON(responses: Array<{ ok?: boolean; status?: number; json?: unknown }>) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push({
      url: url.toString(),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
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

const PROJECT_SCOPED_SPACE = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'Backend Runbooks',
  slug: 'backend-runbooks',
  description: 'Ops + on-call notes for the API.',
  icon: '📘',
  type: 'project',
  projectId: '22222222-2222-2222-2222-222222222222',
  isPublic: false,
};

describe('orboto_create_doc_space', () => {
  it('POSTs with name + type + projectId and surfaces the new id', async () => {
    const calls = stubJSON([{ status: 201, json: PROJECT_SCOPED_SPACE }]);
    const res = await makeCreateDocSpaceHandler(client)({
      name: 'Backend Runbooks',
      type: 'project',
      projectId: PROJECT_SCOPED_SPACE.projectId,
      icon: '📘',
    });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: 'https://orboto.example.com/spaces',
      body: {
        name: 'Backend Runbooks',
        type: 'project',
        projectId: PROJECT_SCOPED_SPACE.projectId,
        icon: '📘',
      },
    });
    expect((res.content[0] as { text: string }).text).toContain('Backend Runbooks');
    expect(res.structuredContent).toMatchObject({
      id: PROJECT_SCOPED_SPACE.id,
      name: 'Backend Runbooks',
      type: 'project',
    });
  });

  it('passes through 403 from the API as OrbotoApiError', async () => {
    stubJSON([{ ok: false, status: 403, json: { error: 'Only super-admins can create global spaces' } }]);
    await expect(
      makeCreateDocSpaceHandler(client)({ name: 'Workspace Wiki', type: 'global' }),
    ).rejects.toBeInstanceOf(OrbotoApiError);
  });
});

describe('orboto_update_doc_space', () => {
  it('PATCHes only the fields the caller passed', async () => {
    const calls = stubJSON([{ json: { ...PROJECT_SCOPED_SPACE, name: 'API Runbooks' } }]);
    await makeUpdateDocSpaceHandler(client)({
      spaceId: PROJECT_SCOPED_SPACE.id,
      name: 'API Runbooks',
    });
    expect(calls[0]).toMatchObject({
      method: 'PATCH',
      url: `https://orboto.example.com/spaces/${PROJECT_SCOPED_SPACE.id}`,
      body: { name: 'API Runbooks' },
    });
  });

  it('refuses no-op calls before hitting the API', async () => {
    const calls = stubJSON([]);
    await expect(
      makeUpdateDocSpaceHandler(client)({ spaceId: PROJECT_SCOPED_SPACE.id }),
    ).rejects.toThrow(/at least one field/);
    expect(calls).toHaveLength(0);
  });
});

describe('orboto_delete_doc_space', () => {
  it('DELETEs the space id and returns a deleted flag', async () => {
    const calls = stubJSON([{ status: 204, json: undefined }]);
    const res = await makeDeleteDocSpaceHandler(client)({ spaceId: PROJECT_SCOPED_SPACE.id });
    expect(calls[0]).toMatchObject({
      method: 'DELETE',
      url: `https://orboto.example.com/spaces/${PROJECT_SCOPED_SPACE.id}`,
    });
    expect(res.structuredContent).toMatchObject({ deleted: true });
  });

  it('lets a 403 (system-generated space) bubble up', async () => {
    stubJSON([{ ok: false, status: 403, json: { error: 'This space is auto-generated…' } }]);
    await expect(
      makeDeleteDocSpaceHandler(client)({ spaceId: PROJECT_SCOPED_SPACE.id }),
    ).rejects.toBeInstanceOf(OrbotoApiError);
  });
});

describe('orboto_list_docs_in_space', () => {
  const ROOT = {
    id: 'a1111111-0000-0000-0000-000000000001',
    spaceId: PROJECT_SCOPED_SPACE.id,
    parentDocId: null,
    title: 'Architecture',
    content: '...',
    slug: 'architecture',
    visibility: 'workspace',
    sortOrder: 0,
    icon: null,
    updatedAt: '2026-05-17T13:00:00.000Z',
  };
  const CHILD = {
    ...ROOT,
    id: 'a1111111-0000-0000-0000-000000000002',
    parentDocId: ROOT.id,
    title: 'Queue worker retry semantics',
    sortOrder: 0,
  };

  it('renders an indented tree text + flat structured list', async () => {
    stubJSON([{ json: [CHILD, ROOT] /* deliberately unsorted to verify the local sort */ }]);
    const res = await makeListDocsInSpaceHandler(client)({ spaceId: PROJECT_SCOPED_SPACE.id });
    const text = (res.content[0] as { text: string }).text;
    expect(text.indexOf('Architecture')).toBeLessThan(text.indexOf('Queue worker'));
    expect(text).toMatch(/\s\s- .*Queue worker/);
    const docs = (res.structuredContent as { docs: Array<{ id: string }> }).docs;
    expect(docs).toHaveLength(2);
  });

  it('handles the empty-space case without rendering an empty list', async () => {
    stubJSON([{ json: [] }]);
    const res = await makeListDocsInSpaceHandler(client)({ spaceId: PROJECT_SCOPED_SPACE.id });
    expect((res.content[0] as { text: string }).text).toContain('No docs');
    expect(res.structuredContent).toMatchObject({ docs: [] });
  });
});

const DOC = {
  id: 'd0000000-0000-0000-0000-000000000001',
  spaceId: PROJECT_SCOPED_SPACE.id,
  parentDocId: null,
  title: 'Retry semantics',
  content: '# Retry semantics\n\n200ms × 2^n.',
  slug: 'retry-semantics',
  visibility: 'workspace',
  sortOrder: 0,
  icon: null,
  updatedAt: '2026-05-17T13:30:00.000Z',
};

describe('orboto_create_doc', () => {
  it('POSTs to /spaces/:id/docs with title + content', async () => {
    const calls = stubJSON([{ status: 201, json: DOC }]);
    const res = await makeCreateDocHandler(client)({
      spaceId: PROJECT_SCOPED_SPACE.id,
      title: 'Retry semantics',
      content: '# Retry semantics\n\n200ms × 2^n.',
    });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `https://orboto.example.com/spaces/${PROJECT_SCOPED_SPACE.id}/docs`,
      body: { title: 'Retry semantics', content: '# Retry semantics\n\n200ms × 2^n.' },
    });
    expect(res.structuredContent).toMatchObject({ id: DOC.id, title: DOC.title });
  });

  it('passes parentDocId + visibility through', async () => {
    const calls = stubJSON([{ status: 201, json: { ...DOC, parentDocId: 'p1' } }]);
    await makeCreateDocHandler(client)({
      spaceId: PROJECT_SCOPED_SPACE.id,
      title: 'Sub-page',
      parentDocId: 'a1111111-0000-0000-0000-000000000099',
      visibility: 'specific',
    });
    expect(calls[0].body).toMatchObject({
      title: 'Sub-page',
      parentDocId: 'a1111111-0000-0000-0000-000000000099',
      visibility: 'specific',
    });
  });
});

describe('orboto_update_doc', () => {
  it('PATCHes only the content field when only content was supplied', async () => {
    const calls = stubJSON([{ json: { ...DOC, content: 'new body' } }]);
    await makeUpdateDocHandler(client)({ docId: DOC.id, content: 'new body' });
    expect(calls[0]).toMatchObject({
      method: 'PATCH',
      url: `https://orboto.example.com/docs/${DOC.id}`,
      body: { content: 'new body' },
    });
    expect(Object.keys(calls[0].body as object)).toEqual(['content']);
  });

  it('refuses the no-op call before hitting the API', async () => {
    const calls = stubJSON([]);
    await expect(makeUpdateDocHandler(client)({ docId: DOC.id })).rejects.toThrow(/at least one field/);
    expect(calls).toHaveLength(0);
  });
});

describe('orboto_delete_doc', () => {
  it('DELETEs the doc id', async () => {
    const calls = stubJSON([{ status: 204, json: undefined }]);
    const res = await makeDeleteDocHandler(client)({ docId: DOC.id });
    expect(calls[0]).toMatchObject({ method: 'DELETE', url: `https://orboto.example.com/docs/${DOC.id}` });
    expect(res.structuredContent).toMatchObject({ deleted: true });
  });

  it('surfaces a 403 from the system-generated-doc guard', async () => {
    stubJSON([{ ok: false, status: 403, json: { error: 'This doc is auto-managed…' } }]);
    await expect(makeDeleteDocHandler(client)({ docId: DOC.id })).rejects.toBeInstanceOf(OrbotoApiError);
  });
});

describe('orboto_move_doc', () => {
  it('POSTs to /docs/:id/move with the supplied fields only', async () => {
    const calls = stubJSON([{ json: { ...DOC, parentDocId: 'newParent', sortOrder: 5 } }]);
    await makeMoveDocHandler(client)({
      docId: DOC.id,
      parentDocId: 'b1111111-0000-0000-0000-000000000001',
      sortOrder: 5,
    });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `https://orboto.example.com/docs/${DOC.id}/move`,
      body: { parentDocId: 'b1111111-0000-0000-0000-000000000001', sortOrder: 5 },
    });
  });

  it('refuses an empty move', async () => {
    const calls = stubJSON([]);
    await expect(makeMoveDocHandler(client)({ docId: DOC.id })).rejects.toThrow(/at least one/);
    expect(calls).toHaveLength(0);
  });

  it('allows reparenting to root (parentDocId=null)', async () => {
    const calls = stubJSON([{ json: { ...DOC, parentDocId: null } }]);
    await makeMoveDocHandler(client)({ docId: DOC.id, parentDocId: null });
    expect(calls[0].body).toEqual({ parentDocId: null });
  });
});

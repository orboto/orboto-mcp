/**
 * ORB-916 - doc-revisions tool tests.
 *
 * - list - happy + empty + nextCursor follow-up
 * - get - happy
 * - restore - happy + 404 bubble-up
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoApiError, OrbotoClient } from '../orboto-client.js';
import {
  makeListDocRevisionsHandler,
  makeGetDocRevisionHandler,
  makeRestoreDocRevisionHandler,
} from './doc-revisions.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });

const DOC_ID = 'd0000000-0000-0000-0000-000000000001';
const REV_ID = 'a0000000-0000-0000-0000-000000000111';

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

const REVISION_LIST_ROW = {
  id: REV_ID,
  docId: DOC_ID,
  title: 'Previous title',
  editedBy: 'u1',
  editedAt: '2026-05-17T12:00:00.000Z',
};

describe('orboto_list_doc_revisions', () => {
  it('GETs /docs/:id/revisions with cursor + limit when supplied', async () => {
    const calls = stubJSON([{ json: { items: [REVISION_LIST_ROW], nextCursor: null } }]);
    await makeListDocRevisionsHandler(client)({
      docId: DOC_ID,
      limit: 50,
      cursor: 'eyJ0IjoiZXhhbXBsZSJ9',
    });
    expect(calls[0].url).toContain(`/docs/${DOC_ID}/revisions`);
    expect(calls[0].url).toContain('limit=50');
    expect(calls[0].url).toContain('cursor=eyJ0IjoiZXhhbXBsZSJ9');
  });

  it('surfaces nextCursor in the structuredContent + the text body', async () => {
    stubJSON([{ json: { items: [REVISION_LIST_ROW], nextCursor: 'NEXT' } }]);
    const res = await makeListDocRevisionsHandler(client)({ docId: DOC_ID });
    expect((res.content[0] as { text: string }).text).toContain('NEXT');
    expect(res.structuredContent).toMatchObject({ nextCursor: 'NEXT' });
  });

  it('reports the empty-history case explicitly', async () => {
    stubJSON([{ json: { items: [], nextCursor: null } }]);
    const res = await makeListDocRevisionsHandler(client)({ docId: DOC_ID });
    expect((res.content[0] as { text: string }).text).toContain('No revisions');
    expect(res.structuredContent).toMatchObject({ revisions: [], nextCursor: null });
  });
});

describe('orboto_get_doc_revision', () => {
  it('GETs the full revision row including content', async () => {
    stubJSON([{ json: { ...REVISION_LIST_ROW, content: '# Previous title\n\nOld body.' } }]);
    const res = await makeGetDocRevisionHandler(client)({ docId: DOC_ID, revisionId: REV_ID });
    expect(res.structuredContent).toMatchObject({
      id: REV_ID,
      content: '# Previous title\n\nOld body.',
    });
    expect((res.content[0] as { text: string }).text).toContain('Old body.');
  });
});

describe('orboto_restore_doc_revision', () => {
  it('POSTs to /docs/:id/revisions/:rid/restore and surfaces the restored doc', async () => {
    const calls = stubJSON([{
      json: {
        id: DOC_ID, spaceId: 's1', parentDocId: null, title: 'Previous title',
        content: '# Previous title', slug: 'previous', visibility: 'workspace',
        icon: null, sortOrder: 0, updatedAt: '2026-05-17T13:30:00.000Z',
      },
    }]);
    const res = await makeRestoreDocRevisionHandler(client)({ docId: DOC_ID, revisionId: REV_ID });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `https://orboto.example.com/docs/${DOC_ID}/revisions/${REV_ID}/restore`,
    });
    expect(res.structuredContent).toMatchObject({
      docId: DOC_ID,
      restoredFromRevisionId: REV_ID,
    });
  });

  it('bubbles up a 404 from an unknown revision id', async () => {
    stubJSON([{ ok: false, status: 404, json: { error: 'Not found' } }]);
    await expect(
      makeRestoreDocRevisionHandler(client)({ docId: DOC_ID, revisionId: 'b0000000-0000-0000-0000-000000000999' }),
    ).rejects.toBeInstanceOf(OrbotoApiError);
  });
});

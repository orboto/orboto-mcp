/**
 * ORB-1342 - doc snippet-search + targeted-edit tool tests.
 *
 * Same fetch-stub harness as docs.test.ts. Each test asserts the outgoing
 * wire shape (URL + method + body) and the structured content the model
 * gets back. The edit tools also cover the two machine-readable 409 paths
 * (ambiguous / stale) the acceptance criteria call out - the API returns a
 * JSON conflict body, the tool must surface it as a non-throwing isError
 * result the model can act on, NOT let the raw OrbotoApiError bubble up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import {
  makeSearchDocsHandler,
  makeEditDocHandler,
  makeEditDocSectionHandler,
} from './doc-edits.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

/** Stub fetch with a queue of responses. Error responses carry a `text`
 *  body (the OrbotoClient reads res.text() on non-2xx) so the 409 JSON
 *  conflict body reaches the tool's catch branch. */
function stubJSON(responses: Array<{ ok?: boolean; status?: number; json?: unknown; text?: string }>) {
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
      text: async () => r.text ?? '',
    } as unknown as Response;
  });
  return calls;
}

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });

const DOC_UUID = '33333333-3333-3333-3333-333333333333';
const REV_UUID = '44444444-4444-4444-4444-444444444444';

// ---------------------------------------------------------------------------
// orboto_search_docs
// ---------------------------------------------------------------------------

describe('orboto_search_docs', () => {
  const HIT = {
    id: DOC_UUID,
    docKey: 'ORB-D12',
    title: 'Backup Runbook',
    spaceId: '11111111-1111-1111-1111-111111111111',
    spaceName: 'Backend Runbooks',
    projectId: '22222222-2222-2222-2222-222222222222',
    snippet: 'To <mark>restore</mark> a project from backup …',
    headingPath: ['Setup', 'Restore'],
    charOffset: 120,
    lineOffset: 7,
    rank: 0.42,
    url: '/spaces/11111111-1111-1111-1111-111111111111/docs/33333333-3333-3333-3333-333333333333',
  };

  it('GETs /docs/search with the query + limit and surfaces snippet + anchor', async () => {
    const calls = stubJSON([{ json: { items: [HIT], total: 1 } }]);
    const res = await makeSearchDocsHandler(client)({ q: 'restore backup', limit: 10 });
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toContain('/docs/search?');
    expect(calls[0].url).toContain('q=restore+backup');
    expect(calls[0].url).toContain('limit=10');
    const sc = res.structuredContent as { items: Array<{ headingPath: string[]; snippet: string }>; total: number };
    expect(sc.total).toBe(1);
    expect(sc.items[0].headingPath).toEqual(['Setup', 'Restore']);
    expect(sc.items[0].snippet).toContain('<mark>restore</mark>');
    expect((res.content[0] as { text: string }).text).toContain('§Setup > Restore');
  });

  it('resolves projectKey to a projectId before searching', async () => {
    const calls = stubJSON([
      { json: { id: '22222222-2222-2222-2222-222222222222', key: 'ORB', name: 'orboto', status: 'active' } }, // by-key
      { json: { items: [], total: 0 } },
    ]);
    await makeSearchDocsHandler(client)({ q: 'deploy', projectKey: 'ORB' });
    expect(calls[0].url).toContain('/projects/by-key/ORB');
    expect(calls[1].url).toContain('projectId=22222222-2222-2222-2222-222222222222');
  });

  it('passes spaceId straight through', async () => {
    const calls = stubJSON([{ json: { items: [], total: 0 } }]);
    await makeSearchDocsHandler(client)({ q: 'x', spaceId: '11111111-1111-1111-1111-111111111111' });
    expect(calls[0].url).toContain('spaceId=11111111-1111-1111-1111-111111111111');
  });

  it('reports no matches cleanly', async () => {
    stubJSON([{ json: { items: [], total: 0 } }]);
    const res = await makeSearchDocsHandler(client)({ q: 'nothing' });
    expect((res.content[0] as { text: string }).text).toContain('No docs matched');
  });
});

// ---------------------------------------------------------------------------
// orboto_edit_doc - string-replace
// ---------------------------------------------------------------------------

describe('orboto_edit_doc', () => {
  it('POSTs edits to /docs/:id/edits (UUID passthrough) and renders the window', async () => {
    const calls = stubJSON([{
      json: {
        docId: DOC_UUID,
        docKey: 'ORB-D12',
        revisionId: REV_UUID,
        edits: [{ index: 0, kind: 'edit', replaced: 1, window: 'The slow brown fox' }],
      },
    }]);
    const res = await makeEditDocHandler(client)({
      docId: DOC_UUID,
      edits: [{ oldString: 'quick', newString: 'slow' }],
      baseRevisionId: REV_UUID,
    });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `https://orboto.example.com/docs/${DOC_UUID}/edits`,
      body: { edits: [{ oldString: 'quick', newString: 'slow' }], baseRevisionId: REV_UUID },
    });
    const sc = res.structuredContent as { revisionId: string; edits: unknown[] };
    expect(sc.revisionId).toBe(REV_UUID);
    expect((res.content[0] as { text: string }).text).toContain('Applied 1 change');
  });

  it('resolves a doc key to a UUID before editing', async () => {
    const calls = stubJSON([
      { json: { id: DOC_UUID } }, // /docs/by-key/ORB-D12
      { json: { docId: DOC_UUID, docKey: 'ORB-D12', revisionId: REV_UUID, edits: [] } },
    ]);
    await makeEditDocHandler(client)({ docId: 'ORB-D12', edits: [{ oldString: 'a', newString: 'b' }] });
    expect(calls[0].url).toContain('/docs/by-key/ORB-D12');
    expect(calls[1].url).toBe(`https://orboto.example.com/docs/${DOC_UUID}/edits`);
  });

  it('surfaces an ambiguous-match 409 as a non-throwing isError result', async () => {
    stubJSON([{
      ok: false,
      status: 409,
      text: JSON.stringify({ error: 'ambiguous', reason: 'ambiguous_match', editIndex: 0, occurrences: 3 }),
    }]);
    const res = await makeEditDocHandler(client)({ docId: DOC_UUID, edits: [{ oldString: 'the', newString: 'a' }] });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain('matched 3 times');
    expect(res.structuredContent).toMatchObject({ conflict: true, reason: 'ambiguous_match', occurrences: 3 });
  });

  it('surfaces a stale-revision 409 with the current revision id to retry with', async () => {
    stubJSON([{
      ok: false,
      status: 409,
      text: JSON.stringify({ error: 'stale', reason: 'stale_revision', currentRevisionId: REV_UUID }),
    }]);
    const res = await makeEditDocHandler(client)({
      docId: DOC_UUID,
      edits: [{ oldString: 'a', newString: 'b' }],
      baseRevisionId: '00000000-0000-0000-0000-000000000000',
    });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain(REV_UUID);
    expect(res.structuredContent).toMatchObject({ conflict: true, reason: 'stale_revision', currentRevisionId: REV_UUID });
  });

  it('rethrows a non-409 API error (permission / transport)', async () => {
    stubJSON([{ ok: false, status: 403, text: 'Forbidden' }]);
    await expect(
      makeEditDocHandler(client)({ docId: DOC_UUID, edits: [{ oldString: 'a', newString: 'b' }] }),
    ).rejects.toThrow(/403/);
  });
});

// ---------------------------------------------------------------------------
// orboto_edit_doc_section - heading-addressed
// ---------------------------------------------------------------------------

describe('orboto_edit_doc_section', () => {
  it('POSTs sectionOps to /docs/:id/edits', async () => {
    const calls = stubJSON([{
      json: {
        docId: DOC_UUID,
        docKey: 'ORB-D12',
        revisionId: REV_UUID,
        edits: [{ index: 0, kind: 'sectionOp', replaced: 1, window: 'New creds.' }],
      },
    }]);
    const res = await makeEditDocSectionHandler(client)({
      docId: DOC_UUID,
      sectionOps: [{ headingPath: ['Setup', 'Credentials'], op: 'replace', content: '\nNew creds.\n' }],
    });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `https://orboto.example.com/docs/${DOC_UUID}/edits`,
      body: { sectionOps: [{ headingPath: ['Setup', 'Credentials'], op: 'replace', content: '\nNew creds.\n' }] },
    });
    expect((res.content[0] as { text: string }).text).toContain('sectionOp');
  });

  it('surfaces an ambiguous-heading 409 with candidates', async () => {
    stubJSON([{
      ok: false,
      status: 409,
      text: JSON.stringify({
        error: 'ambiguous heading',
        reason: 'ambiguous_heading',
        editIndex: 0,
        headingPath: ['Notes'],
        candidates: ['A > Notes', 'B > Notes'],
      }),
    }]);
    const res = await makeEditDocSectionHandler(client)({
      docId: DOC_UUID,
      sectionOps: [{ headingPath: ['Notes'], op: 'append', content: 'x' }],
    });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain('A > Notes | B > Notes');
    expect(res.structuredContent).toMatchObject({ conflict: true, reason: 'ambiguous_heading' });
  });

  it('surfaces a heading-not-found 409', async () => {
    stubJSON([{
      ok: false,
      status: 409,
      text: JSON.stringify({ error: 'not found', reason: 'heading_not_found', editIndex: 0, headingPath: ['Ghost'] }),
    }]);
    const res = await makeEditDocSectionHandler(client)({
      docId: DOC_UUID,
      sectionOps: [{ headingPath: ['Ghost'], op: 'replace', content: 'x' }],
    });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain('no heading matched');
  });
});

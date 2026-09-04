/**
 * ORB-917 - doc-comments tool tests.
 *
 *   - list: happy + tree-render + empty + nextCursor
 *   - post: happy + reply (parentCommentId) + anchor passthrough
 *   - resolve: true + false toggle
 *   - delete: happy + 403 ownership bubble
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoApiError, OrbotoClient } from '../orboto-client.js';
import {
  makeListDocCommentsHandler,
  makePostDocCommentHandler,
  makeResolveDocCommentHandler,
  makeUpdateDocCommentHandler,
  makeDeleteDocCommentHandler,
} from './doc-comments.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });

const DOC_ID = 'd0000000-0000-0000-0000-000000000001';
const COMMENT_ID = 'c0000000-0000-0000-0000-000000000001';

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

const ROOT_COMMENT = {
  id: COMMENT_ID,
  docId: DOC_ID,
  userId: 'u1',
  userName: 'Alice',
  parentCommentId: null,
  content: 'Looks good to me.',
  anchor: null,
  resolvedAt: null,
  resolvedBy: null,
  createdAt: '2026-05-17T12:00:00.000Z',
};

const REPLY_COMMENT = {
  ...ROOT_COMMENT,
  id: 'c0000000-0000-0000-0000-000000000002',
  userId: 'u2',
  userName: 'Bob',
  parentCommentId: ROOT_COMMENT.id,
  content: 'Agreed.',
  createdAt: '2026-05-17T12:05:00.000Z',
};

describe('orboto_list_doc_comments', () => {
  it('renders an indented tree with root + replies', async () => {
    stubJSON([{ json: { items: [ROOT_COMMENT, REPLY_COMMENT], nextCursor: null } }]);
    const res = await makeListDocCommentsHandler(client)({ docId: DOC_ID });
    const text = (res.content[0] as { text: string }).text;
    expect(text.indexOf('Alice')).toBeLessThan(text.indexOf('Bob'));
    expect(text).toMatch(/\s\s- Bob/); // reply is indented one level
    expect(text).toContain('Agreed.');
    const comments = (res.structuredContent as { comments: Array<{ id: string }> }).comments;
    expect(comments).toHaveLength(2);
  });

  it('reports the empty-comments case', async () => {
    stubJSON([{ json: { items: [], nextCursor: null } }]);
    const res = await makeListDocCommentsHandler(client)({ docId: DOC_ID });
    expect((res.content[0] as { text: string }).text).toContain('No comments');
  });

  it('surfaces nextCursor in both the structured payload and the text', async () => {
    stubJSON([{ json: { items: [ROOT_COMMENT], nextCursor: 'NEXT' } }]);
    const res = await makeListDocCommentsHandler(client)({ docId: DOC_ID });
    expect((res.content[0] as { text: string }).text).toContain('NEXT');
    expect(res.structuredContent).toMatchObject({ nextCursor: 'NEXT' });
  });

  it('surfaces the anchor preview when a comment is anchored', async () => {
    const anchored = {
      ...ROOT_COMMENT,
      anchor: { text: 'retry backoff is 200ms', before: 'The ', after: '. Reset' },
    };
    stubJSON([{ json: { items: [anchored], nextCursor: null } }]);
    const res = await makeListDocCommentsHandler(client)({ docId: DOC_ID });
    expect((res.content[0] as { text: string }).text).toContain('anchored on: "retry backoff is 200ms"');
  });
});

describe('orboto_post_doc_comment', () => {
  it('POSTs content with no parent for a root comment', async () => {
    const calls = stubJSON([{ status: 201, json: ROOT_COMMENT }]);
    await makePostDocCommentHandler(client)({
      docId: DOC_ID,
      content: 'Looks good to me.',
    });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `https://orboto.example.com/docs/${DOC_ID}/comments`,
      body: { content: 'Looks good to me.' },
    });
    // No parentCommentId in the body for a root comment.
    expect((calls[0].body as Record<string, unknown>).parentCommentId).toBeUndefined();
  });

  it('passes parentCommentId through for a reply', async () => {
    const calls = stubJSON([{ status: 201, json: REPLY_COMMENT }]);
    await makePostDocCommentHandler(client)({
      docId: DOC_ID,
      content: 'Agreed.',
      parentCommentId: ROOT_COMMENT.id,
    });
    expect(calls[0].body).toMatchObject({
      content: 'Agreed.',
      parentCommentId: ROOT_COMMENT.id,
    });
  });

  it('passes anchor through for an anchored comment', async () => {
    const calls = stubJSON([{ status: 201, json: ROOT_COMMENT }]);
    await makePostDocCommentHandler(client)({
      docId: DOC_ID,
      content: 'This needs clarification.',
      anchor: { text: 'API key required', before: 'The ', after: '.' },
    });
    expect((calls[0].body as Record<string, unknown>).anchor).toMatchObject({
      text: 'API key required',
      before: 'The ',
      after: '.',
    });
  });
});

describe('orboto_resolve_doc_comment', () => {
  it('POSTs resolved=true on resolve', async () => {
    const calls = stubJSON([{ json: { ...ROOT_COMMENT, resolvedAt: '2026-05-17T13:00:00.000Z', resolvedBy: 'u1' } }]);
    const res = await makeResolveDocCommentHandler(client)({
      docId: DOC_ID,
      commentId: COMMENT_ID,
      resolved: true,
    });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `https://orboto.example.com/docs/${DOC_ID}/comments/${COMMENT_ID}/resolve`,
      body: { resolved: true },
    });
    expect((res.content[0] as { text: string }).text).toContain('resolved');
  });

  it('POSTs resolved=false on reopen', async () => {
    const calls = stubJSON([{ json: { ...ROOT_COMMENT, resolvedAt: null, resolvedBy: null } }]);
    const res = await makeResolveDocCommentHandler(client)({
      docId: DOC_ID,
      commentId: COMMENT_ID,
      resolved: false,
    });
    expect(calls[0].body).toMatchObject({ resolved: false });
    expect((res.content[0] as { text: string }).text).toContain('reopened');
  });
});

describe('orboto_delete_doc_comment', () => {
  it('DELETEs the comment id', async () => {
    const calls = stubJSON([{ status: 204, json: undefined }]);
    const res = await makeDeleteDocCommentHandler(client)({ docId: DOC_ID, commentId: COMMENT_ID });
    expect(calls[0]).toMatchObject({
      method: 'DELETE',
      url: `https://orboto.example.com/docs/${DOC_ID}/comments/${COMMENT_ID}`,
    });
    expect(res.structuredContent).toMatchObject({ deleted: true });
  });

  it('bubbles up a 403 when deleting someone else\'s comment', async () => {
    stubJSON([{ ok: false, status: 403, json: { error: 'Forbidden' } }]);
    await expect(
      makeDeleteDocCommentHandler(client)({ docId: DOC_ID, commentId: COMMENT_ID }),
    ).rejects.toBeInstanceOf(OrbotoApiError);
  });
});

describe('orboto_update_doc_comment', () => {
  it('PATCHes content on the comment id', async () => {
    const calls = stubJSON([{ json: { ...ROOT_COMMENT, content: 'Updated.' } }]);
    const res = await makeUpdateDocCommentHandler(client)({
      docId: DOC_ID,
      commentId: COMMENT_ID,
      content: 'Updated.',
    });
    expect(calls[0]).toMatchObject({
      method: 'PATCH',
      url: `https://orboto.example.com/docs/${DOC_ID}/comments/${COMMENT_ID}`,
      body: { content: 'Updated.' },
    });
    expect((res.structuredContent as { content: string }).content).toBe('Updated.');
  });

  it('bubbles up a 403 when editing someone else\'s comment', async () => {
    stubJSON([{ ok: false, status: 403, json: { error: 'Forbidden - only the author can edit this comment' } }]);
    await expect(
      makeUpdateDocCommentHandler(client)({ docId: DOC_ID, commentId: COMMENT_ID, content: 'X' }),
    ).rejects.toBeInstanceOf(OrbotoApiError);
  });
});

/**
 * ORB-914 — doc-attachments tool tests.
 *
 * Multipart upload's wire format is opaque to JSON inspection — we
 * just assert URL + method + that the FormData carries a `file` field.
 * The embed branch is covered by checking that a follow-up PATCH lands
 * on /docs/:id with the appended Markdown line.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import {
  makeUploadDocAttachmentHandler,
  makeListDocAttachmentsHandler,
  makeDeleteDocAttachmentHandler,
} from './doc-attachments.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });

const DOC_ID = 'd0000000-0000-0000-0000-000000000001';
const ATT_ID = 'a0000000-0000-0000-0000-000000000001';

const ATTACHMENT = {
  id: ATT_ID,
  targetType: 'doc' as const,
  targetId: DOC_ID,
  filename: 'arch.png',
  contentType: 'image/png',
  sizeBytes: 4096,
  uploadedBy: 'u1',
  uploadedAt: '2026-05-17T13:30:00.000Z',
  downloadUrl: `/attachments/${ATT_ID}`,
};

function stubFetch(responses: Array<{ ok?: boolean; status?: number; json?: unknown }>) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push({
      url: url.toString(),
      method: init?.method ?? 'GET',
      body: init?.body,
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

const TINY_PNG_BASE64 =
  // 1x1 red png — smallest valid bytes we can pass through
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAFhAJ/wlseKgAAAABJRU5ErkJggg==';

describe('orboto_upload_doc_attachment', () => {
  it('POSTs multipart to /docs/:id/attachments and returns markdown image line', async () => {
    const calls = stubFetch([{ status: 201, json: ATTACHMENT }]);
    const res = await makeUploadDocAttachmentHandler(client)({
      docId: DOC_ID,
      filename: 'arch.png',
      contentBase64: TINY_PNG_BASE64,
    });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `https://orboto.example.com/docs/${DOC_ID}/attachments`,
    });
    // FormData reaches fetch as a FormData instance.
    expect(calls[0].body).toBeInstanceOf(FormData);
    const fd = calls[0].body as FormData;
    expect(fd.get('file')).toBeTruthy();
    expect(res.structuredContent).toMatchObject({
      attachmentId: ATT_ID,
      filename: 'arch.png',
      downloadUrl: `/attachments/${ATT_ID}`,
      markdown: `![arch.png](/attachments/${ATT_ID})`,
      embedded: false,
    });
  });

  it('embeds the markdown line into the doc body when embed=true', async () => {
    const calls = stubFetch([
      { status: 201, json: ATTACHMENT },
      { json: { id: DOC_ID, spaceId: 's1', parentDocId: null, title: 'Arch', content: '# Header\n\nbody', slug: 'arch', visibility: 'workspace', icon: null, sortOrder: 0, updatedAt: '2026-05-17T13:30:00.000Z' } },
      { json: { id: DOC_ID, content: '# Header\n\nbody\n\n![arch.png](/attachments/'+ATT_ID+')' } },
    ]);
    await makeUploadDocAttachmentHandler(client)({
      docId: DOC_ID,
      filename: 'arch.png',
      contentBase64: TINY_PNG_BASE64,
      embed: true,
    });
    expect(calls[1]).toMatchObject({ method: 'GET', url: `https://orboto.example.com/docs/${DOC_ID}` });
    expect(calls[2]).toMatchObject({ method: 'PATCH', url: `https://orboto.example.com/docs/${DOC_ID}` });
    const patchBody = JSON.parse(calls[2].body as string);
    expect(patchBody.content).toContain(`![arch.png](/attachments/${ATT_ID})`);
    expect(patchBody.content).toContain('# Header');
  });

  it('refuses an empty-bytes upload before hitting the API', async () => {
    const calls = stubFetch([]);
    await expect(
      makeUploadDocAttachmentHandler(client)({ docId: DOC_ID, filename: 'empty.png', contentBase64: '' }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('uses link syntax (not image) for non-image MIME types', async () => {
    stubFetch([{ status: 201, json: { ...ATTACHMENT, filename: 'spec.pdf', contentType: 'application/pdf' } }]);
    const res = await makeUploadDocAttachmentHandler(client)({
      docId: DOC_ID,
      filename: 'spec.pdf',
      contentBase64: TINY_PNG_BASE64,
    });
    expect(res.structuredContent).toMatchObject({
      markdown: `[spec.pdf](/attachments/${ATT_ID})`,
    });
  });
});

describe('orboto_list_doc_attachments', () => {
  it('renders one line per attachment with KB + URL', async () => {
    const calls = stubFetch([{ json: [ATTACHMENT] }]);
    const res = await makeListDocAttachmentsHandler(client)({ docId: DOC_ID });
    expect(calls[0]).toMatchObject({ method: 'GET', url: `https://orboto.example.com/docs/${DOC_ID}/attachments` });
    expect((res.content[0] as { text: string }).text).toContain('arch.png');
    expect((res.content[0] as { text: string }).text).toContain('4 KB');
  });

  it('reports the empty-list case explicitly', async () => {
    stubFetch([{ json: [] }]);
    const res = await makeListDocAttachmentsHandler(client)({ docId: DOC_ID });
    expect((res.content[0] as { text: string }).text).toContain('No attachments');
    expect(res.structuredContent).toMatchObject({ attachments: [] });
  });
});

describe('orboto_delete_doc_attachment', () => {
  it('DELETEs /docs/:id/attachments/:attId', async () => {
    const calls = stubFetch([{ status: 204, json: undefined }]);
    const res = await makeDeleteDocAttachmentHandler(client)({ docId: DOC_ID, attachmentId: ATT_ID });
    expect(calls[0]).toMatchObject({
      method: 'DELETE',
      url: `https://orboto.example.com/docs/${DOC_ID}/attachments/${ATT_ID}`,
    });
    expect(res.structuredContent).toMatchObject({ deleted: true });
  });
});

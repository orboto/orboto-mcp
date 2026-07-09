/**
 * ORB-1455 - orboto_list_ticket_attachments + orboto_get_attachment tests.
 *
 * list: resolves the ticket by key, GETs /tickets/:id/attachments, renders
 *       one metadata line per attachment (empty-list case too).
 * get:  fetches the base64 route and returns an IMAGE content block for a png,
 *       a TEXT block for a pdf, and a size-cap refusal (skill-download pointer)
 *       for an over-limit file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import { makeListTicketAttachmentsHandler, makeGetAttachmentHandler } from './ticket-attachments.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });

const PROJ = { id: 'p1', key: 'ACME', name: 'Acme', description: null, status: 'active' };
const TICKET = {
  id: 't1', projectId: 'p1', ticketKey: 'ACME-1', ticketNumber: 1,
  title: 'Bug', description: 'body', status: 'TODO', statusName: 'To Do',
  statusCategory: 'todo', type: 'bug', priority: 'normal',
  estimatedTimeMinutes: 0, dueDate: null, isPrivate: false,
};
const ATT_ID = 'a0000000-0000-0000-0000-000000000001';
const PNG_ATTACHMENT = {
  id: ATT_ID, targetType: 'ticket' as const, targetId: 't1',
  filename: 'screenshot.png', contentType: 'image/png', sizeBytes: 4096,
  uploadedBy: 'u1', uploadedAt: '2026-07-09T13:30:00.000Z', downloadUrl: `/attachments/${ATT_ID}`,
};

function stubFetch(responses: Array<{ ok?: boolean; status?: number; json?: unknown }>) {
  const calls: Array<{ url: string; method: string }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push({ url: url.toString(), method: init?.method ?? 'GET' });
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
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAFhAJ/wlseKgAAAABJRU5ErkJggg==';

describe('orboto_list_ticket_attachments', () => {
  it('resolves the ticket and lists its attachments with KB + id + URL', async () => {
    const calls = stubFetch([
      { json: PROJ },              // resolveTicketByKey: project
      { json: TICKET },            // resolveTicketByKey: ticket
      { json: [PNG_ATTACHMENT] },  // GET /tickets/:id/attachments
    ]);
    const res = await makeListTicketAttachmentsHandler(client)({ ticketKey: 'ACME-1' });
    expect(calls[2]).toMatchObject({ method: 'GET', url: 'https://orboto.example.com/tickets/t1/attachments' });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('screenshot.png');
    expect(text).toContain('4 KB');
    expect(text).toContain(ATT_ID);
    expect(res.structuredContent).toMatchObject({
      ticketKey: 'ACME-1',
      attachments: [{ id: ATT_ID, filename: 'screenshot.png', contentType: 'image/png', sizeBytes: 4096 }],
    });
  });

  it('reports the empty-list case explicitly', async () => {
    stubFetch([{ json: PROJ }, { json: TICKET }, { json: [] }]);
    const res = await makeListTicketAttachmentsHandler(client)({ ticketKey: 'ACME-1' });
    expect((res.content[0] as { text: string }).text).toContain('No attachments');
    expect(res.structuredContent).toMatchObject({ attachments: [] });
  });
});

describe('orboto_get_attachment', () => {
  it('returns an image content block for a png', async () => {
    const calls = stubFetch([{
      json: { id: ATT_ID, filename: 'screenshot.png', contentType: 'image/png', sizeBytes: 4096, contentBase64: TINY_PNG_BASE64 },
    }]);
    const res = await makeGetAttachmentHandler(client)({ attachmentId: ATT_ID });
    expect(calls[0]).toMatchObject({ method: 'GET', url: `https://orboto.example.com/attachments/${ATT_ID}/base64` });
    const img = res.content.find((c) => c.type === 'image') as { type: string; data: string; mimeType: string };
    expect(img).toBeTruthy();
    expect(img.data).toBe(TINY_PNG_BASE64);
    expect(img.mimeType).toBe('image/png');
    expect(res.structuredContent).toMatchObject({ id: ATT_ID, inlined: true });
  });

  it('returns a text block (no image) for a pdf', async () => {
    stubFetch([{
      json: { id: ATT_ID, filename: 'spec.pdf', contentType: 'application/pdf', sizeBytes: 2048, contentBase64: TINY_PNG_BASE64 },
    }]);
    const res = await makeGetAttachmentHandler(client)({ attachmentId: ATT_ID });
    expect(res.content.find((c) => c.type === 'image')).toBeUndefined();
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('spec.pdf');
    expect(text).toContain('application/pdf');
    expect(res.structuredContent).toMatchObject({ inlined: true, contentType: 'application/pdf' });
  });

  it('refuses an over-limit file inline and points at the skill download', async () => {
    stubFetch([{
      json: { id: ATT_ID, filename: 'huge.png', contentType: 'image/png', sizeBytes: 8 * 1024 * 1024, contentBase64: TINY_PNG_BASE64 },
    }]);
    const res = await makeGetAttachmentHandler(client)({ attachmentId: ATT_ID });
    expect(res.content.find((c) => c.type === 'image')).toBeUndefined();
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('download-attachment');
    expect(res.structuredContent).toMatchObject({ inlined: false });
  });
});

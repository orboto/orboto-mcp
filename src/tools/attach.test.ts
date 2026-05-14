/**
 * ORB-799 — `orboto_attach_to_ticket` unit tests.
 *
 * Covers upload-only, embed=true (re-PATCHes description), and the
 * empty-base64 refusal. The multipart wire format is opaque to JSON
 * inspection so we just assert the request shape (route, method,
 * FormData body).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import { makeAttachToTicketHandler } from './attach.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });

const PROJ = { id: 'p1', key: 'ACME', name: 'Acme', description: null, status: 'active' };
const TICKET = {
  id: 't1', projectId: 'p1', ticketKey: 'ACME-1', ticketNumber: 1,
  title: 'Bug', description: 'existing body', status: 'TODO', statusName: 'To Do',
  statusCategory: 'todo', type: 'bug', priority: 'normal',
  estimatedTimeMinutes: 0, dueDate: null, isPrivate: false,
};
const ATTACHMENT = {
  id: 'att1', filename: 'logo.png', mimetype: 'image/png',
  sizeBytes: 5, downloadUrl: '/attachments/att1',
};

function makeFetchMock(stages: Array<{
  ok?: boolean; status?: number; json?: unknown;
}>) {
  const calls: Array<{ url: string; method: string; bodyType: string; body?: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const ct = init?.headers
      ? (init.headers as Record<string, string>)['Content-Type']
      : undefined;
    let parsedBody: unknown;
    if (typeof init?.body === 'string' && ct?.startsWith('application/json')) {
      parsedBody = JSON.parse(init.body);
    }
    calls.push({
      url: url.toString(),
      method: init?.method ?? 'GET',
      bodyType: init?.body?.constructor?.name ?? 'undefined',
      body: parsedBody,
    });
    const r = stages.shift();
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

describe('orboto_attach_to_ticket', () => {
  it('upload-only (embed=false) returns markdown line + URL', async () => {
    const calls = makeFetchMock([
      { json: PROJ },                                                          // resolveTicketByKey: project
      { json: TICKET },                                                        // resolveTicketByKey: ticket
      { json: ATTACHMENT },                                                    // multipart POST attachments
    ]);
    const base64 = Buffer.from('PNGBYTES').toString('base64');
    const res = await makeAttachToTicketHandler(client)({
      ticketKey: 'ACME-1', filename: 'logo.png', contentBase64: base64,
    });
    const uploadCall = calls.find((c) => c.url.endsWith('/attachments'));
    expect(uploadCall).toMatchObject({
      method: 'POST',
      bodyType: 'FormData',
    });
    expect(res.structuredContent).toMatchObject({
      ticketKey: 'ACME-1',
      attachmentId: 'att1',
      url: '/attachments/att1',
      markdown: '![logo.png](/attachments/att1)',
      embedded: false,
    });
  });

  it('embed=true re-fetches the ticket and PATCHes the description with appended markdown', async () => {
    const calls = makeFetchMock([
      { json: PROJ },
      { json: TICKET },
      { json: ATTACHMENT },                                                    // multipart upload
      { json: TICKET },                                                        // GET ticket (current description)
      { json: { ...TICKET, description: 'existing body\n\n![logo.png](/attachments/att1)' } }, // PATCH
    ]);
    const base64 = Buffer.from('PNGBYTES').toString('base64');
    const res = await makeAttachToTicketHandler(client)({
      ticketKey: 'ACME-1', filename: 'logo.png', contentBase64: base64, embed: true,
    });
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.body).toMatchObject({
      description: 'existing body\n\n![logo.png](/attachments/att1)',
    });
    expect(res.structuredContent).toMatchObject({ embedded: true });
  });

  it('refuses an empty base64 payload', async () => {
    await expect(
      makeAttachToTicketHandler(client)({
        ticketKey: 'ACME-1', filename: 'empty.txt', contentBase64: '',
      }),
    ).rejects.toThrow();
  });

  it('honors a custom altText', async () => {
    makeFetchMock([
      { json: PROJ },
      { json: TICKET },
      { json: ATTACHMENT },
    ]);
    const base64 = Buffer.from('PNGBYTES').toString('base64');
    const res = await makeAttachToTicketHandler(client)({
      ticketKey: 'ACME-1', filename: 'logo.png', contentBase64: base64,
      altText: 'Brand mark for Orboto',
    });
    expect(res.structuredContent).toMatchObject({
      markdown: '![Brand mark for Orboto](/attachments/att1)',
    });
  });
});

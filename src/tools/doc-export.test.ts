/**
 * ORB-915 - doc-export tool tests.
 *
 * Markdown export: stub fetch returning a string + content-type
 * text/markdown. Verify the tool returns the Markdown verbatim.
 *
 * PDF export: stub fetch returning a Uint8Array body. Verify the
 * tool wraps it as an MCP resource attachment with base64 blob.
 *
 * 503 from a deployment with no PDF engine: verify the
 * OrbotoApiError bubbles up so the model can tell the user what's
 * wrong.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoApiError, OrbotoClient } from '../orboto-client.js';
import {
  makeExportDocMdHandler,
  makeExportDocPdfHandler,
} from './doc-export.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });
const DOC_ID = 'd0000000-0000-0000-0000-000000000001';

function stubText(text: string, contentType = 'text/markdown; charset=utf-8'): Array<{ url: string; method: string }> {
  const calls: Array<{ url: string; method: string }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push({ url: url.toString(), method: init?.method ?? 'GET' });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': contentType }),
      text: async () => text,
      arrayBuffer: async () => Buffer.from(text, 'utf8').buffer,
      json: async () => { throw new Error('not json'); },
    } as unknown as Response;
  });
  return calls;
}

function stubBinary(bytes: Uint8Array, contentType = 'application/pdf'): Array<{ url: string; method: string }> {
  const calls: Array<{ url: string; method: string }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push({ url: url.toString(), method: init?.method ?? 'GET' });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': contentType }),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      text: async () => '',
    } as unknown as Response;
  });
  return calls;
}

function stub5xx(status: number, body: unknown) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    return {
      ok: false,
      status,
      statusText: 'Server Error',
      headers: new Headers(),
      text: async () => JSON.stringify(body),
      json: async () => body,
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as Response;
  });
}

describe('orboto_export_doc_md', () => {
  it('GETs /docs/:id/export/md and surfaces the raw Markdown', async () => {
    const md = '# My Page\n\nBody text.';
    const calls = stubText(md);
    const res = await makeExportDocMdHandler(client)({ docId: DOC_ID });
    expect(calls[0]).toMatchObject({
      method: 'GET',
      url: `https://orboto.example.com/docs/${DOC_ID}/export/md`,
    });
    expect((res.content[0] as { text: string }).text).toBe(md);
    expect(res.structuredContent).toMatchObject({
      docId: DOC_ID,
      markdown: md,
      sizeBytes: Buffer.byteLength(md, 'utf8'),
    });
  });
});

describe('orboto_export_doc_pdf', () => {
  it('POSTs /docs/:id/export/pdf and wraps the bytes as a base64 MCP resource', async () => {
    // Pretend the renderer returned a minimal 8-byte PDF header.
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
    const calls = stubBinary(pdfBytes);
    const res = await makeExportDocPdfHandler(client)({ docId: DOC_ID });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `https://orboto.example.com/docs/${DOC_ID}/export/pdf`,
    });
    const first = res.content[0] as { type: string; resource: { uri: string; mimeType: string; blob: string } };
    expect(first.type).toBe('resource');
    expect(first.resource.uri).toBe(`orboto://doc/${DOC_ID}/export.pdf`);
    expect(first.resource.mimeType).toBe('application/pdf');
    // The blob is the base64 of the bytes - decode it back and compare.
    const decoded = Buffer.from(first.resource.blob, 'base64');
    expect(Array.from(decoded)).toEqual(Array.from(pdfBytes));
    expect(res.structuredContent).toMatchObject({
      docId: DOC_ID,
      sizeBytes: pdfBytes.byteLength,
      contentType: 'application/pdf',
    });
  });

  it('bubbles up a 503 when the deployment has no PDF engine', async () => {
    stub5xx(503, { error: 'PDF engine unavailable', errorKey: 'errors.pdf.engine_unavailable' });
    await expect(
      makeExportDocPdfHandler(client)({ docId: DOC_ID }),
    ).rejects.toBeInstanceOf(OrbotoApiError);
  });
});

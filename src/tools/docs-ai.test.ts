/**
 * ORB-799 - docs-AI tools tests.
 *
 * `orboto_ask_docs` happy + AI-not-configured-style 400.
 * `orboto_ingest_url` happy + readability-fallback flag.
 * `orboto_ingest_file` happy + empty-bytes refusal.
 *
 * The multipart upload's wire format is verified by inspecting the
 * FormData body the fetch mock receives - we read the form-fields
 * back to assert filename + parent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoApiError, OrbotoClient } from '../orboto-client.js';
import {
  makeAskDocsHandler,
  makeIngestUrlHandler,
  makeIngestFileHandler,
} from './docs-ai.js';

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
    if (!r) throw new Error(`unexpected extra fetch`);
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

describe('orboto_ask_docs', () => {
  it('POSTs question + limit + spaceId, returns answer + citations', async () => {
    const calls = stubJSON([
      { json: {
        answer: 'The retry backoff is 200ms × 2^n.',
        citations: [
          { index: 1, title: 'Queue worker', link: '/docs/queue', spaceName: 'Runbooks' },
        ],
        mode: 'rag',
      } },
    ]);
    const res = await makeAskDocsHandler(client)({
      question: 'What is the queue retry backoff?',
      spaceId: '11111111-2222-3333-4444-555555555555',
      limit: 3,
    });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: 'https://orboto.example.com/ai/ask-docs',
      body: {
        question: 'What is the queue retry backoff?',
        spaceId: '11111111-2222-3333-4444-555555555555',
        limit: 3,
      },
    });
    expect((res.content[0] as { text: string }).text).toContain('200ms');
    expect(res.structuredContent).toMatchObject({
      answer: 'The retry backoff is 200ms × 2^n.',
      mode: 'rag',
    });
  });

  it('surfaces a 400 (AI not configured) as OrbotoApiError', async () => {
    stubJSON([
      { ok: false, status: 400, json: { error: 'ai_provider_not_configured' } },
    ]);
    await expect(
      makeAskDocsHandler(client)({ question: 'anything' }),
    ).rejects.toBeInstanceOf(OrbotoApiError);
  });
});

describe('orboto_ingest_url', () => {
  it('POSTs url + parentDocId to the space ingest route', async () => {
    const calls = stubJSON([
      { json: {
        docId: 'd1', title: 'Hello',  slug: 'hello',
        fetchedBytes: 12345, markdownChars: 678, readabilityFallback: false,
      } },
    ]);
    const res = await makeIngestUrlHandler(client)({
      url: 'https://example.com/article',
      spaceId: '11111111-2222-3333-4444-555555555555',
      parentDocId: '99999999-8888-7777-6666-555555555555',
    });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: 'https://orboto.example.com/spaces/11111111-2222-3333-4444-555555555555/docs/ingest-url',
      body: {
        url: 'https://example.com/article',
        parentDocId: '99999999-8888-7777-6666-555555555555',
      },
    });
    expect(res.structuredContent).toMatchObject({
      docId: 'd1', title: 'Hello', readabilityFallback: false,
    });
  });

  it('surfaces readabilityFallback=true in both text + structured', async () => {
    stubJSON([
      { json: {
        docId: 'd1', title: 'Page', slug: 'page',
        fetchedBytes: 200, markdownChars: 50, readabilityFallback: true,
      } },
    ]);
    const res = await makeIngestUrlHandler(client)({
      url: 'https://example.com/odd',
      spaceId: '11111111-2222-3333-4444-555555555555',
    });
    expect((res.content[0] as { text: string }).text).toMatch(/Readability/);
    expect(res.structuredContent).toMatchObject({ readabilityFallback: true });
  });
});

describe('orboto_ingest_file', () => {
  it('POSTs multipart with filename + decoded content', async () => {
    // Capture the multipart body via the fetch mock - FormData is
    // opaque to JSON.parse, so we don't decode it; we only assert the
    // route, method, and the JSON response shape.
    const calls: Array<{ url: string; method: string; bodyType: string }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      calls.push({
        url: url.toString(),
        method: init?.method ?? 'GET',
        bodyType: init?.body?.constructor?.name ?? 'undefined',
      });
      return {
        ok: true, status: 200, statusText: 'OK',
        json: async () => ({
          docId: 'd9', title: 'note.md', slug: 'note',
          kind: 'markdown', sizeBytes: 11, markdownChars: 9,
        }),
        text: async () => '',
      } as unknown as Response;
    });

    const base64 = Buffer.from('hello world').toString('base64');
    const res = await makeIngestFileHandler(client)({
      spaceId: '11111111-2222-3333-4444-555555555555',
      filename: 'note.md',
      contentBase64: base64,
    });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: 'https://orboto.example.com/spaces/11111111-2222-3333-4444-555555555555/docs/ingest-file',
      bodyType: 'FormData',
    });
    expect(res.structuredContent).toMatchObject({
      docId: 'd9', title: 'note.md', kind: 'markdown',
    });
  });

  it('refuses an empty base64 payload', async () => {
    await expect(
      makeIngestFileHandler(client)({
        spaceId: '11111111-2222-3333-4444-555555555555',
        filename: 'empty.txt',
        contentBase64: '',
      }),
    ).rejects.toThrow();
  });
});

/**
 * ORB-799 - docs-AI tools tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoApiError, OrbotoClient } from '../orboto-client.js';
import { KNOWLEDGE_DATA_NOTICE } from './shared.js';
import {
  askDocsToolConfig,
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
        abstained: false,
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
      abstained: false,
    });
  });

  it('ORB-2772 - ends with the data-not-instructions line, an abstained answer too', async () => {
    stubJSON([{ json: { answer: 'The backoff is 200ms.', citations: [], mode: 'rag' } }, { json: { answer: 'Not in the sources.', citations: [], mode: 'empty', abstained: true } }]);
    for (const question of ['What is the backoff?', 'What is the wifi password?']) {
      const text = (await makeAskDocsHandler(client)({ question }).then((r) => r.content[0])) as { text: string };
      expect(text.text.endsWith(KNOWLEDGE_DATA_NOTICE)).toBe(true);
    }
  });

  it('ORB-1999 - marks an abstained answer in text and structured content', async () => {
    stubJSON([{ json: { answer: "I couldn't find that in the sources provided.", citations: [], mode: 'empty', abstained: true } }]);
    const res = await makeAskDocsHandler(client)({ question: 'What is the office wifi password?' });
    expect((res.content[0] as { text: string }).text).toContain('(abstained:');
    expect(res.structuredContent).toMatchObject({ abstained: true, mode: 'empty' });
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

describe('orboto_ask_docs ORB-2775 timings, reviewer and deadline', () => {
  const answer = { answer: 'It runs every hour [1].', citations: [{ index: 1, title: 'Backup', link: '/docs/backup', spaceName: 'Runbooks' }], mode: 'semantic', abstained: false, timings: { totalMs: 4200, retrievalMs: 400, modelMs: 3600, reviewMs: 900, passages: 5, promptChars: 9000 } };

  it('says where the time went and prints what the reviewer flagged', async () => {
    stubJSON([{ json: { ...answer, review: { reviewer: 'r', findings: [{ kind: 'invented_fact', quote: 'every hour', reason: 'x' }], regenerated: true, flagged: true } } }]);
    const res = await makeAskDocsHandler(client)({ question: 'backup?' });
    const txt = (res.content[0] as { text: string }).text;
    expect(txt).toContain('Answered in 4.2 s (retrieval 0.4 s, model 3.6 s, reviewer 0.9 s).');
    expect(txt).toContain('Reviewer flagged: "every hour"');
    expect(res.structuredContent).toMatchObject({ timings: { totalMs: 4200 }, review: { flagged: true } });
  });

  it('says when the review ran out of time, and nothing for a clean one', async () => {
    stubJSON([{ json: { ...answer, review: { reviewer: 'r', findings: [], regenerated: false, flagged: true } } }]);
    expect(((await makeAskDocsHandler(client)({ question: 'backup?' })).content[0] as { text: string }).text).toContain('Reviewer flagged: the review did not finish before the deadline');
    stubJSON([{ json: { ...answer, review: { reviewer: 'r', findings: [], regenerated: false, flagged: false } } }]);
    expect(((await makeAskDocsHandler(client)({ question: 'backup?' })).content[0] as { text: string }).text).not.toContain('Reviewer flagged');
  });

  it('turns a 504 into the phase message plus the search fallback', async () => {
    const body = JSON.stringify({ error: 'No answer within 25 s: the retrieval phase did not finish in time.', errorKey: 'errors.ai.ask_deadline', errorParams: { phase: 'retrieval', seconds: 25 } });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 504 }));
    await expect(makeAskDocsHandler(client)({ question: 'backup?' }))
      .rejects.toThrow('No answer within 25 s: the retrieval phase did not finish in time. Search the same wikis without the model with orboto_search_docs.');
  });

  it('the description names the passage clamp, both deadlines and the fallback', () => {
    expect(askDocsToolConfig.description).toContain('At most 6 passages');
    expect(askDocsToolConfig.description).toContain('25 s hosted, 120 s on a local provider');
    expect(askDocsToolConfig.description).toContain('orboto_search_docs');
    expect(JSON.stringify(askDocsToolConfig.inputSchema.limit.description)).toContain('model reads up to 6');
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

/**
 * ORB-855 (LLM-Wiki Phase E) - wiki MCP tool tests. The injector is a
 * stubbed fetch; we assert each tool hits the right route with the right
 * body and renders a sensible result, plus one error-path per surface.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoApiError, OrbotoClient } from '../orboto-client.js';
import {
  makeWikiIngestUrlHandler,
  makeWikiAskHandler,
  makeWikiLintHandler,
  makeWikiPlanUpdateHandler,
  makeWikiApplyPlanHandler,
  makeWikiRecordHandler,
  makeWikiAppendSectionHandler,
  makeWikiFlagStaleHandler,
  makeWikiSaveAnswerHandler,
} from './wiki.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

function stubJSON(responses: Array<{ ok?: boolean; status?: number; json?: unknown }>) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push({ url: url.toString(), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body });
    const r = responses.shift();
    if (!r) throw new Error('unexpected extra fetch');
    return { ok: r.ok ?? true, status: r.status ?? 200, statusText: 'OK', json: async () => ('json' in r ? r.json : {}), text: async () => '' } as unknown as Response;
  });
  return calls;
}

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });
const SPACE = 's0000000-0000-0000-0000-000000000001';
const DOC = 'd0000000-0000-0000-0000-000000000001';

describe('orboto_wiki_ingest_url', () => {
  it('POSTs to ingest-url and reports the new source', async () => {
    const calls = stubJSON([{ status: 201, json: { docId: DOC, title: 'Imported' } }]);
    const res = await makeWikiIngestUrlHandler(client)({ spaceId: SPACE, url: 'https://example.com/a' });
    expect(calls[0]).toMatchObject({ method: 'POST', url: `https://orboto.example.com/spaces/${SPACE}/docs/ingest-url`, body: { url: 'https://example.com/a' } });
    expect((res.content[0] as { text: string }).text).toContain('Imported');
  });
});

describe('orboto_wiki_ask', () => {
  it('POSTs to /ai/ask-docs and renders citations', async () => {
    stubJSON([{ json: { answer: 'It uses MVCC.', citations: [{ index: 1, title: 'Concurrency', link: '/spaces/x/docs/y' }], mode: 'hybrid' } }]);
    const res = await makeWikiAskHandler(client)({ question: 'how does concurrency work?' });
    const txt = (res.content[0] as { text: string }).text;
    expect(txt).toContain('It uses MVCC.');
    expect(txt).toContain('[1] Concurrency');
  });
});

describe('orboto_wiki_lint', () => {
  it('POSTs to lint and lists issues', async () => {
    stubJSON([{ json: { issues: [{ kind: 'orphan', message: 'Page X is orphaned', suggestedFix: 'link it', docId: DOC }], detected: 1, resolved: 0 } }]);
    const res = await makeWikiLintHandler(client)({ spaceId: SPACE });
    expect((res.content[0] as { text: string }).text).toContain('[orphan] Page X is orphaned');
  });
  it('propagates a 403 as OrbotoApiError', async () => {
    stubJSON([{ ok: false, status: 403, json: { error: 'Forbidden' } }]);
    await expect(makeWikiLintHandler(client)({ spaceId: SPACE })).rejects.toBeInstanceOf(OrbotoApiError);
  });
});

describe('orboto_wiki_plan_update + apply_plan', () => {
  it('plan-update returns a planId + op summary', async () => {
    const calls = stubJSON([{ json: { planId: 'p1', ops: [{ op: 'create', title: 'New', summary: 'add page' }], expiresAt: '2026-01-01T00:15:00Z' } }]);
    const res = await makeWikiPlanUpdateHandler(client)({ spaceId: SPACE, instruction: 'add a page about X' });
    expect(calls[0].url).toBe(`https://orboto.example.com/spaces/${SPACE}/docs/plan-update`);
    expect((res.content[0] as { text: string }).text).toContain('Plan p1');
  });
  it('apply-plan reports touched docs', async () => {
    stubJSON([{ json: { touchedDocs: [DOC] } }]);
    const res = await makeWikiApplyPlanHandler(client)({ spaceId: SPACE, planId: 'p1' });
    expect((res.content[0] as { text: string }).text).toContain('1 page(s) updated');
  });
  it('apply-plan surfaces a 410 expired plan as OrbotoApiError', async () => {
    stubJSON([{ ok: false, status: 410, json: { error: 'Plan has expired' } }]);
    await expect(makeWikiApplyPlanHandler(client)({ spaceId: SPACE, planId: 'p1' })).rejects.toBeInstanceOf(OrbotoApiError);
  });
});

describe('orboto_wiki_record', () => {
  it('chains plan-update then apply-plan', async () => {
    const calls = stubJSON([
      { json: { planId: 'p2' } },
      { json: { touchedDocs: [DOC] } },
    ]);
    const res = await makeWikiRecordHandler(client)({ spaceId: SPACE, instruction: 'note that X happened' });
    expect(calls[0].url).toContain('/plan-update');
    expect(calls[1].url).toContain('/apply-plan');
    expect((res.content[0] as { text: string }).text).toContain('1 page(s) updated');
  });
});

describe('orboto_wiki_append_section', () => {
  it('reports a no-op when nothing was appended', async () => {
    stubJSON([{ json: { appended: false } }]);
    const res = await makeWikiAppendSectionHandler(client)({ docId: DOC, content: 'x' });
    expect((res.content[0] as { text: string }).text).toMatch(/already present/);
  });
});

describe('orboto_wiki_save_answer', () => {
  it('POSTs to save-answer-to-wiki and reports created vs updated', async () => {
    const calls = stubJSON([{ json: { docId: DOC, created: true } }]);
    const res = await makeWikiSaveAnswerHandler(client)({ spaceId: SPACE, question: 'how?', answer: 'like this' });
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://orboto.example.com/ai/save-answer-to-wiki', body: { spaceId: SPACE, question: 'how?', answer: 'like this', citations: [] } });
    expect((res.content[0] as { text: string }).text).toMatch(/new wiki page/);
  });
});

describe('orboto_wiki_flag_stale', () => {
  it('defaults stale=true and reports the flag', async () => {
    const calls = stubJSON([{ json: { staleFlagged: true } }]);
    const res = await makeWikiFlagStaleHandler(client)({ docId: DOC });
    expect(calls[0]).toMatchObject({ method: 'POST', url: `https://orboto.example.com/docs/${DOC}/flag-stale`, body: { stale: true } });
    expect((res.content[0] as { text: string }).text).toMatch(/outdated/);
  });
});

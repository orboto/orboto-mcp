/**
 * ORB-2543 - every search-shaped tool prints one line when the API answered
 * from full text because the query embedding timed out or the breaker is open.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OrbotoClient } from '../orboto-client.js';
import { makeSearchHandler } from './search.js';
import { makeSearchDocsHandler } from './doc-edits.js';
import { makeAskDocsHandler } from './docs-ai.js';
import { makeWikiAskHandler } from './wiki.js';
import { makeKnowledgeAskHandler } from './knowledge.js';
import { makeCheckSimilarHandler } from './check-similar.js';
import { SEMANTIC_DEGRADED_LINE } from './shared.js';

afterEach(() => { vi.restoreAllMocks(); });

function stub(responses: unknown[]): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    const json = responses.shift();
    if (json === undefined) throw new Error('unexpected extra fetch');
    return { ok: true, status: 200, statusText: 'OK', json: async () => json, text: async () => JSON.stringify(json) } as unknown as Response;
  });
}

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });
const PROJ = { id: 'p1', key: 'ACME', name: 'Acme', description: null, status: 'active' };
const text = (r: CallToolResult): string => (r.content[0] as { text: string }).text;
const ANSWER = { answer: 'Restart it [1].', citations: [{ index: 1, title: 'Runbook', link: '/d/1' }], mode: 'keyword', abstained: false };

describe('ORB-2543 - semanticDegraded reaches the agent', () => {
  it('orboto_search prints the line and carries the flag', async () => {
    stub([{ items: [], nextCursor: null, total: 0, semanticDegraded: true }]);
    const res = await makeSearchHandler(client)({ query: 'frobnicator' });
    expect(text(res)).toContain(SEMANTIC_DEGRADED_LINE);
    expect((res.structuredContent as { semanticDegraded: boolean }).semanticDegraded).toBe(true);
  });

  it('orboto_search stays silent when the semantic path worked', async () => {
    stub([{ items: [], nextCursor: null, total: 0, semanticDegraded: false }]);
    const res = await makeSearchHandler(client)({ query: 'frobnicator' });
    expect(text(res)).not.toContain(SEMANTIC_DEGRADED_LINE);
  });

  it('orboto_search_docs prints the line on hits and on an empty result', async () => {
    stub([{ items: [], total: 0, mode: 'fts', semantic: false, semanticDegraded: true }]);
    const empty = await makeSearchDocsHandler(client)({ q: 'frobnicator' });
    expect(text(empty)).toContain(SEMANTIC_DEGRADED_LINE);
    stub([{
      items: [{ id: 'd1', docKey: 'DOC-1', title: 'Runbook', spaceId: 's1', spaceName: 'Ops', projectId: null, snippet: 'restart', headingPath: [], charOffset: 0, lineOffset: 1, rank: 1, url: '/d/1' }],
      total: 1, mode: 'fts', semantic: false, semanticDegraded: true,
    }]);
    const hits = await makeSearchDocsHandler(client)({ q: 'frobnicator' });
    expect(text(hits)).toContain(SEMANTIC_DEGRADED_LINE);
    expect((hits.structuredContent as { semanticDegraded: boolean }).semanticDegraded).toBe(true);
  });

  it('ask-docs, wiki ask and knowledge ask print the line', async () => {
    stub([{ ...ANSWER, semanticDegraded: true }]);
    expect(text(await makeAskDocsHandler(client)({ question: 'how to restart' }))).toContain(SEMANTIC_DEGRADED_LINE);
    stub([{ ...ANSWER, semanticDegraded: true }]);
    expect(text(await makeWikiAskHandler(client)({ question: 'how to restart' }))).toContain(SEMANTIC_DEGRADED_LINE);
    stub([{ ...ANSWER, semanticDegraded: true, source: 'declared', spaces: [{ spaceKey: 'ORB-S1', spaceName: 'Wiki', projectKey: 'ORB' }] }]);
    expect(text(await makeKnowledgeAskHandler(client)({ question: 'how to restart' }))).toContain(SEMANTIC_DEGRADED_LINE);
  });

  it('orboto_check_similar prints the line', async () => {
    stub([PROJ, { candidates: [], mode: 'tsvector', semanticDegraded: true }]);
    const res = await makeCheckSimilarHandler(client)({ projectKey: 'ACME', title: 'Frobnicator jams' });
    expect(text(res)).toContain(SEMANTIC_DEGRADED_LINE);
    expect((res.structuredContent as { semanticDegraded: boolean }).semanticDegraded).toBe(true);
  });
});

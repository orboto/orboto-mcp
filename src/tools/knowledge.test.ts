import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OrbotoClient } from '../orboto-client.js';
import { OrbotoApiError, OrbotoClient as RealClient } from '../orboto-client.js';
import { knowledgeAddToolConfig, knowledgeAskToolConfig, makeKnowledgeAddHandler, makeKnowledgeAskHandler } from './knowledge.js';
import { KNOWLEDGE_BLOCK_CHARS, knowledgeLines, makeSessionStartHandler } from './session-start.js';
import { makeResponseExpandHandler } from './response-expand.js';
import { makeWikiRunsHandler } from './wiki.js';

function textOf(result: { content: unknown[] }): string {
  return (result.content[0] as { text: string }).text;
}

afterEach(() => { vi.restoreAllMocks(); });

describe('ORB-2225 orboto_knowledge_ask and orboto_knowledge_add', () => {
  it('asks the scope and lists the cited docs and the asked spaces', async () => {
    const post = vi.fn().mockResolvedValue({
      answer: 'Nightly with restic [1].', citations: [{ index: 1, title: 'Backup chain', link: '/spaces/s/docs/d' }], mode: 'keyword', abstained: false,
      source: 'session', spaces: [{ spaceKey: 'ACME-S1', spaceName: 'ACME', projectKey: 'ACME' }, { spaceKey: 'SPACE-3', spaceName: 'Operations', projectKey: null }],
    });
    const result = await makeKnowledgeAskHandler({ post } as unknown as OrbotoClient)({ question: 'where does the backup run?' }, { sessionId: 'abc' });
    expect(post).toHaveBeenCalledWith('/knowledge/ask', { question: 'where does the backup run?' }, { instanceToken: 'mcp-abc' });
    expect(textOf(result)).toContain('[1] Backup chain - /spaces/s/docs/d');
    expect(textOf(result)).toContain('Asked: ACME-S1, SPACE-3.');
  });

  it('ORB-2775 - says where the time went and turns a deadline into the phase plus the search fallback', async () => {
    const post = vi.fn().mockResolvedValue({
      answer: 'Nightly [1].', citations: [], mode: 'semantic', abstained: false, source: 'session', spaces: [{ spaceKey: 'ACME-S1', spaceName: 'ACME', projectKey: 'ACME' }],
      timings: { totalMs: 4200, retrievalMs: 400, modelMs: 3600, reviewMs: 0, passages: 5, promptChars: 9000 },
    });
    const result = await makeKnowledgeAskHandler({ post } as unknown as OrbotoClient)({ question: 'backup?' });
    expect(textOf(result)).toContain('Asked: ACME-S1 in 4.2 s (retrieval 0.4 s, model 3.6 s).');
    const body = JSON.stringify({ error: 'No answer within 25 s: the model phase did not finish in time.', errorKey: 'errors.ai.ask_deadline', errorParams: { phase: 'model', seconds: 25 } });
    const failing = vi.fn().mockRejectedValue(new OrbotoApiError(504, body, '/knowledge/ask'));
    await expect(makeKnowledgeAskHandler({ post: failing } as unknown as OrbotoClient)({ question: 'backup?' }))
      .rejects.toThrow('No answer within 25 s: the model phase did not finish in time. Search the same wikis without the model with orboto_search_docs.');
  });

  it('ORB-2775 - prints what the reviewer flagged as its own line and says when the review ran out of time', async () => {
    const base = { answer: 'It runs every hour [1].', citations: [], mode: 'semantic', abstained: false, source: 'session', spaces: [{ spaceKey: 'ACME-S1', spaceName: 'ACME', projectKey: 'ACME' }] };
    const ask = async (review: unknown) => textOf(await makeKnowledgeAskHandler({ post: vi.fn().mockResolvedValue({ ...base, review }) } as unknown as OrbotoClient)({ question: 'backup?' }));
    const flagged = { reviewer: 'r', findings: [{ kind: 'invented_fact', quote: 'every hour', reason: 'x' }, { kind: 'inference', quote: 'runs', reason: 'y' }], regenerated: true, flagged: true };
    expect(await ask(flagged)).toContain('Reviewer flagged: "every hour"');
    expect(await ask(flagged)).not.toContain('"runs"');
    expect(await ask({ reviewer: 'r', findings: [], regenerated: false, flagged: true })).toContain('Reviewer flagged: the review did not finish before the deadline');
    expect(await ask({ reviewer: 'r', findings: [], regenerated: false, flagged: false })).not.toContain('Reviewer flagged');
    expect(await ask(null)).not.toContain('Reviewer flagged');
    const result = await makeKnowledgeAskHandler({ post: vi.fn().mockResolvedValue({ ...base, review: flagged }) } as unknown as OrbotoClient)({ question: 'backup?' });
    expect(result.structuredContent).toMatchObject({ review: { flagged: true } });
  });

  it('ORB-2775 - the description names the passage clamp and both deadlines', () => {
    expect(knowledgeAskToolConfig.description).toContain('At most 6 passages');
    expect(knowledgeAskToolConfig.description).toContain('25 s hosted, 120 s on a local provider');
    expect(knowledgeAskToolConfig.description).toContain('Reviewer flagged');
  });

  it('files a fact and returns the server sentence naming where it landed', async () => {
    const post = vi.fn().mockResolvedValue({ action: 'recorded', text: 'Recorded in the ACME-S1 wiki: ACME-D7 "Build host". Cite it by key.', pages: [], source: null });
    const result = await makeKnowledgeAddHandler({ post } as unknown as OrbotoClient)({ title: 'Build host', content: 'build.example.org', projectKey: 'ACME' });
    expect(post.mock.calls[0][0]).toBe('/knowledge/add');
    expect(textOf(result)).toContain('ACME-D7');
    expect(result.structuredContent).toMatchObject({ action: 'recorded' });
  });

  it('files a fact and lists the ops the wiki agent dropped, as wiki record does', async () => {
    const droppedOps = [{ title: 'Runner', target: 'ACME-D99', reason: 'unknown_target' }];
    const post = vi.fn().mockResolvedValue({ action: 'recorded', text: 'Recorded in the ACME-S1 wiki: ACME-D7 "Build host". Cite it by key.', pages: [], source: null, droppedOps });
    const result = await makeKnowledgeAddHandler({ post } as unknown as OrbotoClient)({ title: 'Build host', content: 'build.example.org', projectKey: 'ACME' });
    expect(textOf(result)).toContain('Ops dropped: 1');
    expect(textOf(result)).toContain('- Runner (target ACME-D99): unknown_target');
    expect(result.structuredContent).toMatchObject({ droppedOps });
  });

  it('ORB-2468 - a repeated add returns the first request it answered with, nothing filed again', async () => {
    const duplicate = { of: 'ingesting', requestedAt: '2026-10-16T08:00:00Z', run: { id: '44444444-0000-4000-8000-000000000000', status: 'pending_review' } };
    const post = vi.fn().mockResolvedValue({ action: 'duplicate', duplicate, text: 'Already ingesting as source ACME-D9 "Runner notes" in the ACME-S1 wiki (/s/d, run 44444444-0000-4000-8000-000000000000 pending_review); not filed again.', pages: [], source: { id: 'd9', key: 'ACME-D9', title: 'Runner notes', webUrl: '/s/d' }, droppedOps: [] });
    const result = await makeKnowledgeAddHandler({ post } as unknown as OrbotoClient)({ title: 'Runner notes', content: 'x', projectKey: 'ACME' });
    expect(post).toHaveBeenCalledTimes(1);
    expect(textOf(result)).toContain('Already ingesting as source ACME-D9');
    expect(result.structuredContent).toMatchObject({ action: 'duplicate', duplicate });
  });

  it('both tools carry a title and annotations; ask is read-only, add is not', () => {
    expect(knowledgeAskToolConfig.title).toBeTruthy();
    expect(knowledgeAskToolConfig.annotations.readOnlyHint).toBe(true);
    expect(knowledgeAddToolConfig.title).toBeTruthy();
    expect(knowledgeAddToolConfig.annotations.readOnlyHint).toBe(false);
  });
});

describe('ORB-2225 the Knowledge block of orboto_session_start', () => {
  it('prints the block from GET /knowledge with the session header', async () => {
    const seen: Array<{ path: string; session: string | null }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = new URL(url.toString());
      const headers = new Headers(init?.headers);
      seen.push({ path: u.pathname, session: headers.get('x-orboto-agent-session') });
      const body = u.pathname === '/agent-instructions' ? { instructions: 'claim -> commit -> close', rulesHash: 'fixture' } : u.pathname === '/knowledge'
        ? { source: 'session', spaces: [{ spaceKey: 'ACME-S1', spaceName: 'ACME', projectKey: 'ACME', pages: 3, sources: 1, openLintIssues: 0, indexDoc: { key: 'ACME-D1' } }], missing: [], text: '## Knowledge\nIndex ACME-D1:\n- Build host' }
        : {};
      return { ok: true, status: 200, statusText: 'OK', json: async () => body, text: async () => '' } as unknown as Response;
    });
    const client = new RealClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });
    const result = await makeSessionStartHandler(client)({}, { sessionId: 'k1' });
    expect(seen.find((c) => c.path === '/knowledge')?.session).toBe('mcp-k1');
    expect(textOf(result)).toContain('## Knowledge\nIndex ACME-D1:\n- Build host');
    expect(result.structuredContent).toMatchObject({ knowledge: { source: 'session', spaces: [{ spaceKey: 'ACME-S1', indexDocKey: 'ACME-D1', pages: 3 }] } });
  });

  it('cuts a long block at a line and serves the rest through a handle', async () => {
    const text = ['## Knowledge', ...Array.from({ length: 200 }, (_, i) => `- ACME-D${i} Page ${i}`)].join('\n');
    const block = knowledgeLines(text);
    expect(block.lines.join('\n').length).toBeLessThan(KNOWLEDGE_BLOCK_CHARS + 200);
    expect(block.lines.at(-1)).toContain(`handle: "${block.handle}"`);
    const expanded = await makeResponseExpandHandler()({ handle: block.handle!, path: 'knowledge' });
    expect(textOf(expanded)).toContain('- ACME-D199 Page 199');
  });
});

describe('ORB-2225 orboto_wiki_runs', () => {
  it('lists the failed runs with their error and retries one by id', async () => {
    const get = vi.fn().mockResolvedValue({ runs: [{ id: 'r1', sourceKey: 'ACME-D9', sourceTitle: 'Runner notes', status: 'failed', error: 'answer budget spent', createdAt: '2026-09-27T08:00:00Z' }] });
    const post = vi.fn().mockResolvedValue({ runId: 'r1', status: 'applied', queued: false, error: null });
    const handler = makeWikiRunsHandler({ get, post } as unknown as OrbotoClient);
    expect(textOf(await handler({ spaceId: 'ACME-S1', status: 'failed' }))).toContain('r1 failed ACME-D9 "Runner notes" 2026-09-27T08:00:00Z - answer budget spent');
    expect(get).toHaveBeenCalledWith('/spaces/ACME-S1/llm-wiki/ingest-runs?status=failed');
    expect((await handler({ spaceId: 'ACME-S1', action: 'retry' })).isError).toBe(true);
    expect(textOf(await handler({ spaceId: 'ACME-S1', action: 'retry', runId: '11111111-0000-4000-8000-000000000000' }))).toContain('ran again: applied');
    expect(post).toHaveBeenCalledWith('/spaces/ACME-S1/llm-wiki/ingest-runs/11111111-0000-4000-8000-000000000000/retry', {});
  });

  it('ORB-2226 - a run that left planner ops out says how many', async () => {
    const get = vi.fn().mockResolvedValue({ runs: [{ id: 'r2', sourceKey: 'ACME-D10', sourceTitle: 'Deploy notes', status: 'applied', error: null, droppedOps: [{ title: 'Deploy', target: 'ACME-D99', reason: 'unknown_target' }], createdAt: '2026-09-27T09:00:00Z' }] });
    const handler = makeWikiRunsHandler({ get, post: vi.fn() } as unknown as OrbotoClient);
    expect(textOf(await handler({ spaceId: 'ACME-S1' }))).toContain('r2 applied ACME-D10 "Deploy notes" 2026-09-27T09:00:00Z (ops dropped: 1)');
  });

  it('ORB-2611 - a queued run says how long it waits or runs and whether it stalled', async () => {
    const get = vi.fn().mockResolvedValue({ runs: [
      { id: 'r3', sourceKey: 'ACME-D11', sourceTitle: 'AGENTS.md study', status: 'queued', error: null, createdAt: '2026-10-20T15:53:33Z', startedAt: null, ageSeconds: 1260, stalled: true },
      { id: 'r4', sourceKey: 'ACME-D12', sourceTitle: 'Context rules', status: 'queued', error: null, createdAt: '2026-10-20T15:53:33Z', queuedAt: '2026-10-20T15:53:33Z', startedAt: '2026-10-20T16:03:33Z', ageSeconds: 780, stalled: false },
    ] });
    const handler = makeWikiRunsHandler({ get, post: vi.fn() } as unknown as OrbotoClient);
    const text = textOf(await handler({ spaceId: 'ACME-S1', status: 'queued' }));
    expect(get).toHaveBeenCalledWith('/spaces/ACME-S1/llm-wiki/ingest-runs?status=queued');
    expect(text).toContain('r3 queued (waiting 21 min, stalled) ACME-D11');
    expect(text).toContain('r4 queued (running 3 min) ACME-D12');
  });
});

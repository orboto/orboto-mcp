import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { OrbotoClient } from '../orboto-client.js';
import { OrbotoApiError, OrbotoClient as RealClient } from '../orboto-client.js';
import { knowledgeAddToolConfig, knowledgeAskToolConfig, knowledgeFindToolConfig, makeKnowledgeAddHandler, makeKnowledgeAskHandler, makeKnowledgeFindHandler } from './knowledge.js';
import { KNOWLEDGE_BLOCK_CHARS, knowledgeLines, makeSessionStartHandler } from './session-start.js';
import { makeResponseExpandHandler } from './response-expand.js';
import { makeWikiRunsHandler } from './wiki.js';

function textOf(result: { content: unknown[] }): string {
  return (result.content[0] as { text: string }).text;
}

afterEach(() => { vi.restoreAllMocks(); });

describe('ORB-2766 orboto_knowledge_find', () => {
  it('asks for strict hits by default and lists key, title and one plain snippet line', async () => {
    const get = vi.fn().mockResolvedValue({
      items: [{ id: 'd1', docKey: 'ACME-D37', title: 'Release procedure', snippet: 'tag the <mark>commit</mark>\n then roll out' }],
      total: 1, source: 'session', strict: true, spaces: [{ spaceKey: 'ACME-S1', spaceName: 'ACME', projectKey: 'ACME' }],
    });
    const result = await makeKnowledgeFindHandler({ get } as unknown as OrbotoClient)({ q: 'roll out the release' }, { sessionId: 'abc' });
    expect(get).toHaveBeenCalledWith('/knowledge/find?q=roll+out+the+release&strict=true', { instanceToken: 'mcp-abc' });
    expect(textOf(result)).toContain('- ACME-D37 Release procedure: tag the commit then roll out');
    expect(textOf(result)).toContain('Searched: ACME-S1.');
  });

  it('passes strict false, the projects and the limit, and says when nothing matched', async () => {
    const get = vi.fn().mockResolvedValue({ items: [], total: 0, source: 'explicit', strict: true, spaces: [{ spaceKey: 'SPACE-3', spaceName: 'Operations', projectKey: null }] });
    const result = await makeKnowledgeFindHandler({ get } as unknown as OrbotoClient)({ q: 'weiter', projectKeys: ['ACME', 'OPS'], limit: 5 });
    expect(textOf(result)).toContain('No strict hit in SPACE-3.');
    await makeKnowledgeFindHandler({ get } as unknown as OrbotoClient)({ q: 'backup', strict: false });
    expect(get.mock.calls.map((c) => c[0])).toEqual(['/knowledge/find?q=weiter&strict=true&projectKeys=ACME%2COPS&limit=5', '/knowledge/find?q=backup&strict=false']);
    expect(knowledgeFindToolConfig.annotations).toEqual({ readOnlyHint: true, idempotentHint: true });
  });
});

describe('ORB-2840 orboto_knowledge_find token budget', () => {
  it('passes the budget, bounds it in the schema and says how many hits it left out', async () => {
    const get = vi.fn().mockResolvedValue({
      items: [{ id: 'd1', docKey: 'ACME-D37', title: 'Release procedure', snippet: 'tag the commit' }], total: 1, source: 'session', strict: true,
      spaces: [{ spaceKey: 'ACME-S1', spaceName: 'ACME', projectKey: 'ACME' }], budget: { tokens: 200, used: 40, trimmed: 0, dropped: 2 },
    });
    const result = await makeKnowledgeFindHandler({ get } as unknown as OrbotoClient)({ q: 'roll out the release', tokenBudget: 200 });
    expect(get.mock.calls[0][0]).toBe('/knowledge/find?q=roll+out+the+release&strict=true&tokenBudget=200');
    expect(textOf(result)).toContain('2 more hit(s) left out by the 200-token budget');
    const schema = z.object(knowledgeFindToolConfig.inputSchema);
    expect(schema.safeParse({ q: 'x', tokenBudget: 99 }).success).toBe(false);
    expect(schema.safeParse({ q: 'x', tokenBudget: 4001 }).success).toBe(false);
    expect(schema.safeParse({ q: 'x', tokenBudget: 4000 }).success).toBe(true);
  });
});

describe('ORB-2766 orboto_knowledge_find without a query embedding', () => {
  it('says why a strict find is empty when the answer carries no query embedding, and stays quiet when the field is absent', async () => {
    const answer = { items: [], total: 0, source: 'session', strict: true, spaces: [{ spaceKey: 'ACME-S1', spaceName: 'ACME', projectKey: 'ACME' }] };
    const get = vi.fn().mockResolvedValueOnce({ ...answer, semantic: false }).mockResolvedValueOnce({ ...answer, semantic: true }).mockResolvedValueOnce(answer);
    const find = makeKnowledgeFindHandler({ get } as unknown as OrbotoClient);
    expect(textOf(await find({ q: 'roll out the release' }))).toContain('no query embedding (no provider, breaker open or too slow)');
    expect(textOf(await find({ q: 'roll out the release' }))).not.toContain('no query embedding');
    expect(textOf(await find({ q: 'roll out the release' }))).not.toContain('no query embedding');
  });
});

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

  it('ORB-2807 - a fact whose plan was late comes back as a filed source with the pending step in the structured answer', async () => {
    const pending = { step: 'ingest', reason: 'plan_deadline', deadlineSeconds: 15 };
    const post = vi.fn().mockResolvedValue({ action: 'ingesting', pending, text: 'Filed as source ACME-D9 "Runner notes" in the ACME-S1 wiki (/s/d); the wiki agent\'s plan did not finish within 15 s, so the ingest worker curates it into wiki pages within minutes.', pages: [], source: { id: 'd9', key: 'ACME-D9', title: 'Runner notes', webUrl: '/s/d' }, droppedOps: [] });
    const result = await makeKnowledgeAddHandler({ post } as unknown as OrbotoClient)({ title: 'Runner notes', content: 'x', projectKey: 'ACME' });
    expect(textOf(result)).toContain('did not finish within 15 s');
    expect(result.structuredContent).toMatchObject({ action: 'ingesting', pending });
    expect(knowledgeAddToolConfig.description).toContain('structuredContent.pending');
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

  it('ORB-2802 - lists a stale re-ingest with its page and a reviewed run with its decision, and shows a plan as a diff', async () => {
    const run = '11111111-0000-4000-8000-000000000000';
    const get = vi.fn()
      .mockResolvedValueOnce({ runs: [
        { id: 'r5', kind: 'stale_reingest', target: { key: 'ACME-D3', title: 'Hosts' }, canReview: true, sourceKey: 'ACME-D20', sourceTitle: 'Infra change', status: 'pending_review', error: null, createdAt: '2026-11-03T08:00:00Z' },
        { id: 'r6', kind: 'ingest', target: null, review: { decision: 'rejected', byName: 'Dana', reason: 'outdated' }, sourceKey: 'ACME-D21', sourceTitle: 'Old notes', status: 'rejected', error: null, createdAt: '2026-11-03T09:00:00Z' },
      ] })
      .mockResolvedValueOnce({
        run: { id: run, kind: 'stale_reingest', target: { key: 'ACME-D3', title: 'Hosts' }, canReview: true, sourceKey: 'ACME-D20', sourceTitle: 'Infra change', status: 'pending_review', error: null, createdAt: '2026-11-03T08:00:00Z' },
        logLine: 'stale re-ingest of ACME-D3',
        ops: [{ action: 'supersede', title: 'Hosts', summary: '', target: { key: 'ACME-D3', title: 'Hosts', missing: false }, removed: 'The host is atlas.', added: 'The host is zephyr.' }],
        sources: [{ key: 'ACME-D20', title: 'Infra change' }],
      });
    const handler = makeWikiRunsHandler({ get, post: vi.fn() } as unknown as OrbotoClient);
    const list = textOf(await handler({ spaceId: 'ACME-S1', status: 'pending_review' }));
    expect(get).toHaveBeenCalledWith('/spaces/ACME-S1/llm-wiki/ingest-runs?status=pending_review');
    expect(list).toContain('r5 pending_review stale re-ingest of ACME-D3 "Hosts" from ACME-D20 "Infra change"');
    expect(list).toContain('(apply or reject)');
    expect(list).toContain('r6 rejected (rejected by Dana: outdated) ACME-D21');
    const shown = textOf(await handler({ spaceId: 'ACME-S1', action: 'show', runId: run }));
    expect(get).toHaveBeenLastCalledWith(`/spaces/ACME-S1/llm-wiki/ingest-runs/${run}`);
    expect(shown).toContain('supersede "Hosts" -> ACME-D3 "Hosts"\n- The host is atlas.\n+ The host is zephyr.');
    expect(shown).toContain('Sources: ACME-D20');
  });

  it('ORB-2802 - applies a pending run with an optional note and rejects one only with a reason', async () => {
    const run = '11111111-0000-4000-8000-000000000000';
    const post = vi.fn()
      .mockResolvedValueOnce({ runId: run, status: 'applied', pages: ['Runner', 'Signing'], error: null })
      .mockResolvedValueOnce({ runId: run, status: 'rejected', reason: 'outdated' });
    const handler = makeWikiRunsHandler({ get: vi.fn(), post } as unknown as OrbotoClient);
    expect(textOf(await handler({ spaceId: 'ACME-S1', action: 'apply', runId: run, reason: ' ok ' }))).toBe(`Run ${run} applied: 2 pages (Runner, Signing).`);
    expect(post).toHaveBeenCalledWith(`/spaces/ACME-S1/llm-wiki/ingest-runs/${run}/apply`, { reason: 'ok' });
    const refused = await handler({ spaceId: 'ACME-S1', action: 'reject', runId: run, reason: '  ' });
    expect(refused.isError).toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
    expect(textOf(await handler({ spaceId: 'ACME-S1', action: 'reject', runId: run, reason: 'outdated' }))).toBe(`Run ${run} rejected: outdated`);
    expect(post).toHaveBeenLastCalledWith(`/spaces/ACME-S1/llm-wiki/ingest-runs/${run}/reject`, { reason: 'outdated' });
    expect((await handler({ spaceId: 'ACME-S1', action: 'apply' })).isError).toBe(true);
  });

  it('ORB-2802 - an apply that wrote nothing says why and a failed or skipped review is not listed as applied', async () => {
    const run = '11111111-0000-4000-8000-000000000000';
    const post = vi.fn().mockResolvedValueOnce({ runId: run, status: 'skipped', pages: [], receipts: [], error: 'The page changed or is gone since this re-ingest ran.' })
      .mockResolvedValueOnce({ runId: run, status: 'failed', pages: [], receipts: [], error: 'model down' });
    const get = vi.fn().mockResolvedValueOnce({ runs: [
      { id: 'r7', kind: 'ingest', target: null, review: { decision: 'applied', outcome: 'failed', byName: 'Dana', reason: null }, sourceKey: 'ACME-D22', sourceTitle: 'Notes', status: 'failed', error: 'boom', createdAt: '2026-11-03T09:00:00Z' },
      { id: 'r8', kind: 'stale_reingest', target: { key: 'ACME-D3', title: 'Hosts' }, review: { decision: 'applied', outcome: 'skipped', byName: 'Dana', reason: 'ship it' }, sourceKey: 'ACME-D20', sourceTitle: 'Infra change', status: 'skipped', error: 'The page changed', createdAt: '2026-11-03T10:00:00Z' },
    ] });
    const handler = makeWikiRunsHandler({ get, post } as unknown as OrbotoClient);
    expect(textOf(await handler({ spaceId: 'ACME-S1', action: 'apply', runId: run }))).toBe(`Run ${run} was skipped and wrote nothing: The page changed or is gone since this re-ingest ran.`);
    expect(textOf(await handler({ spaceId: 'ACME-S1', action: 'apply', runId: run }))).toBe(`Run ${run} failed: model down`);
    const list = textOf(await handler({ spaceId: 'ACME-S1' }));
    expect(list).toContain('r7 failed (apply by Dana failed) ACME-D22');
    expect(list).toContain('r8 skipped stale re-ingest of ACME-D3 "Hosts" from (applied by Dana, nothing written: ship it) ACME-D20');
  });
});

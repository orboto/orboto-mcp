import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OrbotoClient } from '../orboto-client.js';
import { OrbotoClient as RealClient } from '../orboto-client.js';
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
});

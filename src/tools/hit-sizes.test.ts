import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OrbotoClient } from '../orboto-client.js';
import { makeKnowledgeFindHandler } from './knowledge.js';
import { makeSearchDocsHandler } from './doc-edits.js';
import { makeSearchHandler } from './search.js';
import { getDocToolConfig, makeGetDocHandler } from './docs.js';

const textOf = (result: { content: unknown[] }) => (result.content[0] as { text: string }).text;
const spaces = [{ spaceKey: 'ACME-S1', spaceName: 'ACME', projectKey: 'ACME' }];

afterEach(() => { vi.restoreAllMocks(); });

describe('ORB-2791 - every hit names its size in tokens', () => {
  it('knowledge find prints the size per hit and, over 2k tokens, the section of the match', async () => {
    const get = vi.fn().mockResolvedValue({
      items: [
        { id: 'd1', docKey: 'ACME-D12', title: 'Release window', snippet: 'tag on <mark>Tuesday</mark>', headingPath: ['Window'], approxTokens: 1200 },
        { id: 'd2', docKey: 'ACME-D40', title: 'Deploy runbook', snippet: 'roll the tenants', headingPath: ['Deploy', 'Tenants'], approxTokens: 4100 },
        { id: 'd3', docKey: 'ACME-D41', title: 'Old page', snippet: 'not backfilled yet', headingPath: [], approxTokens: null },
      ],
      total: 3, source: 'session', strict: true, spaces,
    });
    const result = await makeKnowledgeFindHandler({ get } as unknown as OrbotoClient)({ q: 'release window tenants' });
    const text = textOf(result);
    expect(text).toContain('- ACME-D12 Release window (~1.2k tokens): tag on Tuesday');
    expect(text).toContain('- ACME-D40 Deploy runbook (~4.1k tokens, section "Deploy > Tenants"): roll the tenants');
    expect(text).toContain('- ACME-D41 Old page: not backfilled yet');
    expect(text).toContain('a page over 2k tokens by its section');
    expect((result.structuredContent as { items: Array<{ approxTokens: number | null }> }).items.map((i) => i.approxTokens)).toEqual([1200, 4100, null]);
  });

  it('search_docs prints and returns the size of each hit', async () => {
    const get = vi.fn().mockResolvedValue({
      items: [{ id: 'd1', docKey: 'ACME-D12', title: 'Release window', spaceId: 's1', spaceName: 'ACME', projectId: null, snippet: 'tag', headingPath: ['Window'], charOffset: 4, lineOffset: 1, rank: 0.5, url: '/x', approxTokens: 340 }],
      total: 1,
    });
    const result = await makeSearchDocsHandler({ get } as unknown as OrbotoClient)({ q: 'tag' });
    expect(textOf(result)).toContain('- Release window (ACME-D12) (~340 tokens)  §Window  (line 1)');
    expect((result.structuredContent as { items: Array<{ approxTokens: number }> }).items[0].approxTokens).toBe(340);
  });

  it('search prints the size of a doc hit and returns approxTokens on doc hits only', async () => {
    const get = vi.fn().mockResolvedValue({
      items: [
        { type: 'ticket', id: 't1', title: 'Bug', excerpt: 'login', projectId: 'p1', projectName: 'Acme', spaceId: null, spaceName: null, url: '/t', ticketKey: 'ACME-1' },
        { type: 'doc', id: 'd1', key: 'ACME-D12', title: 'Runbook', excerpt: 'restart', projectId: null, projectName: null, spaceId: 's1', spaceName: 'Ops', url: '/d', approxTokens: 12_345 },
      ],
      nextCursor: null, total: 2,
    });
    const result = await makeSearchHandler({ get } as unknown as OrbotoClient)({ query: 'restart' });
    expect(textOf(result)).toContain('- [DOC ACME-D12] Runbook (~12k tokens)');
    expect(textOf(result)).toContain('- [TICKET ACME-1 · Acme] Bug\n');
    const hits = (result.structuredContent as { hits: Array<Record<string, unknown>> }).hits;
    expect(hits[0]).not.toHaveProperty('approxTokens');
    expect(hits[1].approxTokens).toBe(12_345);
  });

  it('get_doc names the page size and reads one section with section', async () => {
    expect(Object.keys(getDocToolConfig.inputSchema)).toEqual(['docId', 'section']);
    const get = vi.fn()
      .mockResolvedValueOnce({ docId: 'd1', docKey: 'ACME-D40', title: 'Deploy runbook', headingPath: ['Deploy', 'Tenants'], content: '## Tenants\nroll them', approxTokens: 5, pageApproxTokens: 4100 })
      .mockResolvedValueOnce({ id: 'd1', spaceId: 's1', parentDocId: null, title: 'Deploy runbook', content: 'body', slug: 'r', docKey: 'ACME-D40', visibility: 'workspace', icon: null, sortOrder: 0, updatedAt: 'now', approxTokens: 4100 })
      .mockResolvedValueOnce([]);
    const section = await makeGetDocHandler({ get } as unknown as OrbotoClient)({ docId: 'ACME-D40', section: 'Deploy > Tenants' });
    expect(get).toHaveBeenNthCalledWith(1, '/docs/ACME-D40/section?heading=Deploy+%3E+Tenants');
    expect(textOf(section)).toBe('Deploy runbook > Deploy > Tenants  ·  Key: ACME-D40  ·  ~5 tokens of ~4.1k tokens\n\n## Tenants\nroll them');
    const whole = await makeGetDocHandler({ get } as unknown as OrbotoClient)({ docId: 'ACME-D40' });
    expect(textOf(whole)).toContain('Size: ~4.1k tokens');
    expect((whole.structuredContent as { doc: { approxTokens: number } }).doc.approxTokens).toBe(4100);
  });
});

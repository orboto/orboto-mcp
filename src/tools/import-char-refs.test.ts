/** ORB-3206 - orboto_import_char_refs: the dry run by default, the repair batch only with apply. */
import { describe, expect, it, vi } from 'vitest';
import type { OrbotoClient } from '../orboto-client.js';
import { importCharRefsToolConfig, makeImportCharRefsHandler } from './import-char-refs.js';
import type { ImportCharRefsReport } from './import-char-refs-result.js';

const TOKEN = '3f2b6c1e-8a4d-4e5f-9b7a-1c2d3e4f5a6b';
const textOf = (result: { content: unknown[] }): string => (result.content[0] as { text: string }).text;
const zero = { checked: 0, repairable: 0, replacementChar: 0 };

function report(overrides: Partial<ImportCharRefsReport> = {}): ImportCharRefsReport {
  return {
    token: TOKEN, adapterId: 'jira-xml', status: 'applied', projectId: '9b7a1c2d-3e4f-4a6b-8c1d-2e3f4a5b6c7d', supported: true, tickets: 468,
    counts: { titles: { checked: 468, repairable: 110, replacementChar: 2 }, descriptions: zero, comments: zero, labels: { checked: 3, repairable: 1, replacementChar: 0 } },
    labelConflicts: 1,
    samples: [{ field: 'title', ticketKey: 'AP-7', before: 'k&#252;rzer', after: 'kürzer' }],
    replacementCharRows: Array.from({ length: 25 }, (_, i) => ({ field: 'title' as const, ticketId: null, ticketKey: `AP-${i}`, commentId: null, labelId: null, excerpt: `[DEV] Bugfixing ${i}` })),
    replacementCharOmitted: 3,
    ...overrides,
  };
}

describe('orboto_import_char_refs', () => {
  it('is no read-only tool but idempotent, and reads the dry run without apply', async () => {
    expect(importCharRefsToolConfig.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    const get = vi.fn().mockResolvedValue(report());
    const post = vi.fn();
    const result = await makeImportCharRefsHandler({ get, post } as unknown as OrbotoClient)({ token: TOKEN });
    expect(get).toHaveBeenCalledWith(`/admin/import/jobs/${TOKEN}/char-refs`);
    expect(post).not.toHaveBeenCalled();
    const text = textOf(result);
    expect(text).toContain('- titles: 110 of 468 repairable, 2 with U+FFFD');
    expect(text).toContain('- 1 labels stay: another label of the project already holds the repaired name.');
    expect(text).toContain('- title AP-7: "k&#252;rzer" -> "kürzer"');
    expect(text).toContain('... 8 more U+FFFD values not listed.');
    expect(text).toContain('repair only on their go with apply: true');
    expect((result.structuredContent as { replacementCharRows: unknown[] }).replacementCharRows).toHaveLength(20);
  });

  it('says an adapter without escaping is not repairable', async () => {
    const get = vi.fn().mockResolvedValue(report({ adapterId: 'csv', supported: false, samples: [], replacementCharRows: [], replacementCharOmitted: 0 }));
    const text = textOf(await makeImportCharRefsHandler({ get } as unknown as OrbotoClient)({ token: TOKEN }));
    expect(text).toContain('NOT REPAIRABLE: csv stored no undecoded references');
    expect(text).not.toContain('apply: true');
  });

  it('posts the repair batches with apply until next is null and sums them', async () => {
    const post = vi.fn()
      .mockResolvedValueOnce({ processedTickets: 100, titles: 40, descriptions: 3, comments: 5, labels: 1, labelConflicts: 1, edited: 2, replacementChar: 1, next: 100 })
      .mockResolvedValueOnce({ processedTickets: 20, titles: 2, descriptions: 0, comments: 1, labels: 0, labelConflicts: 0, edited: 0, replacementChar: 1, next: null });
    const result = await makeImportCharRefsHandler({ post } as unknown as OrbotoClient)({ token: TOKEN, apply: true });
    expect(post.mock.calls).toEqual([[`/admin/import/jobs/${TOKEN}/char-refs/repair`, { from: 0 }], [`/admin/import/jobs/${TOKEN}/char-refs/repair`, { from: 100 }]]);
    expect(textOf(result)).toBe('Repaired in 2 batches: 42 titles, 3 descriptions, 6 comments, 1 labels in 120 tickets.\nLeft as they are: 2 changed since the read, 1 label name conflicts, 2 values with U+FFFD.\nDone.');
    expect(result.structuredContent).toMatchObject({ titles: 42, next: null, batches: 2 });
  });
});

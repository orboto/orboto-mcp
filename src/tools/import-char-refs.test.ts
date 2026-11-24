/** ORB-3206 - orboto_import_char_refs: the dry run by default, the repair batches only with apply, resumable at next; a project key reaches the project scope. */
import { describe, expect, it, vi } from 'vitest';
import type { OrbotoClient } from '../orboto-client.js';
import { importCharRefsToolConfig, makeImportCharRefsHandler } from './import-char-refs.js';
import type { ImportCharRefsReport } from './import-char-refs-result.js';

const TOKEN = '3f2b6c1e-8a4d-4e5f-9b7a-1c2d3e4f5a6b';
const textOf = (result: { content: unknown[] }): string => (result.content[0] as { text: string }).text;
const zero = { checked: 0, repairable: 0, replacementChar: 0 };

function report(overrides: Partial<ImportCharRefsReport> = {}): ImportCharRefsReport {
  return {
    scope: 'job', token: TOKEN, adapterId: 'jira-xml', status: 'applied', projectId: '9b7a1c2d-3e4f-4a6b-8c1d-2e3f4a5b6c7d', importedAt: null, importedTickets: null, supported: true, tickets: 468,
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
    expect(text).toContain('repair only on their go with apply: 0');
    expect((result.structuredContent as { replacementCharRows: unknown[] }).replacementCharRows).toHaveLength(20);
  });

  it('says an adapter without escaping is not repairable', async () => {
    const get = vi.fn().mockResolvedValue(report({ adapterId: 'csv', supported: false, samples: [], replacementCharRows: [], replacementCharOmitted: 0 }));
    const text = textOf(await makeImportCharRefsHandler({ get } as unknown as OrbotoClient)({ token: TOKEN }));
    expect(text).toContain('NOT REPAIRABLE: csv stored no undecoded references');
    expect(text).not.toContain('apply: 0');
  });

  it('posts the repair batches from apply until next is null and sums them', async () => {
    const post = vi.fn()
      .mockResolvedValueOnce({ processedTickets: 100, titles: 40, descriptions: 3, comments: 5, labels: 1, labelConflicts: 1, edited: 2, replacementChar: 1, next: 100 })
      .mockResolvedValueOnce({ processedTickets: 20, titles: 2, descriptions: 0, comments: 1, labels: 0, labelConflicts: 0, edited: 0, replacementChar: 1, next: null });
    const result = await makeImportCharRefsHandler({ post } as unknown as OrbotoClient)({ token: TOKEN, apply: 0 });
    expect(post.mock.calls).toEqual([[`/admin/import/jobs/${TOKEN}/char-refs/repair`, { from: 0 }], [`/admin/import/jobs/${TOKEN}/char-refs/repair`, { from: 100 }]]);
    expect(textOf(result)).toBe('Repaired in 2 batches: 42 titles, 3 descriptions, 6 comments, 1 labels in 120 tickets.\nLeft as they are: 2 changed since the read, 1 label name conflicts, 2 values with U+FFFD.\nDone.');
    expect(result.structuredContent).toMatchObject({ titles: 42, next: null, batches: 2 });
  });

  it('stops after 100 batches with next, and apply: next resumes there instead of starting over', async () => {
    let at = 0;
    const post = vi.fn(async (_path: string, body: { from: number }) => {
      at = body.from + 100;
      return { processedTickets: 100, titles: 1, descriptions: 0, comments: 0, labels: 0, labelConflicts: 0, edited: 0, replacementChar: 0, next: at < 15_000 ? at : null };
    });
    const handler = makeImportCharRefsHandler({ post } as unknown as OrbotoClient);
    const stopped = await handler({ token: TOKEN, apply: 0 });
    expect(post).toHaveBeenCalledTimes(100);
    expect(post.mock.calls[0]).toEqual([`/admin/import/jobs/${TOKEN}/char-refs/repair`, { from: 0 }]);
    expect(stopped.structuredContent).toMatchObject({ processedTickets: 10_000, next: 10_000, batches: 100 });
    expect(textOf(stopped)).toContain('Stopped after 100 batches; call again with apply: 10000 to continue.');
    post.mockClear();
    const resumed = await handler({ token: TOKEN, apply: 10_000 });
    expect(post.mock.calls[0]).toEqual([`/admin/import/jobs/${TOKEN}/char-refs/repair`, { from: 10_000 }]);
    expect(post).toHaveBeenCalledTimes(50);
    expect(resumed.structuredContent).toMatchObject({ processedTickets: 5_000, next: null, batches: 50 });
  });

  it('reaches the project scope with a project key', async () => {
    const get = vi.fn().mockResolvedValue(report({ scope: 'project', token: null, importedAt: '2026-06-18 13:54:43.495816+00', importedTickets: 468 }));
    const post = vi.fn().mockResolvedValue({ processedTickets: 3, titles: 3, descriptions: 0, comments: 0, labels: 0, labelConflicts: 0, edited: 0, replacementChar: 0, next: null });
    const handler = makeImportCharRefsHandler({ get, post } as unknown as OrbotoClient);
    const text = textOf(await handler({ token: 'AP' }));
    expect(get).toHaveBeenCalledWith('/admin/import/projects/AP/char-refs');
    expect(text).toContain('(audit entry 2026-06-18 13:54:43.495816+00, 468 tickets written)');
    await handler({ token: 'AP', apply: 12 });
    expect(post).toHaveBeenCalledWith('/admin/import/projects/AP/char-refs/repair', { from: 12 });
  });
});

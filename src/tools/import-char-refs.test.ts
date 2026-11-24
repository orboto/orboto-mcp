/** ORB-3206 - orboto_import_char_refs: the dry run by default, the repair batches only with apply, resumable at next; a project key reaches the project scope. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { OrbotoApiError, OrbotoClient } from '../orboto-client.js';
import { withMetrics } from '../with-metrics.js';
import { importCharRefsToolConfig, makeImportCharRefsHandler } from './import-char-refs.js';
import type { ImportCharRefsReport } from './import-char-refs-result.js';

const TOKEN = '3f2b6c1e-8a4d-4e5f-9b7a-1c2d3e4f5a6b';
const textOf = (result: { content: unknown[] }): string => (result.content[0] as { text: string }).text;
const zero = { checked: 0, repairable: 0, replacementChar: 0 };

function report(overrides: Partial<ImportCharRefsReport> = {}): ImportCharRefsReport {
  return {
    scope: 'job', token: TOKEN, adapterId: 'jira-xml', status: 'applied', projectId: '9b7a1c2d-3e4f-4a6b-8c1d-2e3f4a5b6c7d', importedAt: null, importedTickets: null, supported: true, tickets: 468, unnumberedTickets: 0,
    counts: { titles: { checked: 468, repairable: 110, replacementChar: 2 }, descriptions: zero, comments: zero, labels: { checked: 3, repairable: 1, replacementChar: 0 }, milestones: { checked: 2, repairable: 2, replacementChar: 0 } },
    labelConflicts: 1,
    milestoneConflicts: 1,
    samples: [{ field: 'title', ticketKey: 'AP-7', before: 'k&#252;rzer', after: 'kürzer' }],
    samplesOmitted: 0,
    replacementCharRows: Array.from({ length: 25 }, (_, i) => ({ field: 'title' as const, ticketId: null, ticketKey: `AP-${i}`, commentId: null, labelId: null, milestoneId: null, excerpt: `[DEV] Bugfixing ${i}` })),
    replacementCharOmitted: 3,
    manualRows: [], manualOmitted: 0,
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
    expect(text).toContain('- milestones: 2 of 2 repairable, 0 with U+FFFD');
    expect(text).toContain('- 1 milestones stay: another milestone of the project already holds the repaired name.');
    expect(text).not.toContain('Not repaired');
    expect(text).toContain('- title AP-7: "k&#252;rzer" -> "kürzer"');
    expect(text).toContain('... 8 more U+FFFD values not listed.');
    expect(text).toContain('repair only on their go with apply: true');
    expect(text).not.toContain('without a ticket number');
    expect((result.structuredContent as { replacementCharRows: unknown[] }).replacementCharRows).toHaveLength(20);
  });

  it('says an adapter without escaping is not repairable', async () => {
    const get = vi.fn().mockResolvedValue(report({ adapterId: 'csv', supported: false, samples: [], replacementCharRows: [], replacementCharOmitted: 0 }));
    const text = textOf(await makeImportCharRefsHandler({ get } as unknown as OrbotoClient)({ token: TOKEN }));
    expect(text).toContain('NOT REPAIRABLE: csv stored no undecoded references');
    expect(text).not.toContain('apply: true');
  });

  it('posts the repair batches from apply until next is null and sums them', async () => {
    const post = vi.fn()
      .mockResolvedValueOnce({ processedTickets: 100, titles: 40, descriptions: 3, comments: 5, labels: 1, labelConflicts: 1, milestones: 2, milestoneConflicts: 1, edited: 2, replacementChar: 1, next: 100 })
      .mockResolvedValueOnce({ processedTickets: 20, titles: 2, descriptions: 0, comments: 1, labels: 0, labelConflicts: 0, milestones: 0, milestoneConflicts: 0, edited: 0, replacementChar: 1, next: null });
    const result = await makeImportCharRefsHandler({ post } as unknown as OrbotoClient)({ token: TOKEN, apply: true });
    expect(post.mock.calls).toEqual([[`/admin/import/jobs/${TOKEN}/char-refs/repair`, { from: 0 }], [`/admin/import/jobs/${TOKEN}/char-refs/repair`, { from: 100 }]]);
    expect(textOf(result)).toBe('Repaired in 2 batches: 42 titles, 3 descriptions, 6 comments, 1 labels, 2 milestones in 120 tickets.\nLeft as they are: 2 changed since the read, 1 label and 1 milestone name conflicts, 2 values with U+FFFD.\nDone.');
    expect(result.structuredContent).toMatchObject({ titles: 42, next: null, batches: 2 });
  });

  it('stops after 100 batches with next, and from: next resumes there instead of starting over', async () => {
    let at = 0;
    const post = vi.fn(async (_path: string, body: { from: number }) => {
      at = body.from + 100;
      return { processedTickets: 100, titles: 1, descriptions: 0, comments: 0, labels: 0, labelConflicts: 0, milestones: 0, milestoneConflicts: 0, edited: 0, replacementChar: 0, next: at < 15_000 ? at : null };
    });
    const handler = makeImportCharRefsHandler({ post } as unknown as OrbotoClient);
    const stopped = await handler({ token: TOKEN, apply: true });
    expect(post).toHaveBeenCalledTimes(100);
    expect(post.mock.calls[0]).toEqual([`/admin/import/jobs/${TOKEN}/char-refs/repair`, { from: 0 }]);
    expect(stopped.structuredContent).toMatchObject({ processedTickets: 10_000, next: 10_000, batches: 100 });
    expect(textOf(stopped)).toContain('Stopped after 100 batches; call again with apply: true, from: 10000 to continue.');
    post.mockClear();
    const resumed = await handler({ token: TOKEN, apply: true, from: 10_000 });
    expect(post.mock.calls[0]).toEqual([`/admin/import/jobs/${TOKEN}/char-refs/repair`, { from: 10_000 }]);
    expect(post).toHaveBeenCalledTimes(50);
    expect(resumed.structuredContent).toMatchObject({ processedTickets: 5_000, next: null, batches: 50 });
  });

  it('reaches the project scope with a project key', async () => {
    const get = vi.fn().mockResolvedValue(report({ scope: 'project', token: null, importedAt: '2026-06-18 13:54:43.495816+00', importedTickets: 468 }));
    const post = vi.fn().mockResolvedValue({ processedTickets: 3, titles: 3, descriptions: 0, comments: 0, labels: 0, labelConflicts: 0, milestones: 0, milestoneConflicts: 0, edited: 0, replacementChar: 0, next: null });
    const handler = makeImportCharRefsHandler({ get, post } as unknown as OrbotoClient);
    const text = textOf(await handler({ token: 'AP' }));
    expect(get).toHaveBeenCalledWith('/admin/import/projects/AP/char-refs');
    expect(text).toContain('(audit entry 2026-06-18 13:54:43.495816+00, 468 tickets written)');
    await handler({ token: 'AP', apply: true, from: 12 });
    expect(post).toHaveBeenCalledWith('/admin/import/projects/AP/char-refs/repair', { from: 12 });
  });

  it('writes nothing without apply: true, whatever from says, and refuses a negative or fractional from', async () => {
    const schema = z.object(importCharRefsToolConfig.inputSchema);
    for (const bad of [{ token: TOKEN, apply: 0 }, { token: TOKEN, apply: true, from: -1 }, { token: TOKEN, apply: true, from: 0.5 }]) expect(schema.safeParse(bad).success).toBe(false);
    expect(schema.safeParse({ token: TOKEN, apply: true, from: 0 }).success).toBe(true);
    const get = vi.fn().mockResolvedValue(report());
    const post = vi.fn();
    const handler = makeImportCharRefsHandler({ get, post } as unknown as OrbotoClient);
    await handler({ token: TOKEN, apply: false, from: 5 });
    await handler({ token: TOKEN, from: 5 });
    for (const from of [-1, 0.5]) {
      const refused = await handler({ token: TOKEN, apply: true, from });
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toContain('nothing was written');
    }
    expect(post).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('reads a UUID the token routes do not know as a project id, as REST does', async () => {
    const PROJECT = 'e8612169-4527-47c9-b62f-cc1fded4d9ef';
    const notStaged = new OrbotoApiError(404, '{"error":"Staged import not found or expired","errorKey":"errors.admin_import.staged_not_found"}', 'x');
    const get = vi.fn(async (path: string) => {
      if (path.startsWith('/admin/import/jobs/')) throw notStaged;
      return report({ scope: 'project', token: null, projectId: PROJECT, importedAt: '2026-06-18 13:54:43.495816+00', importedTickets: 468 });
    });
    const post = vi.fn(async (path: string) => {
      if (path.startsWith('/admin/import/jobs/')) throw notStaged;
      return { processedTickets: 1, titles: 1, descriptions: 0, comments: 0, labels: 0, labelConflicts: 0, milestones: 0, milestoneConflicts: 0, edited: 0, replacementChar: 0, next: null };
    });
    const handler = makeImportCharRefsHandler({ get, post } as unknown as OrbotoClient);
    expect(textOf(await handler({ token: PROJECT }))).toContain('468 tickets written');
    expect(get.mock.calls.map((c) => c[0])).toEqual([`/admin/import/jobs/${PROJECT}/char-refs`, `/admin/import/projects/${PROJECT}/char-refs`]);
    await handler({ token: PROJECT, apply: true });
    expect(post.mock.calls.map((c) => c[0])).toEqual([`/admin/import/jobs/${PROJECT}/char-refs/repair`, `/admin/import/projects/${PROJECT}/char-refs/repair`]);
    const other = vi.fn().mockRejectedValue(new OrbotoApiError(409, '{"errorKey":"errors.admin_import.recovery_not_applied"}', 'x'));
    await expect(makeImportCharRefsHandler({ get: other } as unknown as OrbotoClient)({ token: TOKEN })).rejects.toThrow('409');
    expect(other).toHaveBeenCalledTimes(1);
  });

  it('names the tickets it leaves for want of a ticket number', async () => {
    const get = vi.fn().mockResolvedValue(report({ unnumberedTickets: 2 }));
    expect(textOf(await makeImportCharRefsHandler({ get } as unknown as OrbotoClient)({ token: TOKEN }))).toContain('- 2 tickets without a ticket number are left out; fix them by hand.');
  });

  it('lists the values it leaves for a fix by hand, capped like the U+FFFD rows', async () => {
    const manualRows = [
      { kind: 'comment' as const, reason: 'source_unknown' as const, ticketId: null, ticketKey: 'AS-1', commentId: '55555555-5555-4555-8555-555555555555', userId: null, labelId: null, milestoneId: null, excerpt: 'Kommentar &#8594;' },
      { kind: 'milestone' as const, reason: 'holds_other_tickets' as const, ticketId: null, ticketKey: null, commentId: null, userId: null, labelId: null, milestoneId: '77777777-7777-4777-8777-777777777777', excerpt: 'Release &#8594; 2' },
      ...Array.from({ length: 20 }, (_, i) => ({
        kind: 'user' as const, reason: 'person' as const, ticketId: null, ticketKey: null, commentId: null, labelId: null, milestoneId: null,
        userId: i === 0 ? null : `66666666-6666-4666-8666-${String(i).padStart(12, '0')}`, excerpt: `J&#252;rgen ${i}`,
      })),
    ];
    const result = await makeImportCharRefsHandler({ get: vi.fn().mockResolvedValue(report({ manualRows, manualOmitted: 4 })) } as unknown as OrbotoClient)({ token: TOKEN });
    const text = textOf(result);
    expect(text).toContain('Not repaired, fix these by hand');
    expect(text).toContain('- comment AS-1 comment 55555555-5555-4555-8555-555555555555 (may be the author\'s text): Kommentar &#8594;');
    expect(text).toContain('- milestone 77777777-7777-4777-8777-777777777777 (also holds tickets outside the import): Release &#8594; 2');
    expect(text).toContain('- user (no member) (people are never renamed): J&#252;rgen 0');
    expect(text).toContain('... 6 more values to fix by hand not listed.');
    expect((result.structuredContent as { manualRows: unknown[] }).manualRows).toHaveLength(20);
  });

  it('puts the go line under the counts and the ticket samples last', async () => {
    const samples = [{ field: 'title' as const, ticketKey: 'AP-7', before: 'k&#252;rzer', after: 'kürzer' }, { field: 'milestone' as const, ticketKey: null, before: 'Sprint &#8470; 1', after: 'Sprint № 1' }];
    const manualRows = [{ kind: 'user' as const, reason: 'person' as const, ticketId: null, ticketKey: null, commentId: null, userId: null, labelId: null, milestoneId: null, excerpt: 'J&#252;rgen' }];
    const text = textOf(await makeImportCharRefsHandler({ get: vi.fn().mockResolvedValue(report({ samples, manualRows })) } as unknown as OrbotoClient)({ token: TOKEN }));
    const at = ['- milestones: 2 of 2', 'repair only on their go with apply: true', 'Not repaired, fix these by hand', '- milestone: "Sprint &#8470; 1" -> "Sprint № 1"', 'U+FFFD (the source', '- title AP-7: "k&#252;rzer"'].map((s) => text.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it('shows every label and milestone rename beside the first ticket samples', async () => {
    const samples = [
      ...Array.from({ length: 15 }, (_, i) => ({ field: 'title' as const, ticketKey: `AP-${i}`, before: `t&#252;${i}`, after: `tü${i}` })),
      { field: 'label' as const, ticketKey: null, before: 'gr&#252;n', after: 'grün' },
      ...Array.from({ length: 24 }, (_, i) => ({ field: 'label' as const, ticketKey: null, before: `l&#252;${i}`, after: `lü${i}` })),
      { field: 'milestone' as const, ticketKey: null, before: 'Version gr&#252;n', after: 'Version grün' },
    ];
    const result = await makeImportCharRefsHandler({ get: vi.fn().mockResolvedValue(report({ samples, samplesOmitted: 7 })) } as unknown as OrbotoClient)({ token: TOKEN });
    const text = textOf(result);
    expect(text).toContain('- label: "gr&#252;n" -> "grün"');
    expect(text).toContain('- milestone: "Version gr&#252;n" -> "Version grün"');
    expect(text).toContain('- label: "l&#252;23" -> "lü23"');
    expect(text).not.toContain('t&#252;10');
    expect(text).toContain('... 12 more samples not listed.');
    expect((result.structuredContent as { samples: unknown[] }).samples).toHaveLength(36);
  });
});

describe('orboto_import_char_refs within the MCP response budget', () => {
  afterEach(() => vi.restoreAllMocks());

  const words = (i: number, n: number) => `${`Kommentar ${i} mit Umlaut k&#252;rzer und Pfeil &#8594; `.repeat(4)}`.slice(0, n);
  const uuid = (i: number) => `66666666-6666-4666-8666-${String(i).padStart(12, '0')}`;
  const apSized = (names: number) => report({
    samples: [
      ...Array.from({ length: 20 }, (_, i) => ({ field: 'title' as const, ticketKey: `AP-${100 + i}`, before: `[DEV] Spieler ${i} soll k&#252;rzer laufen &#8594; Animation`, after: `[DEV] Spieler ${i} soll kürzer laufen → Animation` })),
      ...Array.from({ length: names }, (_, i) => ({ field: 'milestone' as const, ticketKey: null, before: `Sprint &#8470; ${i + 1} &#183; Gr&#252;ne Wiese`, after: `Sprint № ${i + 1} · Grüne Wiese` })),
    ],
    replacementCharRows: Array.from({ length: 25 }, (_, i) => ({ field: 'description' as const, ticketId: uuid(i), ticketKey: `AP-${200 + i}`, commentId: null, labelId: null, milestoneId: null, excerpt: `${words(i, 60)}�${words(i, 59)}` })),
    manualRows: [
      ...Array.from({ length: 10 }, (_, i) => ({ kind: 'user' as const, reason: 'person' as const, ticketId: null, ticketKey: null, commentId: null, userId: uuid(i), labelId: null, milestoneId: null, excerpt: `J&#252;rgen M&#252;ller ${i}` })),
      ...Array.from({ length: 10 }, (_, i) => ({ kind: 'comment' as const, reason: 'source_unknown' as const, ticketId: uuid(i), ticketKey: `AP-${300 + i}`, commentId: uuid(50 + i), userId: null, labelId: null, milestoneId: null, excerpt: words(i, 120) })),
    ],
    manualOmitted: 0,
  });
  const throughBudget = async (r: ImportCharRefsReport) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });
    const wrapped = withMetrics(client, 'orboto_import_char_refs', undefined, makeImportCharRefsHandler({ get: vi.fn().mockResolvedValue(r) } as unknown as OrbotoClient) as never);
    const result = await wrapped({ token: TOKEN } as never);
    return { result, text: (result.content as Array<{ type: string; text?: string }>).filter((p) => p.type === 'text').map((p) => p.text!).join('\n') };
  };

  it('carries the go line, every value to fix by hand and every rename of an AP-sized dry run whole', async () => {
    const { result, text } = await throughBudget(apSized(26));
    expect(text).toContain('Show this to the user; repair only on their go with apply: true.');
    expect(text).toContain(`- comment AP-309 comment ${uuid(59)} (may be the author's text): ${words(9, 120)}`);
    expect(text).toContain('- milestone: "Sprint &#8470; 26 &#183; Gr&#252;ne Wiese" -> "Sprint № 26 · Grüne Wiese"');
    expect(text).toContain('- title AP-109:');
    expect(text).not.toContain('Response truncated');
    expect(result.structuredContent).not.toHaveProperty('__truncation');
    expect((result.structuredContent as { samples: unknown[] }).samples).toHaveLength(36);
  });

  it('keeps the counts, the go line and the values to fix by hand when the budget cuts, and the cut points to CLI and REST', async () => {
    const { result, text } = await throughBudget(apSized(400));
    expect(text).toContain('- milestones: 2 of 2 repairable');
    expect(text).toContain('Show this to the user; repair only on their go with apply: true.');
    expect(text).toContain(`- comment AP-309 comment ${uuid(59)}`);
    expect(text).toContain('- milestone: "Sprint &#8470; 1 &#183; Gr&#252;ne Wiese"');
    expect(text).not.toContain('- title AP-100:');
    expect(text).toContain('the REST API and both CLIs return the complete body');
    const samples = (result.structuredContent as { samples: Array<{ field: string }> }).samples;
    expect(samples[0]!.field).toBe('milestone');
    expect(samples.some((s) => s.field === 'title')).toBe(false);
  });
});

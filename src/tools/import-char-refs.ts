/**
 * ORB-3206 - `orboto_import_char_refs`: the dry run and the repair of an import that stored character references undecoded
 * (`k&#252;rzer`) in titles, descriptions, comments and labels. The dry run writes nothing; the repair runs only on the user's go.
 * `token` is a staged import's token, or the key of a project the synchronous apply created without one. `apply` is the position the
 * repair starts at, 0 for the whole import; a repair that stops at MAX_BATCHES returns `next`, and `apply: next` resumes there.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';
import type { ImportCharRefsReport, ImportCharRefsRepairResponse } from './import-char-refs-result.js';

const SAMPLE_LINES = 10;
const ROW_LINES = 20;

export const importCharRefsToolConfig = {
  title: 'Import repair',
  description:
    'Fix an import\'s k&#252;rzer. token: a staged import\'s token, or the key of a project an import created without one. Without apply a dry run: counts per field, samples and the values with U+FFFD, which no repair restores. apply: 0 repairs every batch, only after the user approved the dry run; a repair that stops returns next, and apply: next resumes it. admin:import.',
  inputSchema: z.object({
    token: z.string(),
    apply: z.number().optional(),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
};

const fieldLine = (name: string, c: { checked: number; repairable: number; replacementChar: number }) =>
  `- ${name}: ${c.repairable} of ${c.checked} repairable, ${c.replacementChar} with U+FFFD`;

export function reportText(r: ImportCharRefsReport): string {
  const lines = [
    `Dry run of ${r.token ? `import ${r.token}` : `the import of project ${r.projectId} (audit entry ${r.importedAt}, ${r.importedTickets} tickets written)`} (${r.adapterId}, ${r.status}): ${r.tickets} tickets with a reference or U+FFFD.${r.supported ? '' : ` NOT REPAIRABLE: ${r.adapterId} stored no undecoded references; its text is the author's.`}`,
    fieldLine('titles', r.counts.titles),
    fieldLine('descriptions', r.counts.descriptions),
    fieldLine('comments', r.counts.comments),
    fieldLine('labels', r.counts.labels),
    ...(r.labelConflicts > 0 ? [`- ${r.labelConflicts} labels stay: another label of the project already holds the repaired name.`] : []),
  ];
  if (r.samples.length > 0) lines.push('Samples:', ...r.samples.slice(0, SAMPLE_LINES).map((s) => `- ${s.field} ${s.ticketKey ?? ''}: "${s.before}" -> "${s.after}"`));
  const rows = r.replacementCharRows.slice(0, ROW_LINES);
  if (rows.length > 0) {
    lines.push('U+FFFD (the source character is lost; fix these by hand):', ...rows.map((x) => `- ${x.field} ${x.ticketKey ?? x.labelId ?? ''}${x.commentId ? ` comment ${x.commentId}` : ''}: ${x.excerpt}`));
    const more = r.replacementCharRows.length - rows.length + r.replacementCharOmitted;
    if (more > 0) lines.push(`... ${more} more U+FFFD values not listed.`);
  }
  if (r.supported) lines.push('Show this to the user; repair only on their go with apply: 0.');
  return lines.join('\n');
}

export function repairText(r: ImportCharRefsRepairResponse, calls: number): string {
  return [
    `Repaired in ${calls} batches: ${r.titles} titles, ${r.descriptions} descriptions, ${r.comments} comments, ${r.labels} labels in ${r.processedTickets} tickets.`,
    `Left as they are: ${r.edited} changed since the read, ${r.labelConflicts} label name conflicts, ${r.replacementChar} values with U+FFFD.`,
    r.next === null ? 'Done.' : `Stopped after ${calls} batches; call again with apply: ${r.next} to continue.`,
  ].join('\n');
}

const MAX_BATCHES = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function makeImportCharRefsHandler(client: OrbotoClient) {
  return async ({ token, apply }: { token: string; apply?: number }): Promise<CallToolResult> => {
    const job = UUID.test(token);
    if (apply === undefined) {
      const report = job
        ? await client.get<ImportCharRefsReport>(`/admin/import/jobs/${encodeURIComponent(token)}/char-refs`)
        : await client.get<ImportCharRefsReport>(`/admin/import/projects/${encodeURIComponent(token)}/char-refs`);
      const { replacementCharRows, ...rest } = report;
      return { content: [{ type: 'text', text: reportText(report) }], structuredContent: { ...rest, replacementCharRows: replacementCharRows.slice(0, ROW_LINES) } };
    }
    const total: ImportCharRefsRepairResponse = { processedTickets: 0, titles: 0, descriptions: 0, comments: 0, labels: 0, labelConflicts: 0, edited: 0, replacementChar: 0, next: Math.max(0, Math.trunc(apply)) };
    let calls = 0;
    while (total.next !== null && calls < MAX_BATCHES) {
      const res = job
        ? await client.post<ImportCharRefsRepairResponse>(`/admin/import/jobs/${encodeURIComponent(token)}/char-refs/repair`, { from: total.next })
        : await client.post<ImportCharRefsRepairResponse>(`/admin/import/projects/${encodeURIComponent(token)}/char-refs/repair`, { from: total.next });
      calls += 1;
      for (const key of ['processedTickets', 'titles', 'descriptions', 'comments', 'labels', 'labelConflicts', 'edited', 'replacementChar'] as const) total[key] += res[key];
      total.next = res.next;
    }
    return { content: [{ type: 'text', text: repairText(total, calls) }], structuredContent: { ...total, batches: calls } };
  };
}

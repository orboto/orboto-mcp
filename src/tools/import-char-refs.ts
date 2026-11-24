/**
 * ORB-3206 - `orboto_import_char_refs`: the dry run and the repair of an import that stored character references undecoded
 * (`k&#252;rzer`) in titles, descriptions, comments, labels and milestone names. The dry run writes nothing; the repair runs only on the
 * user's go.
 * `token` is a staged import's token, or the id or key of a project the synchronous apply created without one: a UUID the token routes
 * answer 404 `staged_not_found` for is a project id, as REST reads it. `apply: true` repairs from `from` (0); a repair that stops at
 * MAX_BATCHES returns `next`, and `from: next` resumes there.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OrbotoApiError, type OrbotoClient } from '../orboto-client.js';
import type { ImportCharRefsReport, ImportCharRefsRepairResponse } from './import-char-refs-result.js';

const SAMPLE_LINES = 10;
const ROW_LINES = 20;

export const importCharRefsToolConfig = {
  title: 'Import repair',
  description:
    'Without apply a dry run; apply: true repairs an import\'s k&#252;rzer. token: a staged import\'s token, or the id or key of a project an import created without one. The dry run gives counts per field (titles, descriptions, comments, labels, milestones), samples, the values with U+FFFD, which no repair restores, and the values to fix by hand (Asana JSON comments, Jira display names). Repair only after the user approved the dry run; a repair that stops returns next, and from: next resumes it. admin:import.',
  inputSchema: z.object({
    token: z.string(),
    apply: z.boolean().optional(),
    from: z.number().int().min(0).optional(),
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
    fieldLine('milestones', r.counts.milestones),
    ...(r.unnumberedTickets > 0 ? [`- ${r.unnumberedTickets} tickets without a ticket number are left out; fix them by hand.`] : []),
    ...(r.labelConflicts > 0 ? [`- ${r.labelConflicts} labels stay: another label of the project already holds the repaired name.`] : []),
    ...(r.milestoneConflicts > 0 ? [`- ${r.milestoneConflicts} milestones stay: another milestone of the project already holds the repaired name.`] : []),
  ];
  if (r.samples.length > 0) lines.push('Samples:', ...r.samples.slice(0, SAMPLE_LINES).map((s) => `- ${s.field} ${s.ticketKey ?? ''}: "${s.before}" -> "${s.after}"`));
  const rows = r.replacementCharRows.slice(0, ROW_LINES);
  if (rows.length > 0) {
    lines.push('U+FFFD (the source character is lost; fix these by hand):', ...rows.map((x) => `- ${x.field} ${x.ticketKey ?? x.labelId ?? ''}${x.commentId ? ` comment ${x.commentId}` : ''}: ${x.excerpt}`));
    const more = r.replacementCharRows.length - rows.length + r.replacementCharOmitted;
    if (more > 0) lines.push(`... ${more} more U+FFFD values not listed.`);
  }
  const manual = r.manualRows.slice(0, ROW_LINES);
  if (manual.length > 0) {
    lines.push('Not repaired, fix these by hand (an Asana JSON comment may be the author\'s text; people are never renamed):',
      ...manual.map((x) => `- ${x.kind} ${x.kind === 'user' ? x.userId ?? '(no member)' : `${x.ticketKey ?? ''} comment ${x.commentId}`}: ${x.excerpt}`));
    const more = r.manualRows.length - manual.length + r.manualOmitted;
    if (more > 0) lines.push(`... ${more} more values to fix by hand not listed.`);
  }
  if (r.supported) lines.push('Show this to the user; repair only on their go with apply: true.');
  return lines.join('\n');
}

export function repairText(r: ImportCharRefsRepairResponse, calls: number): string {
  return [
    `Repaired in ${calls} batches: ${r.titles} titles, ${r.descriptions} descriptions, ${r.comments} comments, ${r.labels} labels, ${r.milestones} milestones in ${r.processedTickets} tickets.`,
    `Left as they are: ${r.edited} changed since the read, ${r.labelConflicts} label and ${r.milestoneConflicts} milestone name conflicts, ${r.replacementChar} values with U+FFFD.`,
    r.next === null ? 'Done.' : `Stopped after ${calls} batches; call again with apply: true, from: ${r.next} to continue.`,
  ].join('\n');
}

const MAX_BATCHES = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const stagedNotFound = (err: unknown): boolean => err instanceof OrbotoApiError && err.status === 404 && err.body.includes('errors.admin_import.staged_not_found');

export function makeImportCharRefsHandler(client: OrbotoClient) {
  return async ({ token, apply, from }: { token: string; apply?: boolean; from?: number }): Promise<CallToolResult> => {
    if (from !== undefined && (!Number.isInteger(from) || from < 0)) {
      return { isError: true, content: [{ type: 'text', text: `from must be a whole number of 0 or more, not ${from}; nothing was written.` }] };
    }
    const id = encodeURIComponent(token);
    let project = !UUID.test(token);
    if (!apply) {
      let report: ImportCharRefsReport;
      try {
        report = project
          ? await client.get<ImportCharRefsReport>(`/admin/import/projects/${id}/char-refs`)
          : await client.get<ImportCharRefsReport>(`/admin/import/jobs/${id}/char-refs`);
      } catch (err) {
        if (project || !stagedNotFound(err)) throw err;
        report = await client.get<ImportCharRefsReport>(`/admin/import/projects/${id}/char-refs`);
      }
      const { replacementCharRows, ...rest } = report;
      const { manualRows, ...fields } = rest;
      return { content: [{ type: 'text', text: reportText(report) }], structuredContent: { ...fields, replacementCharRows: replacementCharRows.slice(0, ROW_LINES), manualRows: manualRows.slice(0, ROW_LINES) } };
    }
    const post = async (at: number): Promise<ImportCharRefsRepairResponse> => {
      if (project) return client.post<ImportCharRefsRepairResponse>(`/admin/import/projects/${id}/char-refs/repair`, { from: at });
      try {
        return await client.post<ImportCharRefsRepairResponse>(`/admin/import/jobs/${id}/char-refs/repair`, { from: at });
      } catch (err) {
        if (!stagedNotFound(err)) throw err;
        project = true;
        return client.post<ImportCharRefsRepairResponse>(`/admin/import/projects/${id}/char-refs/repair`, { from: at });
      }
    };
    const total: ImportCharRefsRepairResponse = {
      processedTickets: 0, titles: 0, descriptions: 0, comments: 0, labels: 0, labelConflicts: 0, milestones: 0, milestoneConflicts: 0, edited: 0, replacementChar: 0, next: from ?? 0,
    };
    let calls = 0;
    while (total.next !== null && calls < MAX_BATCHES) {
      const res = await post(total.next);
      calls += 1;
      for (const key of ['processedTickets', 'titles', 'descriptions', 'comments', 'labels', 'labelConflicts', 'milestones', 'milestoneConflicts', 'edited', 'replacementChar'] as const) total[key] += res[key];
      total.next = res.next;
    }
    return { content: [{ type: 'text', text: repairText(total, calls) }], structuredContent: { ...total, batches: calls } };
  };
}

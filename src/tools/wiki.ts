/**
 * ORB-855 (LLM-Wiki Phase E) - MCP tools for the LLM-Wiki.
 *
 * Thin REST wrappers over the Phase B/C/D routes so an interactive AI
 * client can ingest sources, query the wiki, lint it, and write back to it
 * mid-task. No license gate (per the soft-cap pricing model). English-only
 * descriptions per the skill/MCP English rule.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OrbotoApiError, type OrbotoClient } from '../orboto-client.js';
import { SEMANTIC_DEGRADED_LINE, askTimingClause, replacedLines, reviewerFlaggedLine, rewriteDeadline, type AskReview, type AskTimings, type ReplacedRevision, DOC_ID_PARAM } from './shared.js';
import { resolveDocId } from './docs.js';

function text(t: string, structured?: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: t }], ...(structured ? { structuredContent: structured } : {}) };
}

export const wikiIngestUrlToolConfig = {
  title: 'Ingest a URL into an LLM-Wiki space',
  description:
    'Fetch a public URL, extract its main article as Markdown, and create a SOURCE doc in the space. On an LLM-Wiki space the ingest worker writes pages at once (auto-apply) or parks every ingest plan, stale re-ingests included, for review (review-gate; orboto_wiki_runs apply or reject); lint merges always apply directly, with receipt and undo. Wraps POST /spaces/:id/docs/ingest-url.',
  inputSchema: z.object({
    spaceId: z.string().uuid().describe('Target doc space (find via orboto_list_doc_spaces).'),
    url: z.string().url().max(2048),
    parentDocId: z.string().uuid().optional().describe('Nest the source under this doc.'),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};
export function makeWikiIngestUrlHandler(client: OrbotoClient) {
  return async (input: { spaceId: string; url: string; parentDocId?: string }): Promise<CallToolResult> => {
    const body: Record<string, unknown> = { url: input.url };
    if (input.parentDocId) body.parentDocId = input.parentDocId;
    const res = await client.post<{ docId: string; title: string }>(`/spaces/${input.spaceId}/docs/ingest-url`, body);
    return text(`Ingested source "${res.title}" (docId: ${res.docId}). If the space is LLM-Wiki-enabled the curation worker is now processing it.`, { docId: res.docId, title: res.title });
  };
}

export const wikiAskToolConfig = {
  title: 'Wiki Q&A with citations',
  description:
    'Retrieval-augmented Q&A over the docs corpus, optionally scoped to one space. Returns an answer with numbered citations linking back to source docs and where the time went. At most 6 passages reach the model. Answers within its deadline (25 s hosted, 120 s on a local provider; the operator can change it) or fails naming the phase that did not finish (retrieval or model); then search with orboto_search_docs. A "Reviewer flagged" line means the reviewer called claims in the answer invented or ran out of time: treat the answer as a draft. Requires both a chat AND an embedding provider (check orboto_ai_status). Wraps POST /ai/ask-docs.',
  inputSchema: z.object({
    question: z.string().min(1).max(2000),
    spaceId: z.string().uuid().optional().describe('Scope the search to one space; omit for the whole corpus.'),
    limit: z.number().int().min(1).max(20).optional().describe('Passages (default 5; model reads up to 6).'),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};
export function makeWikiAskHandler(client: OrbotoClient) {
  return async (input: { question: string; spaceId?: string; limit?: number }): Promise<CallToolResult> => {
    const body: Record<string, unknown> = { question: input.question };
    if (input.spaceId) body.spaceId = input.spaceId;
    if (input.limit) body.limit = input.limit;
    const res = await client.post<{ answer: string; citations: Array<{ index: number; title: string; link: string }>; mode: string; semanticDegraded?: boolean; timings?: AskTimings; review?: AskReview | null }>(`/ai/ask-docs`, body).catch(rewriteDeadline);
    const cites = res.citations.map((c) => `[${c.index}] ${c.title} - ${c.link}`).join('\n');
    const degraded = res.semanticDegraded ? `\n\n(${SEMANTIC_DEGRADED_LINE})` : '';
    const timing = res.timings ? `\n\nAnswered${askTimingClause(res.timings)}.` : '';
    const flagged = reviewerFlaggedLine(res.review);
    return text(`${res.answer}\n\n${cites ? `Sources:\n${cites}` : ''}`.trim() + timing + (flagged ? `\n\n${flagged}` : '') + degraded, { answer: res.answer, citations: res.citations, mode: res.mode, semanticDegraded: res.semanticDegraded ?? false, timings: res.timings ?? null, review: res.review ?? null });
  };
}

export const wikiLintToolConfig = {
  title: 'Lint a wiki space',
  description:
    'Lint an LLM-Wiki space for inconsistencies. It merges a duplicate page (same title or near-identical text) into the older one, whose stub keeps the key and smart links valid, queues a re-ingest from newer sources for a stale page instead of filing it, and finds orphan pages, missing cross-references, unprocessed sources and, when AI is configured, contradictions and undocumented concepts. Returns the open issues with a suggested fix, the merges and re-ingests, and a receipt with its undo for every merge. Wraps POST /spaces/:id/llm-wiki/lint.',
  inputSchema: z.object({
    spaceId: z.string().uuid().describe('The LLM-Wiki space to lint.'),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
};
type WikiPageLink = { id: string; key: string | null; title: string };
type WikiLintAnswer = {
  issues: Array<{ kind: string; message: string; suggestedFix: string | null; docId: string | null }>;
  detected: number;
  resolved: number;
  merged?: Array<{ from: WikiPageLink; into: WikiPageLink; undoCommand: string }>;
  reingested?: WikiPageLink[];
};
export function makeWikiLintHandler(client: OrbotoClient) {
  return async (input: { spaceId: string }): Promise<CallToolResult> => {
    const res = await client.post<WikiLintAnswer>(`/spaces/${input.spaceId}/llm-wiki/lint`, {});
    const lines = res.issues.length === 0
      ? ['No open lint issues.']
      : res.issues.map((i) => `- [${i.kind}] ${i.message}${i.suggestedFix ? ` (fix: ${i.suggestedFix})` : ''}`);
    const merged = res.merged ?? [];
    const reingested = res.reingested ?? [];
    const page = (p: WikiPageLink) => p.key ?? p.id;
    const done = [
      ...merged.map((m) => `- merged ${page(m.from)} into ${page(m.into)} (undo: ${m.undoCommand})`),
      ...reingested.map((p) => `- re-ingest queued for stale ${page(p)} "${p.title}"`),
    ];
    return text(`Lint complete: ${res.issues.length} open issue(s), ${res.resolved} auto-resolved, ${merged.length} merged, ${reingested.length} re-ingest(s) queued.\n${[...done, ...lines].join('\n')}`, { issues: res.issues, detected: res.detected, resolved: res.resolved, merged, reingested });
  };
}

export type DroppedOp = { title: string; target: string | null; reason: string };

/** ORB-2226 - planner ops whose target page matched no docId, doc key or title. */
export function droppedLines(dropped: DroppedOp[]): string {
  if (dropped.length === 0) return '';
  return `\nOps dropped: ${dropped.length}\n${dropped.map((d) => `- ${d.title}${d.target ? ` (target ${d.target})` : ''}: ${d.reason}`).join('\n')}`;
}

export const wikiPlanUpdateToolConfig = {
  title: 'Plan a wiki edit (dry-run, no writes)',
  description:
    'Turn a natural-language instruction into page operations (create/patch/append) WITHOUT writing anything. Returns a planId valid for 15 minutes plus the proposed ops, and droppedOps: ops whose target page matched no docId, doc key or title. Review the ops, then call orboto_wiki_apply_plan to commit. Wraps POST /spaces/:id/docs/plan-update.',
  inputSchema: z.object({
    spaceId: z.string().uuid(),
    instruction: z.string().min(1).max(4000).describe('What to change, in plain language.'),
    sourceDocId: z.string().uuid().optional().describe('A source doc to draw content from.'),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: false },
};
export function makeWikiPlanUpdateHandler(client: OrbotoClient) {
  return async (input: { spaceId: string; instruction: string; sourceDocId?: string }): Promise<CallToolResult> => {
    const body: Record<string, unknown> = { instruction: input.instruction };
    if (input.sourceDocId) body.sourceDocId = input.sourceDocId;
    const res = await client.post<{ planId: string; ops: Array<{ op: string; title?: string; summary: string }>; droppedOps?: DroppedOp[]; expiresAt: string }>(`/spaces/${input.spaceId}/docs/plan-update`, body);
    const ops = res.ops.map((o, i) => `${i + 1}. ${o.op} ${o.title ?? ''} - ${o.summary}`).join('\n');
    const droppedOps = res.droppedOps ?? [];
    return text(`Plan ${res.planId} (expires ${res.expiresAt}):\n${ops}${droppedLines(droppedOps)}\n\nApply with orboto_wiki_apply_plan(planId).`, { planId: res.planId, ops: res.ops, droppedOps, expiresAt: res.expiresAt });
  };
}

export const wikiApplyPlanToolConfig = {
  title: 'Apply a planned wiki edit',
  description:
    'Commit the page operations from a plan created by orboto_wiki_plan_update. Applies every op atomically (each page edit is snapshotted for rollback), then rebuilds the index doc of the space and appends a line to its log doc. A patch op rewrites its page at once, even when it drops most of it (replace: true is accepted and not required); each rewritten page comes back in replaced with the revision and the restore command, and every write carries its receipt. Fails with 410 if the plan has expired (>15 min) or was already applied. Wraps POST /spaces/:id/docs/apply-plan.',
  inputSchema: z.object({
    spaceId: z.string().uuid(),
    planId: z.string().uuid().describe('From orboto_wiki_plan_update.'),
    replace: z.boolean().optional(),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};
export function makeWikiApplyPlanHandler(client: OrbotoClient) {
  return async (input: { spaceId: string; planId: string; replace?: boolean }): Promise<CallToolResult> => {
    const res = await client.post<{ touchedDocs: string[]; replaced?: ReplacedRevision[] }>(`/spaces/${input.spaceId}/docs/apply-plan`, { planId: input.planId, ...(input.replace ? { replace: true } : {}) });
    const replaced = res.replaced ?? [];
    return text(`Applied plan ${input.planId}: ${res.touchedDocs.length} page(s) updated.${replacedLines(replaced)}`, { touchedDocs: res.touchedDocs, replaced });
  };
}

/** ORB-2774 - the apply of a supersede op whose page moved since the plan read it; the record tool plans once more. */
const SUPERSEDE_CONFLICT = 'errors.docs.supersede_conflict';

export const wikiRecordToolConfig = {
  title: 'Record a wiki update (plan + apply)',
  description:
    'Plan and apply a wiki edit in one step. Use it mid-task to capture a fact or update a page without the two-step review loop. Internally calls plan-update then apply-plan. For a reviewable change, use orboto_wiki_plan_update instead.',
  inputSchema: z.object({
    spaceId: z.string().uuid(),
    instruction: z.string().min(1).max(4000).describe('What to record, in plain language.'),
    sourceDocId: z.string().uuid().optional(),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};
export function makeWikiRecordHandler(client: OrbotoClient) {
  return async (input: { spaceId: string; instruction: string; sourceDocId?: string }): Promise<CallToolResult> => {
    const planBody: Record<string, unknown> = { instruction: input.instruction };
    if (input.sourceDocId) planBody.sourceDocId = input.sourceDocId;
    const planAndApply = async () => {
      const plan = await client.post<{ planId: string; droppedOps?: DroppedOp[] }>(`/spaces/${input.spaceId}/docs/plan-update`, planBody);
      const applied = await client.post<{ touchedDocs: string[] }>(`/spaces/${input.spaceId}/docs/apply-plan`, { planId: plan.planId });
      return { plan, applied };
    };
    const { plan, applied } = await planAndApply().catch((err: unknown) => {
      if (err instanceof OrbotoApiError && err.status === 409 && err.body.includes(SUPERSEDE_CONFLICT)) return planAndApply();
      throw err;
    });
    const droppedOps = plan.droppedOps ?? [];
    return text(`Recorded: ${applied.touchedDocs.length} page(s) updated.${droppedLines(droppedOps)}`, { planId: plan.planId, touchedDocs: applied.touchedDocs, droppedOps });
  };
}

export const wikiAppendSectionToolConfig = {
  title: 'Append a section to a wiki page (idempotent)',
  description:
    'Append a Markdown section to a doc. Idempotent: appending identical content a second time is a no-op, so this is safe to call repeatedly (e.g. across multiple ingests). Wraps POST /docs/:id/append-section.',
  inputSchema: z.object({
    docId: z.string().min(1).describe(DOC_ID_PARAM),
    content: z.string().min(1).max(50_000),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
};
export function makeWikiAppendSectionHandler(client: OrbotoClient) {
  return async (input: { docId: string; content: string }): Promise<CallToolResult> => {
    input.docId = await resolveDocId(client, input.docId);
    const res = await client.post<{ appended: boolean }>(`/docs/${input.docId}/append-section`, { content: input.content });
    return text(res.appended ? 'Section appended.' : 'No change - an identical section is already present.', { appended: res.appended });
  };
}

export const wikiSaveAnswerToolConfig = {
  title: 'Save a Q&A answer as a wiki page',
  description:
    'Save an answer (as from orboto_wiki_ask) as a wiki page linking its citations. Idempotent per (space, question): re-saving the same question updates the page instead of duplicating it. A re-save rewrites the saved page at once, even when it drops most of it (replace: true is accepted and not required); an update names the revision it replaced and the restore command. Wraps POST /ai/save-answer-to-wiki.',
  inputSchema: z.object({
    spaceId: z.string().uuid(),
    question: z.string().min(3).max(1000),
    answer: z.string().min(1).max(50_000),
    title: z.string().max(200).optional().describe('Defaults to the question.'),
    parentDocId: z.string().uuid().optional(),
    citations: z.array(z.object({ docId: z.string().min(1).describe(DOC_ID_PARAM), title: z.string() })).max(50).optional().describe('From orboto_wiki_ask.'),
    replace: z.boolean().optional(),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
};
export function makeWikiSaveAnswerHandler(client: OrbotoClient) {
  return async (input: { spaceId: string; question: string; answer: string; title?: string; parentDocId?: string; citations?: Array<{ docId: string; title: string }>; replace?: boolean }): Promise<CallToolResult> => {
    const res = await client.post<{ docId: string; created: boolean; replaced?: ReplacedRevision | null }>(`/ai/save-answer-to-wiki`, { ...input, citations: input.citations ?? [] });
    const replaced = res.replaced ? [res.replaced] : [];
    return text(res.created ? `Saved as a new wiki page (docId: ${res.docId}).` : `Updated the existing wiki page (docId: ${res.docId}).${replacedLines(replaced)}`, { docId: res.docId, created: res.created, replaced: res.replaced ?? null });
  };
}

export const wikiFlagStaleToolConfig = {
  title: 'Flag or clear a stale wiki page',
  description:
    'Set or clear the "may be outdated" flag on a page. The flag surfaces passively as a pill in the UI; it does not change the content. Pass stale=false to clear. Wraps POST /docs/:id/flag-stale.',
  inputSchema: z.object({
    docId: z.string().min(1).describe(DOC_ID_PARAM),
    stale: z.boolean().optional().describe('true to flag (default), false to clear.'),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
};
export function makeWikiFlagStaleHandler(client: OrbotoClient) {
  return async (input: { docId: string; stale?: boolean }): Promise<CallToolResult> => {
    input.docId = await resolveDocId(client, input.docId);
    const res = await client.post<{ staleFlagged: boolean }>(`/docs/${input.docId}/flag-stale`, { stale: input.stale ?? true });
    return text(res.staleFlagged ? 'Page flagged as possibly outdated.' : 'Stale flag cleared.', { staleFlagged: res.staleFlagged });
  };
}

/** ORB-2611 - the wait or run time of a queued run, and its stall. */
function queuedNote(r: { status: string; createdAt: string; queuedAt?: string | null; startedAt?: string | null; ageSeconds?: number | null; stalled?: boolean }): string {
  if (r.status !== 'queued') return '';
  const waited = r.startedAt ? (Date.parse(r.startedAt) - Date.parse(r.queuedAt ?? r.createdAt)) / 1000 : 0;
  const minutes = Math.max(1, Math.round(Math.max(0, (r.ageSeconds ?? 0) - waited) / 60));
  return ` (${r.startedAt ? 'running' : 'waiting'} ${minutes} min${r.stalled ? ', stalled' : ''})`;
}

export const wikiRunsToolConfig = {
  title: 'Wiki ingest runs',
  description: 'List a wiki space\'s ingest runs (queued: wait and stall, failed: each error, pending_review: plans waiting for review), show one run\'s plan as a diff, retry a failed or stalled run, or apply or reject (reason required) a pending_review run (space:wiki-config).',
  inputSchema: z.object({
    spaceId: z.string().min(1),
    action: z.enum(['list', 'show', 'retry', 'apply', 'reject']).optional(),
    runId: z.string().uuid().optional(),
    status: z.enum(['pending_review', 'applied', 'failed', 'skipped', 'queued', 'rejected']).optional(),
    reason: z.string().max(2000).optional(),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};

type RunLine = { id: string; kind?: string; target?: { key: string | null; title: string } | null; review?: { decision: string; outcome?: string; byName: string | null; reason: string | null } | null; canReview?: boolean; sourceKey: string | null; sourceTitle: string; status: string; error: string | null; droppedOps?: DroppedOp[]; createdAt: string; queuedAt?: string | null; startedAt?: string | null; ageSeconds?: number | null; stalled?: boolean };
type PlanOp = { action: string; title: string; summary: string; target: { key: string | null; title: string; missing: boolean } | null; removed: string | null; added: string };

/** ORB-2802 - a stale re-ingest names its page; a reviewed run names the decision. */
function runNote(r: RunLine): string {
  const stale = r.kind === 'stale_reingest' ? ` stale re-ingest of ${r.target?.key ?? ''} "${r.target?.title ?? ''}" from` : '';
  const by = r.review?.byName ?? 'unknown';
  const verb = r.review?.outcome === 'failed' ? `apply by ${by} failed` : r.review?.outcome === 'skipped' ? `applied by ${by}, nothing written` : `${r.review?.decision} by ${by}`;
  const review = r.review ? ` (${verb}${r.review.reason ? `: ${r.review.reason}` : ''})` : '';
  return `${stale}${review}`;
}

/** ORB-2802 - one plan op as a diff: removed lines with "- ", added lines with "+ ". */
function opLines(op: PlanOp): string[] {
  const target = op.target ? ` -> ${op.target.key ?? ''} "${op.target.title}"${op.target.missing ? ' (skipped: target missing)' : ''}` : '';
  const prefix = (sign: string, text: string) => text.split('\n').map((l) => `${sign} ${l}`);
  return [`${op.action} "${op.title}"${target}${op.summary ? ` - ${op.summary}` : ''}`, ...(op.removed ? prefix('-', op.removed) : []), ...prefix('+', op.added)];
}

export function makeWikiRunsHandler(client: OrbotoClient) {
  return async (input: { spaceId: string; action?: 'list' | 'show' | 'retry' | 'apply' | 'reject'; runId?: string; status?: string; reason?: string }): Promise<CallToolResult> => {
    const runs = `/spaces/${encodeURIComponent(input.spaceId)}/llm-wiki/ingest-runs`;
    if (input.action && input.action !== 'list') {
      if (!input.runId) return { isError: true, content: [{ type: 'text', text: `action ${input.action} needs the runId (action list; status failed or queued for retry, pending_review for apply and reject).` }] };
      if (input.action === 'reject' && !input.reason?.trim()) return { isError: true, content: [{ type: 'text', text: 'action reject needs a reason; the creator of the run reads it.' }] };
    }
    if (input.action === 'retry') {
      const res = await client.post<{ runId: string; status: string; queued: boolean; error: string | null }>(`${runs}/${input.runId}/retry`, {});
      return text(res.queued ? `Run ${res.runId} is queued for the ingest worker again.` : `Run ${res.runId} ran again: ${res.status}${res.error ? ` - ${res.error}` : ''}.`, res);
    }
    if (input.action === 'show') {
      const res = await client.get<{ run: RunLine; logLine: string | null; ops: PlanOp[] | null; sources: Array<{ key: string | null; title: string }> }>(`${runs}/${input.runId}`);
      const head = `${res.run.id} ${res.run.status}${runNote(res.run)} ${res.run.sourceKey ?? ''} "${res.run.sourceTitle}"${res.run.canReview ? ' - you can apply or reject it' : ''}`;
      const plan = res.ops === null ? ['(the plan is hidden: you cannot open its source)'] : res.ops.flatMap(opLines);
      const sources = res.sources.length ? [`Sources: ${res.sources.map((s) => s.key ?? s.title).join(', ')}`] : [];
      return text([head, ...plan, ...sources, ...(res.logLine ? [`Log: ${res.logLine}`] : [])].join('\n'), res);
    }
    if (input.action === 'apply') {
      const res = await client.post<{ runId: string; status: string; pages: string[]; error: string | null }>(`${runs}/${input.runId}/apply`, input.reason?.trim() ? { reason: input.reason.trim() } : {});
      const line = res.status === 'failed' ? `Run ${res.runId} failed: ${res.error ?? 'no reason given'}`
        : res.status === 'skipped' ? `Run ${res.runId} was skipped and wrote nothing: ${res.error ?? 'the plan changed nothing'}`
          : `Run ${res.runId} applied: ${res.pages.length} pages (${res.pages.join(', ')}).`;
      return text(line, res);
    }
    if (input.action === 'reject') {
      const res = await client.post<{ runId: string; status: string; reason: string }>(`${runs}/${input.runId}/reject`, { reason: input.reason!.trim() });
      return text(`Run ${res.runId} rejected: ${res.reason}`, res);
    }
    const qs = input.status ? `?status=${input.status}` : '';
    const res = await client.get<{ runs: RunLine[] }>(`${runs}${qs}`);
    const lines = res.runs.map((r) => `- ${r.id} ${r.status}${queuedNote(r)}${runNote(r)} ${r.sourceKey ?? ''} "${r.sourceTitle}" ${r.createdAt}${r.droppedOps?.length ? ` (ops dropped: ${r.droppedOps.length})` : ''}${r.canReview ? ' (apply or reject)' : ''}${r.error ? ` - ${r.error}` : ''}`);
    return text(lines.length ? lines.join('\n') : 'No ingest runs.', res);
  };
}

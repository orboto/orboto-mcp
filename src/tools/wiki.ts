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
import type { OrbotoClient } from '../orboto-client.js';
import { resolveDocId } from './docs.js';

function text(t: string, structured?: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: t }], ...(structured ? { structuredContent: structured } : {}) };
}

// --- orboto_wiki_ingest_url ------------------------------------------------

export const wikiIngestUrlToolConfig = {
  title: 'Ingest a URL into an LLM-Wiki space',
  description:
    'Fetch a public URL, extract its main article as Markdown, and create a SOURCE doc in the space. When the space has the LLM-Wiki enabled, this also enqueues the auto-ingest worker, which curates the source into wiki pages (immediately under auto-apply, or as a pending plan under review-gate). Wraps POST /spaces/:id/docs/ingest-url.',
  inputSchema: z.object({
    spaceId: z.string().uuid().describe('Target doc space (find via orboto_list_doc_spaces).'),
    url: z.string().url().max(2048).describe('Public URL to import.'),
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

// --- orboto_wiki_ask -------------------------------------------------------

export const wikiAskToolConfig = {
  title: 'Ask a question over the wiki (RAG with citations)',
  description:
    'Retrieval-augmented Q&A over the docs corpus, optionally scoped to one space. Returns an answer with numbered citations linking back to source docs. Requires both a chat AND an embedding provider (check orboto_ai_status). Wraps POST /ai/ask-docs.',
  inputSchema: z.object({
    question: z.string().min(1).max(2000).describe('Natural-language question.'),
    spaceId: z.string().uuid().optional().describe('Scope the search to one space; omit for the whole corpus.'),
    limit: z.number().int().min(1).max(20).optional().describe('Max source docs to retrieve (default 5).'),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};
export function makeWikiAskHandler(client: OrbotoClient) {
  return async (input: { question: string; spaceId?: string; limit?: number }): Promise<CallToolResult> => {
    const body: Record<string, unknown> = { question: input.question };
    if (input.spaceId) body.spaceId = input.spaceId;
    if (input.limit) body.limit = input.limit;
    const res = await client.post<{ answer: string; citations: Array<{ index: number; title: string; link: string }>; mode: string }>(`/ai/ask-docs`, body);
    const cites = res.citations.map((c) => `[${c.index}] ${c.title} - ${c.link}`).join('\n');
    return text(`${res.answer}\n\n${cites ? `Sources:\n${cites}` : ''}`.trim(), { answer: res.answer, citations: res.citations, mode: res.mode });
  };
}

// --- orboto_wiki_lint ------------------------------------------------------

export const wikiLintToolConfig = {
  title: 'Run the LLM-Wiki lint pass on a space',
  description:
    'Scan an LLM-Wiki space for inconsistencies (orphan pages, missing cross-references, stale pages, unprocessed sources, and - when AI is configured - contradictions and undocumented concepts). Returns the open issues, each with a suggested fix. Wraps POST /spaces/:id/llm-wiki/lint.',
  inputSchema: z.object({
    spaceId: z.string().uuid().describe('The LLM-Wiki space to lint.'),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
};
export function makeWikiLintHandler(client: OrbotoClient) {
  return async (input: { spaceId: string }): Promise<CallToolResult> => {
    const res = await client.post<{ issues: Array<{ kind: string; message: string; suggestedFix: string | null; docId: string | null }>; detected: number; resolved: number }>(`/spaces/${input.spaceId}/llm-wiki/lint`, {});
    const lines = res.issues.length === 0
      ? ['No open lint issues.']
      : res.issues.map((i) => `- [${i.kind}] ${i.message}${i.suggestedFix ? ` (fix: ${i.suggestedFix})` : ''}`);
    return text(`Lint complete: ${res.issues.length} open issue(s), ${res.resolved} auto-resolved.\n${lines.join('\n')}`, { issues: res.issues, detected: res.detected, resolved: res.resolved });
  };
}

// --- orboto_wiki_plan_update / apply_plan ----------------------------------

export const wikiPlanUpdateToolConfig = {
  title: 'Plan a wiki edit (dry-run, no writes)',
  description:
    'Turn a natural-language instruction into a concrete set of page operations (create / patch / append) WITHOUT writing anything. Returns a planId valid for 15 minutes plus the proposed ops. Review the ops, then call orboto_wiki_apply_plan to commit. Wraps POST /spaces/:id/docs/plan-update.',
  inputSchema: z.object({
    spaceId: z.string().uuid().describe('The wiki space to edit.'),
    instruction: z.string().min(1).max(4000).describe('What to change, in plain language.'),
    sourceDocId: z.string().uuid().optional().describe('A source doc to draw content from.'),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: false },
};
export function makeWikiPlanUpdateHandler(client: OrbotoClient) {
  return async (input: { spaceId: string; instruction: string; sourceDocId?: string }): Promise<CallToolResult> => {
    const body: Record<string, unknown> = { instruction: input.instruction };
    if (input.sourceDocId) body.sourceDocId = input.sourceDocId;
    const res = await client.post<{ planId: string; ops: Array<{ op: string; title?: string; summary: string }>; expiresAt: string }>(`/spaces/${input.spaceId}/docs/plan-update`, body);
    const ops = res.ops.map((o, i) => `${i + 1}. ${o.op} ${o.title ?? ''} - ${o.summary}`).join('\n');
    return text(`Plan ${res.planId} (expires ${res.expiresAt}):\n${ops}\n\nApply with orboto_wiki_apply_plan(planId).`, { planId: res.planId, ops: res.ops, expiresAt: res.expiresAt });
  };
}

export const wikiApplyPlanToolConfig = {
  title: 'Apply a previously-planned wiki edit',
  description:
    'Commit the page operations from a plan created by orboto_wiki_plan_update. Applies every op atomically (each page edit is snapshotted for rollback). Fails with 410 if the plan has expired (>15 min) or was already applied. Wraps POST /spaces/:id/docs/apply-plan.',
  inputSchema: z.object({
    spaceId: z.string().uuid(),
    planId: z.string().uuid().describe('The planId returned by orboto_wiki_plan_update.'),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};
export function makeWikiApplyPlanHandler(client: OrbotoClient) {
  return async (input: { spaceId: string; planId: string }): Promise<CallToolResult> => {
    const res = await client.post<{ touchedDocs: string[] }>(`/spaces/${input.spaceId}/docs/apply-plan`, { planId: input.planId });
    return text(`Applied plan ${input.planId}: ${res.touchedDocs.length} page(s) updated.`, { touchedDocs: res.touchedDocs });
  };
}

// --- orboto_wiki_record (convenience: plan + apply) ------------------------

export const wikiRecordToolConfig = {
  title: 'Record a wiki update in one step (plan + apply)',
  description:
    'Convenience wrapper that plans an edit from your instruction and immediately applies it - use mid-task to capture a fact or update a page without the two-step review loop. Internally calls plan-update then apply-plan. For a reviewable change, use orboto_wiki_plan_update instead.',
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
    const plan = await client.post<{ planId: string }>(`/spaces/${input.spaceId}/docs/plan-update`, planBody);
    const applied = await client.post<{ touchedDocs: string[] }>(`/spaces/${input.spaceId}/docs/apply-plan`, { planId: plan.planId });
    return text(`Recorded: ${applied.touchedDocs.length} page(s) updated.`, { planId: plan.planId, touchedDocs: applied.touchedDocs });
  };
}

// --- orboto_wiki_append_section -------------------------------------------

export const wikiAppendSectionToolConfig = {
  title: 'Append a section to a wiki page (idempotent)',
  description:
    'Append a Markdown section to a doc. Idempotent: appending identical content a second time is a no-op, so this is safe to call repeatedly (e.g. across multiple ingests). Wraps POST /docs/:id/append-section.',
  inputSchema: z.object({
    docId: z.string().min(1).describe('The page to append to - UUID or doc key (ORB-D12 / DOC-5).'),
    content: z.string().min(1).max(50_000).describe('Markdown section to append.'),
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

// --- orboto_wiki_save_answer -----------------------------------------------

export const wikiSaveAnswerToolConfig = {
  title: 'Save a Q&A answer as a wiki page',
  description:
    'Turn an answer (e.g. from orboto_wiki_ask) into a curated wiki page with smart-links to its citations. Idempotent per (space, question): re-saving the same question updates the page instead of duplicating it. Wraps POST /ai/save-answer-to-wiki.',
  inputSchema: z.object({
    spaceId: z.string().uuid(),
    question: z.string().min(3).max(1000),
    answer: z.string().min(1).max(50_000),
    title: z.string().max(200).optional().describe('Page title; defaults to the question.'),
    parentDocId: z.string().uuid().optional(),
    citations: z.array(z.object({ docId: z.string().min(1).describe('Doc UUID or human-readable doc key (ORB-D12 / DOC-5).'), title: z.string() })).max(50).optional().describe('Cited docs to smart-link (from orboto_wiki_ask).'),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
};
export function makeWikiSaveAnswerHandler(client: OrbotoClient) {
  return async (input: { spaceId: string; question: string; answer: string; title?: string; parentDocId?: string; citations?: Array<{ docId: string; title: string }> }): Promise<CallToolResult> => {
    const res = await client.post<{ docId: string; created: boolean }>(`/ai/save-answer-to-wiki`, { ...input, citations: input.citations ?? [] });
    return text(res.created ? `Saved as a new wiki page (docId: ${res.docId}).` : `Updated the existing wiki page (docId: ${res.docId}).`, { docId: res.docId, created: res.created });
  };
}

// --- orboto_wiki_flag_stale ------------------------------------------------

export const wikiFlagStaleToolConfig = {
  title: 'Flag (or unflag) a wiki page as possibly outdated',
  description:
    'Set or clear the "may be outdated" flag on a page. The flag surfaces passively as a pill in the UI; it does not change the content. Pass stale=false to clear. Wraps POST /docs/:id/flag-stale.',
  inputSchema: z.object({
    docId: z.string().min(1).describe('Doc UUID or human-readable doc key (ORB-D12 / DOC-5).'),
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

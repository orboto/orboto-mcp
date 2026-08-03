/**
 * ORB-1342 (epic ORB-1339) - doc snippet-search + targeted-edit MCP tools.
 *
 * Phase-3 four-way-sync rollout of the two REST primitives shipped in
 * ORB-1340 (GET /docs/search) and ORB-1341 (POST /docs/:id/edits). The
 * whole point of the feature is context efficiency: an agent finds the
 * right passage with one search (snippet + heading anchor, NOT the full
 * doc body) and changes it with one edit that ships only the diff in both
 * directions. Prefer these over orboto_get_doc + orboto_update_doc for
 * small changes to a large doc.
 *
 * Three tools:
 *   - orboto_search_docs       GET  /docs/search
 *   - orboto_edit_doc          POST /docs/:id/edits (string-replace edits)
 *   - orboto_edit_doc_section  POST /docs/:id/edits (heading-addressed ops)
 *
 * The two edit tools hit the same endpoint with a different half of its
 * body, so they share the 409-conflict translation below: a machine-
 * readable conflict (no/ambiguous match, stale revision, heading not
 * found / ambiguous) comes back as a NON-throwing tool result with
 * `isError: true` so the model can self-correct instead of the raw API
 * error bubbling up as an opaque failure.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OrbotoApiError, type OrbotoClient } from '../orboto-client.js';
import { resolveDocId } from './docs.js';
import { resolveProjectByKey } from './shared.js';

// ---------------------------------------------------------------------------
// Shared response shapes (mirror @orboto/shared-schema exactly - off-shape
// rows 500 the tool because the API's Zod response validator rejects them).
// ---------------------------------------------------------------------------

interface DocSnippetHit {
  id: string;
  docKey: string | null;
  title: string;
  spaceId: string;
  spaceName: string | null;
  projectId: string | null;
  snippet: string;
  headingPath: string[];
  charOffset: number;
  lineOffset: number;
  rank: number;
  url: string;
}
interface DocSnippetSearchResponse {
  items: DocSnippetHit[];
  total: number;
}

interface DocEditWindow {
  index: number;
  kind: 'edit' | 'sectionOp';
  replaced: number;
  window: string;
}
interface DocEditsResult {
  docId: string;
  docKey: string | null;
  revisionId: string | null;
  edits: DocEditWindow[];
}

/** Machine-readable 409 body (DocEditConflictSchema). */
interface DocEditConflict {
  error?: string;
  errorKey?: string;
  reason?: string;
  editIndex?: number;
  occurrences?: number;
  oldString?: string;
  headingPath?: string[];
  candidates?: string[];
  currentRevisionId?: string | null;
}

// ---------------------------------------------------------------------------
// 409 translation - shared by both edit tools.
// ---------------------------------------------------------------------------

/** Turn a 409 from POST /docs/:id/edits into a clear, non-throwing tool
 *  result the model can act on. Returns null for any non-409 so the caller
 *  rethrows (a genuine transport/permission failure should still surface). */
function editConflictResult(err: unknown): CallToolResult | null {
  if (!(err instanceof OrbotoApiError) || err.status !== 409) return null;
  let c: DocEditConflict = {};
  try { c = JSON.parse(err.body) as DocEditConflict; } catch { /* non-JSON body */ }

  let text: string;
  switch (c.reason) {
    case 'no_match':
      text =
        `⛔ Edit ${c.editIndex} did not apply: oldString was not found in the doc (0 matches).\n` +
        `The doc content may differ from what you expected. Re-read the passage (orboto_search_docs or orboto_get_doc) and rebuild the oldString to match exactly, whitespace included.`;
      break;
    case 'ambiguous_match':
      text =
        `⛔ Edit ${c.editIndex} did not apply: oldString matched ${c.occurrences ?? 'multiple'} times.\n` +
        `Add surrounding context so the oldString is unique, or pass replaceAll=true to change every occurrence deliberately.`;
      break;
    case 'stale_revision':
      text =
        `⛔ Doc changed since your baseRevisionId; nothing was written.\n` +
        `Re-read the doc, rebuild the edit against the current content, and retry with baseRevisionId="${c.currentRevisionId ?? 'null'}".`;
      break;
    case 'heading_not_found':
      text =
        `⛔ Section op ${c.editIndex}: no heading matched the path [${(c.headingPath ?? []).join(' > ')}].\n` +
        `Heading matching is exact + case-sensitive. Check the exact heading text (orboto_search_docs returns each hit's headingPath).`;
      break;
    case 'ambiguous_heading':
      text =
        `⛔ Section op ${c.editIndex}: the heading path [${(c.headingPath ?? []).join(' > ')}] matched multiple headings.\n` +
        (c.candidates?.length ? `Candidates: ${c.candidates.join(' | ')}.\n` : '') +
        `Narrow the path by adding ancestor headings to disambiguate.`;
      break;
    default:
      text = `⛔ Edit rejected (409): ${c.error ?? (err.body || 'conflict')}.`;
  }
  return {
    content: [{ type: 'text', text }],
    structuredContent: { conflict: true, ...c },
    isError: true,
  };
}

function renderEditResult(res: DocEditsResult): CallToolResult {
  const lines = [
    `Applied ${res.edits.length} change(s) to doc ${res.docKey ?? res.docId}.`,
    `  new revisionId: ${res.revisionId ?? '(no content change)'}`,
    '',
    ...res.edits.map((w) => `  [${w.index}] ${w.kind} · replaced ${w.replaced} · …${w.window}…`),
  ];
  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    structuredContent: {
      docId: res.docId,
      docKey: res.docKey ?? null,
      revisionId: res.revisionId,
      edits: res.edits.map((w) => ({
        index: w.index,
        kind: w.kind,
        replaced: w.replaced,
        window: w.window,
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// orboto_search_docs  (GET /docs/search - ORB-1340)
// ---------------------------------------------------------------------------

export const searchDocsToolConfig = {
  title: 'Search docs for snippets (context-efficient)',
  description:
    'Full-text search across wiki docs that returns a highlighted SNIPPET (matched fragments, <mark>…</mark> around each hit) plus the nearest markdown heading path (section anchor) and char/line offset per hit - WITHOUT echoing the full doc body. Use this instead of orboto_get_doc when you only need to locate a passage: find the right doc + section, then change it with orboto_edit_doc / orboto_edit_doc_section, all without transferring the whole document. ACL-filtered in SQL (you only see docs you can read). Ranked by relevance.',
  inputSchema: z.object({
    q: z.string().min(1).max(10_000).describe('Search terms. Keyword FTS (tsvector); more distinctive words rank higher.'),
    projectKey: z.string().min(1).optional().describe('Scope to one project by key (e.g. "ORB"). Resolved to the project UUID.'),
    spaceId: z.string().uuid().optional().describe('Scope to one doc space by UUID (discover via orboto_list_doc_spaces).'),
    limit: z.number().int().positive().max(100).default(20).describe('Max hits (default 20, max 100).'),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeSearchDocsHandler(client: OrbotoClient) {
  return async (input: {
    q: string; projectKey?: string; spaceId?: string; limit?: number;
  }): Promise<CallToolResult> => {
    const qs = new URLSearchParams({ q: input.q });
    if (input.spaceId) qs.set('spaceId', input.spaceId);
    if (input.projectKey) {
      const project = await resolveProjectByKey(client, input.projectKey);
      qs.set('projectId', project.id);
    }
    if (input.limit) qs.set('limit', String(input.limit));

    const res = await client.get<DocSnippetSearchResponse>(`/docs/search?${qs.toString()}`);
    if (res.items.length === 0) {
      return {
        content: [{ type: 'text', text: `No docs matched "${input.q}".` }],
        structuredContent: { items: [], total: 0 },
      };
    }
    const lines = res.items.map((h) => {
      const anchor = h.headingPath.length ? `  §${h.headingPath.join(' > ')}` : '';
      const where = h.charOffset >= 0 ? `  (line ${h.lineOffset})` : '';
      return `- ${h.title} (${h.docKey ?? h.id})${anchor}${where}\n    ${h.snippet.replace(/\s+/g, ' ').trim()}`;
    });
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: {
        items: res.items.map((h) => ({
          id: h.id,
          docKey: h.docKey,
          title: h.title,
          spaceId: h.spaceId,
          spaceName: h.spaceName,
          projectId: h.projectId,
          snippet: h.snippet,
          headingPath: h.headingPath,
          charOffset: h.charOffset,
          lineOffset: h.lineOffset,
          rank: h.rank,
          url: h.url,
        })),
        total: res.total,
      },
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_edit_doc  (POST /docs/:id/edits - string-replace, ORB-1341)
// ---------------------------------------------------------------------------

export const editDocToolConfig = {
  title: 'Targeted string-replace edit of a doc (context-efficient)',
  description:
    'Change a doc by byte-precise string replacement (Edit-tool-like) - ship only the diff, not the whole doc. Each oldString must match EXACTLY ONCE in the current content (add surrounding context to make it unique) unless replaceAll=true (then >=1). The whole batch is atomic: any match failure applies nothing and returns a 409 you can act on. Prefer this over orboto_update_doc for small changes to a large doc. Pass baseRevisionId (from a previous edit\'s revisionId or orboto_list_doc_revisions) for optimistic concurrency - a stale token is rejected with the current revision id instead of clobbering a concurrent change. Returns a short context window around each change, not the full doc.',
  inputSchema: z.object({
    docId: z.string().min(1).describe('Doc UUID or human-readable key (ORB-D12 / DOC-5). Find via orboto_search_docs.'),
    edits: z.array(z.object({
      oldString: z.string().min(1).describe('Exact substring to replace. Must be unique in the doc unless replaceAll.'),
      newString: z.string().describe('Replacement text (may be empty to delete).'),
      replaceAll: z.boolean().optional().describe('Replace every occurrence instead of requiring exactly one.'),
    })).min(1).max(100).describe('Applied sequentially; edit N sees the result of edits 0..N-1.'),
    baseRevisionId: z.string().uuid().optional().describe('Optimistic-concurrency token = the revision id you last saw. Omit to always apply.'),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};

export function makeEditDocHandler(client: OrbotoClient) {
  return async (input: {
    docId: string;
    edits: Array<{ oldString: string; newString: string; replaceAll?: boolean }>;
    baseRevisionId?: string;
  }): Promise<CallToolResult> => {
    const docId = await resolveDocId(client, input.docId);
    const body: Record<string, unknown> = { edits: input.edits };
    if (input.baseRevisionId) body.baseRevisionId = input.baseRevisionId;
    try {
      const res = await client.post<DocEditsResult>(`/docs/${docId}/edits`, body);
      return renderEditResult(res);
    } catch (err) {
      const conflict = editConflictResult(err);
      if (conflict) return conflict;
      throw err;
    }
  };
}

// ---------------------------------------------------------------------------
// orboto_edit_doc_section  (POST /docs/:id/edits - section ops, ORB-1341)
// ---------------------------------------------------------------------------

export const editDocSectionToolConfig = {
  title: 'Edit a doc section by heading path (context-efficient)',
  description:
    'Change a doc by markdown-heading-addressed section operations - ship only the new section content, not the whole doc. A section is addressed by its heading path (e.g. ["Setup","Credentials"] = a "Credentials" heading nested under "Setup"). Heading matching is EXACT + case-sensitive; the leading path elements must be an ordered ancestor chain (not necessarily immediate parents). op=replace swaps the section body, op=append adds to its end, op=insertAfter inserts directly below the heading line (the heading line itself is never removed). A path that matches zero or multiple headings returns a 409 you can act on (narrow the path to disambiguate). Prefer this over orboto_update_doc for section-scoped rewrites. baseRevisionId gives optimistic concurrency. Returns a short context window per op.',
  inputSchema: z.object({
    docId: z.string().min(1).describe('Doc UUID or human-readable key (ORB-D12 / DOC-5). Find via orboto_search_docs.'),
    sectionOps: z.array(z.object({
      headingPath: z.array(z.string().min(1)).min(1).describe('Ordered heading breadcrumb, top-down. Exact + case-sensitive.'),
      op: z.enum(['replace', 'append', 'insertAfter']).describe('replace body / append to body / insert directly below the heading line.'),
      content: z.string().describe('New markdown content for the op.'),
    })).min(1).max(100).describe('Applied sequentially after any string edits.'),
    baseRevisionId: z.string().uuid().optional().describe('Optimistic-concurrency token = the revision id you last saw. Omit to always apply.'),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};

export function makeEditDocSectionHandler(client: OrbotoClient) {
  return async (input: {
    docId: string;
    sectionOps: Array<{ headingPath: string[]; op: 'replace' | 'append' | 'insertAfter'; content: string }>;
    baseRevisionId?: string;
  }): Promise<CallToolResult> => {
    const docId = await resolveDocId(client, input.docId);
    const body: Record<string, unknown> = { sectionOps: input.sectionOps };
    if (input.baseRevisionId) body.baseRevisionId = input.baseRevisionId;
    try {
      const res = await client.post<DocEditsResult>(`/docs/${docId}/edits`, body);
      return renderEditResult(res);
    } catch (err) {
      const conflict = editConflictResult(err);
      if (conflict) return conflict;
      throw err;
    }
  };
}

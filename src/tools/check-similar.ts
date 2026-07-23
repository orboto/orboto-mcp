/**
 * ORB-831 / ORB-887 — `orboto_check_similar`.
 *
 * Dry-run sibling of `orboto_create_ticket`: takes a proposed title +
 * description and returns the tickets that would land in
 * `similarWarnings` if the create were to happen now. Intended as the
 * cautious agent's pre-create probe — call this first when the task
 * scope feels close to existing work, decide whether to follow up on
 * the existing ticket instead, then either commit (`orboto_create_ticket`)
 * or pivot.
 *
 * Wraps the existing `GET /projects/:id/tickets/similar` route so the
 * matching pipeline (tsvector + optional embedding rerank) is shared
 * with both the UI new-ticket form and the POST-create safety-net.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';
import { resolveProjectByKey, resolveTicketByKey } from './shared.js';

interface SimilarCandidate {
  id: string;
  ticketKey: string | null;
  title: string;
  statusName: string | null;
  statusColor: string | null;
  statusCategory: string | null;
  similarity: number;
  matchMode: 'tsvector' | 'embedding';
  // ORB-1604 - parent/sibling/epic candidates are related context, not dups.
  relation?: 'parent' | 'sibling' | 'epic' | null;
}

interface SimilarResponse {
  candidates: SimilarCandidate[];
  mode: 'tsvector' | 'embedding';
}

export const checkSimilarToolConfig = {
  title: 'Check for similar tickets before creating',
  description:
    'Run the duplicate-detection pipeline (tsvector + AI-embedding rerank when configured) against a proposed title + description, without creating anything. Returns up to `limit` candidates ranked by similarity. Use this BEFORE `orboto_create_ticket` when you want to confirm a feature is not already tracked — if a high-similarity candidate exists, prefer to comment on / claim / extend it instead of opening a new ticket. Empty result = safe to create. `orboto_create_ticket` runs the same check after the fact and surfaces `similarWarnings` in its response, so this tool is optional but cheaper than a create-then-close round trip. An empty result from a LONG, solution-framed title is weak evidence — detection ranks by term co-occurrence, so also probe with a single distinctive STABLE token (file/component/error-string fragment) and the SYMPTOM wording, not just your intended fix.',
  inputSchema: z.object({
    projectKey: z.string().min(1).describe('Project key (e.g. "ACME").'),
    title: z.string().min(1).describe('Proposed ticket title.'),
    description: z.string().optional().describe('Optional proposed ticket description — improves recall.'),
    limit: z.number().int().min(1).max(10).optional().describe('Max candidates to return. Default 5.'),
    parentTicketKey: z.string().optional().describe('The intended PARENT ticket key (e.g. the epic) when drafting a child. Enables hierarchy-aware classification: the parent, its other children and epics are reported as related context instead of duplicates.'),
    forType: z.string().optional().describe('The intended ticket type (task/bug/story/epic) of the draft.'),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeCheckSimilarHandler(client: OrbotoClient) {
  return async ({ projectKey, title, description, limit, parentTicketKey, forType }: {
    projectKey: string;
    title: string;
    description?: string;
    limit?: number;
    parentTicketKey?: string;
    forType?: string;
  }): Promise<CallToolResult> => {
    const project = await resolveProjectByKey(client, projectKey);
    const qs = new URLSearchParams({
      title,
      limit: String(limit ?? 5),
    });
    if (description) qs.set('description', description);
    // ORB-1604 - hierarchy-aware classification inputs.
    if (parentTicketKey) {
      const parent = await resolveTicketByKey(client, parentTicketKey);
      qs.set('parentTicketId', parent.id);
    }
    if (forType) qs.set('forType', forType);
    const result = await client.get<SimilarResponse>(
      `/projects/${project.id}/tickets/similar?${qs.toString()}`,
    );

    // ORB-1604 - only relation-free candidates are duplicate signals; the
    // parent, siblings and epics are related context (they drove the 70%
    // --allow-duplicate override rate in the field).
    const realDuplicates = result.candidates.filter((c) => !c.relation);
    const related = result.candidates.filter((c) => c.relation);
    const recommendation = realDuplicates.length === 0
      ? (related.length === 0
          ? 'No similar tickets found — safe to create.'
          : 'Only related context found (parent/sibling/epic) — safe to create; link them instead of treating as duplicates.')
      : (realDuplicates[0]!.similarity >= 0.9)
        ? `HIGH-SIMILARITY MATCH FOUND — review [${realDuplicates[0]!.ticketKey ?? realDuplicates[0]!.id.slice(0, 8)}] "${realDuplicates[0]!.title}" before creating; this may already be tracked.`
        : 'Possible related tickets — review the list and decide whether the new ticket adds distinct scope.';

    const text = result.candidates.length === 0
      ? `${recommendation} (match mode: ${result.mode})`
      : [
          recommendation,
          `Found ${result.candidates.length} candidate(s) via ${result.mode === 'embedding' ? 'AI embedding rerank' : 'tsvector search'}:`,
          ...result.candidates.map((c) => {
            const pct = `${Math.round(c.similarity * 100)}%`;
            const status = c.statusName ? ` [${c.statusName}]` : '';
            const key = c.ticketKey ?? c.id.slice(0, 8);
            const rel = c.relation ? ` (related: ${c.relation})` : '';
            return `  - ${key}${status} (${pct} ${c.matchMode})${rel}: ${c.title}`;
          }),
        ].join('\n');

    return {
      content: [{ type: 'text', text }],
      structuredContent: {
        similar: result.candidates,
        mode: result.mode,
        recommendation,
      },
    };
  };
}

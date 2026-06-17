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
import { resolveProjectByKey } from './shared.js';

interface SimilarCandidate {
  id: string;
  ticketKey: string | null;
  title: string;
  statusName: string | null;
  statusColor: string | null;
  statusCategory: string | null;
  similarity: number;
  matchMode: 'tsvector' | 'embedding';
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
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeCheckSimilarHandler(client: OrbotoClient) {
  return async ({ projectKey, title, description, limit }: {
    projectKey: string;
    title: string;
    description?: string;
    limit?: number;
  }): Promise<CallToolResult> => {
    const project = await resolveProjectByKey(client, projectKey);
    const qs = new URLSearchParams({
      title,
      limit: String(limit ?? 5),
    });
    if (description) qs.set('description', description);
    const result = await client.get<SimilarResponse>(
      `/projects/${project.id}/tickets/similar?${qs.toString()}`,
    );

    const recommendation = result.candidates.length === 0
      ? 'No similar tickets found — safe to create.'
      : (result.candidates[0]!.similarity >= 0.9)
        ? `HIGH-SIMILARITY MATCH FOUND — review [${result.candidates[0]!.ticketKey ?? result.candidates[0]!.id.slice(0, 8)}] "${result.candidates[0]!.title}" before creating; this may already be tracked.`
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
            return `  - ${key}${status} (${pct} ${c.matchMode}): ${c.title}`;
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

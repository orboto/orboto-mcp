/**
 * ORB-831 / ORB-887 - `orboto_check_similar`.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { trimSimilarEntries } from './similar-projection.js';
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
  relation?: 'parent' | 'sibling' | 'epic' | null;
}

interface SimilarResponse {
  candidates: SimilarCandidate[];
  mode: 'tsvector' | 'embedding';
}

export const checkSimilarToolConfig = {
  title: 'Check for similar tickets before creating',
  description:
    'Run the duplicate-detection pipeline (tsvector + AI-embedding rerank when configured) against a proposed title + description, without creating anything. Returns up to `limit` candidates ranked by similarity. Use this BEFORE `orboto_create_ticket` when you want to confirm a feature is not already tracked - if a high-similarity candidate exists, prefer to comment on / claim / extend it instead of opening a new ticket. Empty result = safe to create. `orboto_create_ticket` runs the same check after the fact and surfaces `similarWarnings` in its response, so this tool is optional but cheaper than a create-then-close round trip. An empty result from a LONG, solution-framed title is weak evidence - detection ranks by term co-occurrence, so also probe with a single distinctive STABLE token (file/component/error-string fragment) and the SYMPTOM wording, not just your intended fix.',
  inputSchema: z.object({
    projectKey: z.string().min(1).describe('Project key (e.g. "ACME").'),
    title: z.string().min(1).describe('Proposed ticket title.'),
    description: z.string().optional().describe('Proposed description - improves recall.'),
    limit: z.number().int().min(1).max(10).optional().describe('Max candidates. Default 5.'),
    parentTicketKey: z.string().optional().describe('Intended parent; makes the check hierarchy-aware.'),
    forType: z.string().optional().describe('Intended type (task/bug/story/epic).'),
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
    if (parentTicketKey) {
      const parent = await resolveTicketByKey(client, parentTicketKey);
      qs.set('parentTicketId', parent.id);
    }
    if (forType) qs.set('forType', forType);
    const result = await client.get<SimilarResponse>(
      `/projects/${project.id}/tickets/similar?${qs.toString()}`,
    );

    const realDuplicates = result.candidates.filter((c) => !c.relation);
    const related = result.candidates.filter((c) => c.relation);
    const recommendation = realDuplicates.length === 0
      ? (related.length === 0
          ? 'No similar tickets found - safe to create.'
          : 'Only related context found (parent/sibling/epic) - safe to create; link them instead of treating as duplicates.')
      : (realDuplicates[0]!.similarity >= 0.9)
        ? `HIGH-SIMILARITY MATCH FOUND - review [${realDuplicates[0]!.ticketKey ?? realDuplicates[0]!.id.slice(0, 8)}] "${realDuplicates[0]!.title}" before creating; this may already be tracked.`
        : 'Possible related tickets - review the list and decide whether the new ticket adds distinct scope.';

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
        similar: trimSimilarEntries(result.candidates),
        mode: result.mode,
        recommendation,
      },
    };
  };
}

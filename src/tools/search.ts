/**
 * ORB-244 Phase B — `orboto_search`.
 *
 * Unified full-text search across tickets, comments, and docs. Maps
 * to the existing `/search` route (Phase 21 global search) which
 * already respects PBAC visibility (private tickets, internal
 * comments, doc ACL).
 *
 * ORB-272: /search is cursor-paginated. Response shape is
 * `{items, nextCursor, total}`. We surface `total` so the model
 * knows how many hits exist globally, but don't expose `cursor` on
 * the tool input — repeat MCP tool calls to walk a search cursor is
 * an awkward UX. Users who need to see more narrow the query or
 * open the full-page /search in the web UI.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';
import { resolveProjectByKey } from './shared.js';

/** Matches SearchResultSchema in @orboto/shared-schema. */
interface SearchHit {
  type: 'ticket' | 'comment' | 'doc';
  id: string;
  title: string;
  excerpt: string;
  projectId: string | null;
  projectName: string | null;
  spaceId: string | null;
  spaceName: string | null;
  url: string;
  ticketKey?: string | null;
  rank?: number;
}

interface SearchResponse {
  items: SearchHit[];
  nextCursor: string | null;
  total: number;
  /** ORB-1695 - which pass produced the hits: 'strict' AND-matching, or
   *  the 'relaxed' OR fallback + semantic recall that runs on 0 hits. */
  pass?: 'strict' | 'relaxed';
}

export const searchToolConfig = {
  title: 'Search across orboto',
  description:
    'Full-text search across tickets, comments, and docs. Honours the caller\'s visibility — private tickets and internal comments never appear unless the caller can already see them. Recall (ORB-1695): when the strict all-terms pass finds nothing, the server automatically retries with an OR-relaxed pass plus semantic (embedding) recall - the response\'s `pass` field says which pass produced the hits, and relaxed-pass hits deserve a skeptical read (they matched SOME terms or only the meaning, not all terms). Still prefer a single distinctive STABLE token (file/component/error-string fragment like "AdminCodesPage") and search the SYMPTOM, not your intended fix.',
  inputSchema: z.object({
    query: z.string().min(1).describe('Search terms, e.g. "queue worker retry".'),
    types: z.array(z.enum(['ticket', 'comment', 'doc'])).optional()
      .describe('Restrict to entity types. Omit for all.'),
    projectKey: z.string().optional().describe('Restrict to one project.'),
    limit: z.number().int().min(1).max(50).default(15),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeSearchHandler(client: OrbotoClient) {
  return async (input: {
    query: string;
    types?: Array<'ticket' | 'comment' | 'doc'>;
    projectKey?: string;
    limit?: number;
  }): Promise<CallToolResult> => {
    const qs = new URLSearchParams();
    qs.set('q', input.query);
    qs.set('limit', String(input.limit ?? 15));
    if (input.types && input.types.length > 0) qs.set('types', input.types.join(','));
    if (input.projectKey) {
      const project = await resolveProjectByKey(client, input.projectKey);
      qs.set('projectId', project.id);
    }

    const res = await client.get<SearchResponse>(`/search?${qs}`);

    const shown = res.items.length;
    const hasMore = !!res.nextCursor && res.total > shown;
    const headerHint = hasMore ? ` (showing ${shown} of ${res.total})` : '';

    const relaxedNote = res.pass === 'relaxed'
      ? ' [relaxed pass: no row matched ALL terms - these matched some terms or the meaning]'
      : '';
    const text = res.items.length === 0
      ? `No hits for "${input.query}".`
      : `Hits${headerHint}${relaxedNote}:\n\n` + res.items.map((h) => {
        const tag = h.type.toUpperCase();
        // ORB-1084 — non-ticket hits carry the FULL id: the truncated
        // form was unusable as input for the doc write tools.
        const ident = h.ticketKey ?? h.id;
        const project = h.projectName ? ` · ${h.projectName}` : '';
        return `- [${tag} ${ident}${project}] ${h.title}\n  ${h.excerpt}`;
      }).join('\n\n');

    return {
      content: [{ type: 'text', text }],
      structuredContent: {
        total: res.total,
        shown,
        hasMore,
        pass: res.pass ?? 'strict',
        hits: res.items.map((h) => ({
          type: h.type,
          id: h.id, // ORB-1084 — full id, usable as write-tool input
          title: h.title,
          excerpt: h.excerpt,
          ticketKey: h.ticketKey ?? null,
          projectName: h.projectName,
          spaceName: h.spaceName,
          url: h.url,
        })),
      },
    };
  };
}

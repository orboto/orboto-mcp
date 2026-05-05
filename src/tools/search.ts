/**
 * ORB-244 Phase B — `orbit_search`.
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
import type { OrbitClient } from '../orbit-client.js';
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
}

export const searchToolConfig = {
  title: 'Search across Orbit',
  description:
    'Full-text search across tickets, comments, and docs. Honours the caller\'s visibility — private tickets and internal comments never appear unless the caller can already see them.',
  inputSchema: z.object({
    query: z.string().min(1).describe('Search terms, e.g. "retry logic in the queue worker".'),
    types: z.array(z.enum(['ticket', 'comment', 'doc'])).optional()
      .describe('Restrict to one or more entity types. Omit for all.'),
    projectKey: z.string().optional().describe('Restrict to one project by key.'),
    limit: z.number().int().min(1).max(50).default(15),
  }).shape,
  annotations: { readOnlyHint: true },
};

export function makeSearchHandler(client: OrbitClient) {
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

    const text = res.items.length === 0
      ? `No hits for "${input.query}".`
      : `Hits${headerHint}:\n\n` + res.items.map((h) => {
        const tag = h.type.toUpperCase();
        const ident = h.ticketKey ?? h.id.slice(0, 8);
        const project = h.projectName ? ` · ${h.projectName}` : '';
        return `- [${tag} ${ident}${project}] ${h.title}\n  ${h.excerpt}`;
      }).join('\n\n');

    return {
      content: [{ type: 'text', text }],
      structuredContent: {
        total: res.total,
        shown,
        hasMore,
        hits: res.items.map((h) => ({
          type: h.type,
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

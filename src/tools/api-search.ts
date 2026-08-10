/**
 * ORB-1518 - `orboto_api_search`: the discovery half of the Code-Mode
 * escape hatch (epic ORB-1517).
 *
 * Wraps the authenticated `GET /system/api-catalog` routes, which search
 * the live OpenAPI spec server-side. Lets an agent find any REST
 * endpoint + its schema on demand instead of needing a named MCP tool
 * per endpoint - the long tail of the API stays reachable even on a
 * curated (small) tool manifest. Execute the endpoint you found with
 * `orboto_api_call` (ORB-1519).
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';

interface SearchEntry {
  method: string;
  path: string;
  summary: string | null;
  tags: string[];
  requiredPermissions: string[];
  pathParams: string[];
  queryParams: string[];
  bodyProps: string[];
  score: number;
}

interface SearchResponse {
  query: string;
  total: number;
  results: SearchEntry[];
}

interface OperationDetail {
  method: string;
  path: string;
  summary: string | null;
  description: string | null;
  tags: string[];
  requiredPermissions: string[];
  parameters: unknown[];
  requestBody: unknown;
  responses: Record<string, unknown>;
}

export const apiSearchToolConfig = {
  title: 'Search the orboto REST API catalog',
  description:
    'Discover REST API endpoints on demand - the escape hatch that keeps the WHOLE orboto API '
    + 'reachable without a named tool per endpoint. Two modes: pass `query` (free text, e.g. '
    + '"create milestone", "backup runs", "primer fact") for ranked matches with method, path, '
    + 'required permission slugs and parameter names; then pass `path` + `method` of one match to '
    + 'get its full parameter/request-body/response schema. Execute the endpoint with '
    + '`orboto_api_call`. Names with a `?` suffix are optional parameters.',
  inputSchema: z.object({
    query: z.string().min(1).max(200).optional()
      .describe('Free-text search, e.g. "list backups". Mutually exclusive with path.'),
    path: z.string().max(300).optional()
      .describe('Endpoint path for detail mode, e.g. "/projects/{id}/milestones". Requires method.'),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional()
      .describe('HTTP method for detail mode.'),
    limit: z.number().int().min(1).max(20).default(8)
      .describe('Max search results.'),
  }).shape,
  annotations: { readOnlyHint: true },
};

export function makeApiSearchHandler(client: OrbotoClient) {
  return async (input: {
    query?: string;
    path?: string;
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    limit?: number;
  }): Promise<CallToolResult> => {
    if (input.path) {
      if (!input.method) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'Detail mode needs both `path` and `method`.' }],
        };
      }
      const qs = new URLSearchParams({ path: input.path, method: input.method });
      const detail = await client.get<OperationDetail>(`/system/api-catalog/operation?${qs}`);
      const perms = detail.requiredPermissions.length > 0
        ? ` (requires: ${detail.requiredPermissions.join(', ')})`
        : '';
      return {
        content: [{
          type: 'text',
          text: `${detail.method} ${detail.path}${perms}\n${detail.summary ?? ''}\n`
            + `Schema:\n${JSON.stringify({ parameters: detail.parameters, requestBody: detail.requestBody, responses: detail.responses }, null, 1)}`,
        }],
        structuredContent: detail as unknown as Record<string, unknown>,
      };
    }

    if (!input.query) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Pass `query` to search, or `path` + `method` for one endpoint\'s schema.' }],
      };
    }

    const qs = new URLSearchParams({ q: input.query, limit: String(input.limit ?? 8) });
    const res = await client.get<SearchResponse>(`/system/api-catalog?${qs}`);
    const text = res.results.length === 0
      ? `No endpoints match "${input.query}". Try a shorter, more distinctive term.`
      : res.results.map((r) => {
        const perms = r.requiredPermissions.length > 0 ? ` [${r.requiredPermissions.join(', ')}]` : '';
        const body = r.bodyProps.length > 0 ? ` body: ${r.bodyProps.join(', ')}` : '';
        const query = r.queryParams.length > 0 ? ` query: ${r.queryParams.join(', ')}` : '';
        return `- ${r.method} ${r.path}${perms} - ${r.summary ?? ''}${query}${body}`;
      }).join('\n');
    return {
      content: [{ type: 'text', text }],
      structuredContent: res as unknown as Record<string, unknown>,
    };
  };
}

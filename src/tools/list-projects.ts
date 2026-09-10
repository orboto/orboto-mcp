/**
 * ORB-244 Phase A reference tool - `orboto_list_projects`.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';

interface ProjectRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  status: string;
}

export const listProjectsToolConfig = {
  title: 'List projects',
  description:
    'Return projects the authenticated user can see (key, name, status). Useful first step of a workflow. '
    + 'If you are after one project, pass `query` to filter by key/name instead of pulling the whole list - '
    + 'and note you can usually use a project key directly with other tools without listing at all. '
    + 'When the result says it is partial, refine with `query` rather than re-calling.',
  inputSchema: z.object({
    query: z.string().optional().describe('Substring matched against key or name.'),
    limit: z.number().int().min(1).max(200).optional().describe('Max projects. Default 50.'),
  }).shape,
  outputSchema: z.object({
    projects: z.array(z.object({
      id: z.string(),
      key: z.string(),
      name: z.string(),
      status: z.string(),
      description: z.string().nullable(),
    })),
    total: z.number(),
    totalProjects: z.number(),
    query: z.string().nullable(),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeListProjectsHandler(client: OrbotoClient) {
  return async ({ query, limit }: { query?: string; limit?: number } = {}): Promise<CallToolResult> => {
    const projects = await client.get<ProjectRow[]>('/projects');
    const q = (query ?? '').trim().toLowerCase();
    const matched = q
      ? projects.filter((p) => `${p.key} ${p.name}`.toLowerCase().includes(q))
      : projects;
    const cap = Math.min(limit ?? 50, 200);
    const shown = matched.slice(0, cap);
    const rows = shown.map((p) => ({ id: p.id, key: p.key, name: p.name, status: p.status, description: p.description }));

    const lines = rows.map((r) => `- ${r.key} - ${r.name} (${r.status})`);
    const partial = shown.length < matched.length;
    const footer = matched.length === 0
      ? (q ? `No projects match "${q}".` : 'No projects visible to this user.')
      : partial
        ? `\nShowing first ${shown.length} of ${matched.length} match(es) (of ${projects.length} total) - pass a narrower query to filter.`
        : `\n(${matched.length} project(s)${q ? ` matching "${q}"` : ''}, complete.)`;
    const text = matched.length === 0 ? footer : lines.join('\n') + footer;

    return {
      content: [{ type: 'text', text }],
      structuredContent: { projects: rows, total: matched.length, totalProjects: projects.length, query: q || null },
    };
  };
}

/**
 * ORB-244 Phase A reference tool — `orboto_list_projects`.
 *
 * Maps to `GET /projects` in the orboto API, which already filters by
 * the caller's visibility via the PBAC cascade. The MCP server is a
 * transport adapter — it doesn't re-implement the ACL.
 *
 * Rest of the read-tool suite follows the same shape (see
 * ticket ORB-244 Phase B). Keeping this first tool narrow on
 * purpose — it's the one we wire + verify end-to-end before
 * scaling out.
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
    + 'If you are after one project, pass `query` to filter by key/name instead of pulling the whole list — '
    + 'and note you can usually use a project key directly with other tools without listing at all. '
    + 'When the result says it is partial, refine with `query` rather than re-calling.',
  // ORB-1109 — query + limit so a small-context agent (self-hosted /
  // local 32k models over MCP) can narrow instead of ingesting every
  // project.
  inputSchema: z.object({
    query: z.string().optional().describe('Case-insensitive substring matched against project key or name.'),
    limit: z.number().int().min(1).max(200).optional().describe('Max projects to return (default 50).'),
  }).shape,
  // Well-formed output schema so MCP clients that honour it can
  // surface structured data. Adding fields is safe; removing them is a
  // breaking change for pinned client configs.
  outputSchema: z.object({
    projects: z.array(z.object({
      key: z.string(),
      name: z.string(),
      status: z.string(),
      description: z.string().nullable(),
    })),
    total: z.number(),
    totalProjects: z.number(),
    query: z.string().nullable(),
  }).shape,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
  },
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
    const rows = shown.map((p) => ({ key: p.key, name: p.name, status: p.status, description: p.description }));

    // Text content is what the model reads; structured content is what
    // the client UI renders. The text stays description-free (compact)
    // and ends with a count line so a small model knows whether it has
    // the whole set.
    const lines = rows.map((r) => `- ${r.key} — ${r.name} (${r.status})`);
    const partial = shown.length < matched.length;
    const footer = matched.length === 0
      ? (q ? `No projects match "${q}".` : 'No projects visible to this user.')
      : partial
        ? `\nShowing first ${shown.length} of ${matched.length} match(es) (of ${projects.length} total) — pass a narrower query to filter.`
        : `\n(${matched.length} project(s)${q ? ` matching "${q}"` : ''}, complete.)`;
    const text = matched.length === 0 ? footer : lines.join('\n') + footer;

    return {
      content: [{ type: 'text', text }],
      structuredContent: { projects: rows, total: matched.length, totalProjects: projects.length, query: q || null },
    };
  };
}

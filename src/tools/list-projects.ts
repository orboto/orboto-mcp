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
    'Projects the user can see. To find one, pass `search` (key, name, description, customer) '
    + 'instead of pulling the whole list; a project key usually works directly with other tools. '
    + 'When the result is partial, refine rather than re-call.',
  inputSchema: z.object({
    search: z.string().optional().describe('Key, name, description, customer.'),
    query: z.string().optional().describe('Key/name substring.'),
    limit: z.number().int().min(1).max(200).optional().describe('Default 50.'),
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
  return async ({ search, query, limit }: { search?: string; query?: string; limit?: number } = {}): Promise<CallToolResult> => {
    const s = (search ?? '').trim();
    const [projects, found] = await Promise.all([
      client.get<ProjectRow[]>('/projects'),
      s ? client.get<ProjectRow[]>(`/projects?search=${encodeURIComponent(s)}`) : Promise.resolve(null),
    ]);
    const q = (query ?? '').trim().toLowerCase();
    const base = found ?? projects;
    const matched = q
      ? base.filter((p) => `${p.key} ${p.name}`.toLowerCase().includes(q))
      : base;
    const term = [s, q].filter(Boolean).map((v) => `"${v}"`).join(' and ');
    const cap = Math.min(limit ?? 50, 200);
    const shown = matched.slice(0, cap);
    const rows = shown.map((p) => ({ id: p.id, key: p.key, name: p.name, status: p.status, description: p.description }));

    const lines = rows.map((r) => `- ${r.key} - ${r.name} (${r.status})`);
    const partial = shown.length < matched.length;
    const footer = matched.length === 0
      ? (term ? `No projects match ${term}.` : 'No projects visible to this user.')
      : partial
        ? `\nShowing first ${shown.length} of ${matched.length} match(es) (of ${projects.length} total) - pass a narrower search to filter.`
        : `\n(${matched.length} project(s)${term ? ` matching ${term}` : ''}, complete.)`;
    const text = matched.length === 0 ? footer : lines.join('\n') + footer;

    return {
      content: [{ type: 'text', text }],
      structuredContent: { projects: rows, total: matched.length, totalProjects: projects.length, query: q || null },
    };
  };
}

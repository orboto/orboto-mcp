/**
 * ORB-244 Phase A reference tool — `orboto_list_projects`.
 *
 * Maps to `GET /projects` in the Orboto API, which already filters by
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
    'Return every Orboto project the authenticated user can see. Useful as the first step of any workflow ("which project should I look at?").',
  // Empty input schema — the tool has no required arguments; the
  // Orboto API already scopes results by the calling user's PBAC
  // cascade.
  inputSchema: z.object({}).shape,
  // Well-formed output schema so MCP clients that honour it can
  // surface structured data. Kept conservative on purpose — adding
  // fields is easy, removing them is a breaking change for pinned
  // client configs.
  outputSchema: z.object({
    projects: z.array(z.object({
      key: z.string(),
      name: z.string(),
      status: z.string(),
      description: z.string().nullable(),
    })),
  }).shape,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
  },
};

export function makeListProjectsHandler(client: OrbotoClient) {
  return async (): Promise<CallToolResult> => {
    const projects = await client.get<ProjectRow[]>('/projects');
    const rows = projects.map((p) => ({
      key: p.key,
      name: p.name,
      status: p.status,
      description: p.description,
    }));
    // Text content is what the model reads; structured content is
    // what the client's UI can render as a table / card. Both are
    // useful — don't skip the text block even when structured is set.
    const text = rows.length === 0
      ? 'No projects visible to this user.'
      : rows.map((r) => `- ${r.key} — ${r.name} (${r.status})`).join('\n');
    return {
      content: [{ type: 'text', text }],
      structuredContent: { projects: rows },
    };
  };
}

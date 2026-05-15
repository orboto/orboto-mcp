/**
 * ORB-885 — `orboto_update_project`.
 *
 * Patch a project's metadata fields (name, description, key, status,
 * branchTemplate, customerId). Mirrors `PATCH /projects/:id` on the
 * API. The MCP read surface (`orboto_get_project`, `orboto_list_projects`)
 * shipped in ORB-244 Phase B but the write half was missing — discovered
 * while trying to set the description on the dogfooding ORB project
 * itself.
 *
 * Status mutation is allowed here (unlike `orboto_update_milestone`,
 * which delegates closing to a dedicated tool) because project status
 * is a four-state lifecycle (`draft` → `active` → `archived` / `closed`)
 * with no extra semantics — a single patch field covers it cleanly.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';
import { resolveProjectByKey, type ProjectRow } from './shared.js';

// Mirrors the Zod schema on `PATCH /projects/:id` (see
// apps/api/src/routes/projects.ts). Kept in sync manually — there's no
// generator from the API's runtime schema into the MCP package yet.
const PROJECT_KEY_RE = /^[A-Z0-9]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const updateProjectToolConfig = {
  title: 'Update a project\'s metadata',
  description:
    'Patch a project (`name`, `description`, `key`, `status`, `branchTemplate`, `customerId`). At least one field must be set. Use `status: "archived"` or `"closed"` to take a project out of active rotation. Renaming the `key` also rewrites every ticket\'s `PROJ-N` reference — handle with care.',
  inputSchema: z.object({
    projectKey: z.string().min(1).describe('Current project key (e.g. "ACME"). Case-insensitive.'),
    patch: z.object({
      name: z.string().min(1).max(255).optional(),
      description: z.string().nullable().optional().describe('Pass null to clear the description.'),
      key: z.string().min(2).max(10).regex(PROJECT_KEY_RE).optional()
        .describe('New project key. A-Z0-9 only, 2-10 chars. Rewrites every ticket reference.'),
      status: z.enum(['draft', 'active', 'archived', 'closed']).optional(),
      branchTemplate: z.string().max(100).nullable().optional(),
      customerId: z.string().regex(UUID_RE).nullable().optional()
        .describe('UUID of a customer record, or null to detach.'),
    }).refine((p) => Object.keys(p).length > 0, { message: 'patch must include at least one field' }),
  }).shape,
};

export function makeUpdateProjectHandler(client: OrbotoClient) {
  return async ({ projectKey, patch }: {
    projectKey: string;
    patch: {
      name?: string;
      description?: string | null;
      key?: string;
      status?: 'draft' | 'active' | 'archived' | 'closed';
      branchTemplate?: string | null;
      customerId?: string | null;
    };
  }): Promise<CallToolResult> => {
    const project = await resolveProjectByKey(client, projectKey);
    const updated = await client.patch<ProjectRow>(`/projects/${project.id}`, patch);
    const fields = Object.keys(patch).join(', ');
    return {
      content: [{
        type: 'text',
        text: `Updated project ${updated.key} — ${updated.name} (${fields}).`,
      }],
      structuredContent: {
        id: updated.id,
        key: updated.key,
        name: updated.name,
        description: updated.description,
        status: updated.status,
      },
    };
  };
}

/**
 * ORB-799 - per-project metadata listings.
 *
 * Two cheap read tools that round-trip the project-scoped enum tables
 * agents repeatedly need:
 *
 * - orboto_list_ticket_statuses - the workflow's status rows with
 *     their IDs, categories, colors, and terminal flag. Needed for
 *     typed-transition flows where the standard `move_ticket` (which
 *     picks the first status per category) isn't precise enough.
 *
 * - orboto_list_labels - the per-project label catalogue with
 *     colors. Lets agents see what labels exist before calling
 *     `create_ticket` with a `labels` array (unknown names error).
 *
 * Both mirror the wrapper's `statuses <project>` / `labels <project>`
 * subcommands.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';
import { resolveProjectByKey } from './shared.js';

interface StatusRow {
  id: string;
  name: string;
  category: string;
  color: string;
  sortOrder: number;
  isTerminal: boolean;
}

interface LabelRow {
  id: string;
  name: string;
  color: string;
}

// ---------------------------------------------------------------------------
// orboto_list_ticket_statuses
// ---------------------------------------------------------------------------

export const listTicketStatusesToolConfig = {
  title: 'List a project\'s ticket statuses',
  description:
    'Return the project\'s workflow rows - `{id, name, category, color, sortOrder, isTerminal}`. The `category` is the broad bucket (todo / in_progress / in_review / done / wont_fix); `name` is the workspace\'s display label (e.g. "Code Review"). Use the `id` to do typed transitions through `orboto_update_ticket` when the standard category-based move is too coarse.',
  inputSchema: z.object({
    projectKey: z.string().min(1).describe('Project key (e.g. "ACME").'),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeListTicketStatusesHandler(client: OrbotoClient) {
  return async ({ projectKey }: { projectKey: string }): Promise<CallToolResult> => {
    const project = await resolveProjectByKey(client, projectKey);
    const statuses = await client.get<StatusRow[]>(`/projects/${project.id}/ticket-statuses`);
    const text = statuses.length === 0
      ? `No statuses configured for ${project.key}.`
      : statuses.map((s) =>
          `${s.category.padEnd(12)}  "${s.name}"  ${s.color}  sort=${s.sortOrder}${s.isTerminal ? '  (terminal)' : ''}`,
        ).join('\n');
    return {
      content: [{ type: 'text', text }],
      structuredContent: {
        projectKey: project.key,
        statuses: statuses.map((s) => ({
          id: s.id,
          name: s.name,
          category: s.category,
          color: s.color,
          sortOrder: s.sortOrder,
          isTerminal: s.isTerminal,
        })),
      },
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_list_labels
// ---------------------------------------------------------------------------

export const listLabelsToolConfig = {
  title: 'List a project\'s labels',
  description:
    'Return the project\'s label catalogue - `{id, name, color}`. Labels must be referenced by exact name when assigning via `orboto_create_ticket` (the API errors on unknown names rather than auto-creating); use this tool to discover what\'s available before assigning.',
  inputSchema: z.object({
    projectKey: z.string().min(1),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeListLabelsHandler(client: OrbotoClient) {
  return async ({ projectKey }: { projectKey: string }): Promise<CallToolResult> => {
    const project = await resolveProjectByKey(client, projectKey);
    const labels = await client.get<LabelRow[]>(`/projects/${project.id}/labels`);
    const text = labels.length === 0
      ? `No labels in ${project.key}.`
      : labels.map((l) => `${l.name.padEnd(20)}  ${l.color}`).join('\n');
    return {
      content: [{ type: 'text', text }],
      structuredContent: {
        projectKey: project.key,
        labels: labels.map((l) => ({ id: l.id, name: l.name, color: l.color })),
      },
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_create_label - ORB-1041
// ---------------------------------------------------------------------------

export const createLabelToolConfig = {
  title: 'Create a project label',
  description:
    'Create a label in a project so it can be assigned to tickets. Closes the gap where `orboto_create_ticket` errors on an unknown label name (labels are not auto-created). Idempotent: if a label with the same name already exists, it is returned instead of erroring. Needs project:edit.',
  inputSchema: z.object({
    projectKey: z.string().min(1).describe('Project key (e.g. "ACME").'),
    name: z.string().min(1).max(100).describe('Label name.'),
    color: z.string().optional().describe('Hex colour like "#6366f1". Defaults to indigo.'),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};

export function makeCreateLabelHandler(client: OrbotoClient) {
  return async ({ projectKey, name, color }: { projectKey: string; name: string; color?: string }): Promise<CallToolResult> => {
    const project = await resolveProjectByKey(client, projectKey);
    // Idempotent: return an existing same-name label rather than erroring.
    const existing = await client.get<LabelRow[]>(`/projects/${project.id}/labels`);
    const match = existing.find((l) => l.name.toLowerCase() === name.toLowerCase());
    if (match) {
      return {
        content: [{ type: 'text', text: `Label "${match.name}" already exists in ${project.key}.` }],
        structuredContent: { projectKey: project.key, label: { name: match.name, color: match.color }, alreadyExists: true },
      };
    }
    const body: { name: string; color?: string } = { name };
    if (color) body.color = color;
    const created = await client.post<LabelRow>(`/projects/${project.id}/labels`, body);
    return {
      content: [{ type: 'text', text: `Created label "${created.name}" (${created.color}) in ${project.key}.` }],
      structuredContent: { projectKey: project.key, label: { name: created.name, color: created.color } },
    };
  };
}

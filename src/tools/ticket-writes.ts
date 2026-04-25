/**
 * ORB-244 Phase C Group 1 — ticket mutation tools.
 *
 * Eight tools that round-trip the API's existing PBAC cascade. Every
 * write is gated on the caller's project-level permissions; a 403
 * from the API surfaces as `isError: true` on the MCP response with
 * the API's error message intact, so the model can either retry
 * elsewhere or explain the lock to the user.
 *
 * Resolution patterns mirror Phase B:
 *   - `projectKey` (`ACME`) → UUID via `/projects/by-key/:key`
 *   - `ticketKey` (`ACME-42`) → UUID via `/projects/:id/tickets/by-key/:n`
 *   - `assigneeEmail` → userId via the project members list
 *   - `milestone` (name) → milestoneId via the project milestones list
 *
 * Tools in this file:
 *   - orbit_create_ticket
 *   - orbit_update_ticket
 *   - orbit_move_ticket
 *   - orbit_close_ticket
 *   - orbit_comment
 *   - orbit_assign
 *   - orbit_unassign
 *   - orbit_set_milestone
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OrbitApiError, type OrbitClient } from '../orbit-client.js';
import { resolveProjectByKey, resolveTicketByKey, type TicketRow } from './shared.js';

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

const STATUS_CATEGORIES = ['todo', 'in_progress', 'in_review', 'done', 'wont_fix'] as const;
type StatusCategory = (typeof STATUS_CATEGORIES)[number];

const CATEGORY_TO_LEGACY: Record<StatusCategory, string> = {
  todo: 'TODO',
  in_progress: 'IN_PROGRESS',
  in_review: 'IN_REVIEW',
  done: 'DONE',
  wont_fix: 'WONT_FIX',
};

interface MemberRow {
  userId: string;
  user: { email: string; fullName: string | null };
  role: { name: string };
}

interface MilestoneRow { id: string; name: string }
interface LabelRow { id: string; name: string }

async function resolveAssigneeId(
  client: OrbitClient,
  projectId: string,
  email: string,
): Promise<string> {
  const members = await client.get<MemberRow[]>(`/projects/${projectId}/members`);
  const m = members.find((x) => x.user.email.toLowerCase() === email.toLowerCase());
  if (!m) throw new Error(`No project member with email "${email}".`);
  return m.userId;
}

async function resolveMilestoneId(
  client: OrbitClient,
  projectId: string,
  milestoneName: string,
): Promise<string> {
  const milestones = await client.get<MilestoneRow[]>(`/projects/${projectId}/milestones`);
  const m = milestones.find((x) => x.name === milestoneName);
  if (!m) throw new Error(`Milestone "${milestoneName}" not found in project.`);
  return m.id;
}

async function resolveLabelIds(
  client: OrbitClient,
  projectId: string,
  names: string[],
): Promise<string[]> {
  if (names.length === 0) return [];
  const labels = await client.get<LabelRow[]>(`/projects/${projectId}/labels`);
  const ids: string[] = [];
  for (const name of names) {
    const found = labels.find((l) => l.name === name);
    if (!found) throw new Error(`Label "${name}" not found in project — create it first.`);
    ids.push(found.id);
  }
  return ids;
}

/** Render the "ticket created/updated" line every mutation tool ends
 *  with — keeps responses uniform and easy to chain. */
function ticketSummaryText(action: string, t: TicketRow): string {
  return `${action}: [${t.ticketKey}] ${t.title} (${t.statusName ?? t.status})`;
}

function ticketStructured(t: TicketRow) {
  return {
    key: t.ticketKey,
    title: t.title,
    status: t.statusName ?? t.status,
    statusCategory: t.statusCategory ?? null,
    type: t.type,
    priority: t.priority,
    dueDate: t.dueDate,
    isPrivate: t.isPrivate,
  };
}

// ---------------------------------------------------------------------------
// orbit_create_ticket
// ---------------------------------------------------------------------------

export const createTicketToolConfig = {
  title: 'Create a ticket',
  description:
    'Create a new ticket in the given project. Returns the new ticket\'s key (e.g. "ACME-42") so callers can chain follow-ups. The caller must have `ticket:create` on the project.',
  inputSchema: z.object({
    projectKey: z.string().min(1).describe('Project key (e.g. "ACME").'),
    title: z.string().min(1).max(255),
    description: z.string().optional(),
    type: z.enum(['task', 'bug', 'story', 'epic']).optional().describe('Default: task.'),
    priority: z.enum(['blocker', 'high', 'normal', 'low', 'trivial']).optional().describe('Default: normal.'),
    milestone: z.string().optional().describe('Milestone name. Looked up in the project; unknown = error.'),
    assigneeEmails: z.array(z.string().email()).optional().describe('Project-member emails to assign on creation.'),
    labels: z.array(z.string()).optional().describe('Label names — must already exist on the project.'),
    parentTicketKey: z.string().optional().describe('Parent ticket key (e.g. "ACME-10") — makes this a sub-ticket.'),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD.'),
    isPrivate: z.boolean().optional(),
  }).shape,
};

export function makeCreateTicketHandler(client: OrbitClient) {
  return async (input: {
    projectKey: string; title: string; description?: string;
    type?: 'task' | 'bug' | 'story' | 'epic';
    priority?: 'blocker' | 'high' | 'normal' | 'low' | 'trivial';
    milestone?: string; assigneeEmails?: string[]; labels?: string[];
    parentTicketKey?: string; dueDate?: string; isPrivate?: boolean;
  }): Promise<CallToolResult> => {
    const project = await resolveProjectByKey(client, input.projectKey);

    const body: Record<string, unknown> = {
      title: input.title,
      description: input.description ?? null,
      type: input.type ?? 'task',
      priority: input.priority ?? 'normal',
      isPrivate: input.isPrivate ?? false,
    };
    if (input.dueDate) body.dueDate = input.dueDate;
    if (input.milestone) body.milestoneId = await resolveMilestoneId(client, project.id, input.milestone);
    if (input.parentTicketKey) {
      const parent = await resolveTicketByKey(client, input.parentTicketKey);
      body.parentTicketId = parent.id;
    }

    const created = await client.post<TicketRow>(`/projects/${project.id}/tickets`, body);

    // Post-create steps: assignees + labels go through the dedicated
    // sub-routes, mirroring the wrapper's behaviour. Each is awaited
    // so a 403 here surfaces in the same MCP response.
    if (input.assigneeEmails && input.assigneeEmails.length > 0) {
      for (const email of input.assigneeEmails) {
        const userId = await resolveAssigneeId(client, project.id, email);
        await client.post(`/projects/${project.id}/tickets/${created.id}/assignees/${userId}`, {});
      }
    }
    if (input.labels && input.labels.length > 0) {
      const ids = await resolveLabelIds(client, project.id, input.labels);
      for (const labelId of ids) {
        await client.post(`/projects/${project.id}/tickets/${created.id}/labels/${labelId}`, {});
      }
    }

    return {
      content: [{ type: 'text', text: ticketSummaryText('Created', created) }],
      structuredContent: ticketStructured(created),
    };
  };
}

// ---------------------------------------------------------------------------
// orbit_update_ticket
// ---------------------------------------------------------------------------

export const updateTicketToolConfig = {
  title: 'Update a ticket',
  description:
    'Patch one or more fields on a ticket (title, description, type, priority, dueDate, startDate, isPrivate, estimatedTimeMinutes). Use `orbit_move_ticket` for status, `orbit_set_milestone` for milestone, and `orbit_assign` / `orbit_unassign` for members.',
  inputSchema: z.object({
    ticketKey: z.string().min(3),
    patch: z.object({
      title: z.string().min(1).max(255).optional(),
      description: z.string().optional(),
      type: z.enum(['task', 'bug', 'story', 'epic']).optional(),
      priority: z.enum(['blocker', 'high', 'normal', 'low', 'trivial']).optional(),
      dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      isPrivate: z.boolean().optional(),
      estimatedTimeMinutes: z.number().int().nonnegative().optional(),
    }).refine((p) => Object.keys(p).length > 0, { message: 'patch must include at least one field' }),
  }).shape,
};

export function makeUpdateTicketHandler(client: OrbitClient) {
  return async ({ ticketKey, patch }: {
    ticketKey: string;
    patch: Record<string, unknown>;
  }): Promise<CallToolResult> => {
    const ticket = await resolveTicketByKey(client, ticketKey);
    const updated = await client.patch<TicketRow>(
      `/projects/${ticket.projectId}/tickets/${ticket.id}`, patch,
    );
    return {
      content: [{ type: 'text', text: ticketSummaryText('Updated', updated) }],
      structuredContent: ticketStructured(updated),
    };
  };
}

// ---------------------------------------------------------------------------
// orbit_move_ticket
// ---------------------------------------------------------------------------

export const moveTicketToolConfig = {
  title: 'Move a ticket between status categories',
  description:
    'Move a ticket to a new status category — todo / in_progress / in_review / done / wont_fix. The API picks the project\'s first status with that category. Caller must have `ticket:change_status`.',
  inputSchema: z.object({
    ticketKey: z.string().min(3),
    statusCategory: z.enum(STATUS_CATEGORIES),
  }).shape,
};

export function makeMoveTicketHandler(client: OrbitClient) {
  return async ({ ticketKey, statusCategory }: {
    ticketKey: string; statusCategory: StatusCategory;
  }): Promise<CallToolResult> => {
    const ticket = await resolveTicketByKey(client, ticketKey);
    const updated = await client.patch<TicketRow>(
      `/projects/${ticket.projectId}/tickets/${ticket.id}`,
      { status: CATEGORY_TO_LEGACY[statusCategory] },
    );
    return {
      content: [{ type: 'text', text: ticketSummaryText('Moved', updated) }],
      structuredContent: ticketStructured(updated),
    };
  };
}

// ---------------------------------------------------------------------------
// orbit_close_ticket
// ---------------------------------------------------------------------------

export const closeTicketToolConfig = {
  title: 'Close a ticket',
  description:
    'Move a ticket to `done` and optionally post a closing comment in one call. Convenience wrapper around `orbit_move_ticket` + `orbit_comment` so the model doesn\'t need to chain two writes.',
  inputSchema: z.object({
    ticketKey: z.string().min(3),
    comment: z.string().min(1).optional().describe('Optional closing comment posted before the move.'),
  }).shape,
};

export function makeCloseTicketHandler(client: OrbitClient) {
  return async ({ ticketKey, comment }: {
    ticketKey: string; comment?: string;
  }): Promise<CallToolResult> => {
    const ticket = await resolveTicketByKey(client, ticketKey);
    if (comment) {
      // Comment first so the close-comment lands in the audit trail
      // even if the status move 403s. Mirrors the wrapper's `close`
      // behaviour.
      await client.post(`/tickets/${ticket.id}/comments`, { content: comment });
    }
    const updated = await client.patch<TicketRow>(
      `/projects/${ticket.projectId}/tickets/${ticket.id}`,
      { status: 'DONE' },
    );
    return {
      content: [{ type: 'text', text: ticketSummaryText('Closed', updated) }],
      structuredContent: ticketStructured(updated),
    };
  };
}

// ---------------------------------------------------------------------------
// orbit_comment
// ---------------------------------------------------------------------------

interface CommentResponse {
  id: string;
  content: string;
  isInternal: boolean;
  createdAt: string;
}

export const commentToolConfig = {
  title: 'Post a comment on a ticket',
  description:
    'Append a comment. Supports Markdown. `isInternal=true` hides the comment from external/guest users (use for implementation chatter the customer shouldn\'t see).',
  inputSchema: z.object({
    ticketKey: z.string().min(3),
    text: z.string().min(1),
    isInternal: z.boolean().optional().describe('Default: false (visible to all members + guests).'),
  }).shape,
};

export function makeCommentHandler(client: OrbitClient) {
  return async ({ ticketKey, text, isInternal }: {
    ticketKey: string; text: string; isInternal?: boolean;
  }): Promise<CallToolResult> => {
    const ticket = await resolveTicketByKey(client, ticketKey);
    const created = await client.post<CommentResponse>(
      `/tickets/${ticket.id}/comments`,
      { content: text, isInternal: isInternal ?? false },
    );
    return {
      content: [{
        type: 'text',
        text: `Posted comment on [${ticket.ticketKey}]${created.isInternal ? ' (internal)' : ''}.`,
      }],
      structuredContent: {
        ticketKey: ticket.ticketKey,
        commentId: created.id,
        isInternal: created.isInternal,
        createdAt: created.createdAt,
      },
    };
  };
}

// ---------------------------------------------------------------------------
// orbit_assign / orbit_unassign
// ---------------------------------------------------------------------------

export const assignToolConfig = {
  title: 'Assign a user to a ticket',
  description:
    'Add a project member as an assignee on a ticket. Multi-assignee is supported — this adds, it does not replace. Use `orbit_unassign` to remove.',
  inputSchema: z.object({
    ticketKey: z.string().min(3),
    assigneeEmail: z.string().email(),
  }).shape,
};

export function makeAssignHandler(client: OrbitClient) {
  return async ({ ticketKey, assigneeEmail }: {
    ticketKey: string; assigneeEmail: string;
  }): Promise<CallToolResult> => {
    const ticket = await resolveTicketByKey(client, ticketKey);
    const userId = await resolveAssigneeId(client, ticket.projectId, assigneeEmail);
    try {
      await client.post(`/projects/${ticket.projectId}/tickets/${ticket.id}/assignees/${userId}`, {});
    } catch (err) {
      if (err instanceof OrbitApiError && err.status === 409) {
        // Already assigned — idempotent success.
        return {
          content: [{ type: 'text', text: `[${ticket.ticketKey}] already assigned to ${assigneeEmail}.` }],
          structuredContent: { ticketKey: ticket.ticketKey, alreadyAssigned: true },
        };
      }
      throw err;
    }
    return {
      content: [{ type: 'text', text: `Assigned ${assigneeEmail} to [${ticket.ticketKey}].` }],
      structuredContent: { ticketKey: ticket.ticketKey, assignedEmail: assigneeEmail },
    };
  };
}

export const unassignToolConfig = {
  title: 'Unassign a user from a ticket',
  description: 'Remove a project member as an assignee. The ticket can become unassigned.',
  inputSchema: z.object({
    ticketKey: z.string().min(3),
    assigneeEmail: z.string().email(),
  }).shape,
};

export function makeUnassignHandler(client: OrbitClient) {
  return async ({ ticketKey, assigneeEmail }: {
    ticketKey: string; assigneeEmail: string;
  }): Promise<CallToolResult> => {
    const ticket = await resolveTicketByKey(client, ticketKey);
    const userId = await resolveAssigneeId(client, ticket.projectId, assigneeEmail);
    try {
      await client.delete(`/projects/${ticket.projectId}/tickets/${ticket.id}/assignees/${userId}`);
    } catch (err) {
      // 404 = wasn't assigned. Idempotent success.
      if (err instanceof OrbitApiError && err.status === 404) {
        return {
          content: [{ type: 'text', text: `${assigneeEmail} wasn\'t assigned to [${ticket.ticketKey}].` }],
          structuredContent: { ticketKey: ticket.ticketKey, alreadyUnassigned: true },
        };
      }
      throw err;
    }
    return {
      content: [{ type: 'text', text: `Unassigned ${assigneeEmail} from [${ticket.ticketKey}].` }],
      structuredContent: { ticketKey: ticket.ticketKey, unassignedEmail: assigneeEmail },
    };
  };
}

// ---------------------------------------------------------------------------
// orbit_set_milestone
// ---------------------------------------------------------------------------

export const setMilestoneToolConfig = {
  title: 'Set a ticket\'s milestone',
  description:
    'Move a ticket onto a different milestone (or off all milestones with milestone=null/undefined). Resolves the milestone by name within the ticket\'s project.',
  inputSchema: z.object({
    ticketKey: z.string().min(3),
    milestone: z.string().nullable().optional().describe('Milestone name. Pass null to remove from any milestone.'),
  }).shape,
};

export function makeSetMilestoneHandler(client: OrbitClient) {
  return async ({ ticketKey, milestone }: {
    ticketKey: string; milestone?: string | null;
  }): Promise<CallToolResult> => {
    const ticket = await resolveTicketByKey(client, ticketKey);
    let milestoneId: string | null = null;
    if (milestone) {
      milestoneId = await resolveMilestoneId(client, ticket.projectId, milestone);
    }
    const updated = await client.patch<TicketRow>(
      `/projects/${ticket.projectId}/tickets/${ticket.id}`,
      { milestoneId },
    );
    return {
      content: [{
        type: 'text',
        text: milestoneId
          ? `Moved [${ticket.ticketKey}] to milestone "${milestone}".`
          : `Removed [${ticket.ticketKey}] from any milestone.`,
      }],
      structuredContent: ticketStructured(updated),
    };
  };
}

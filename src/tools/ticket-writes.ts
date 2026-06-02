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
 *   - orboto_create_ticket
 *   - orboto_update_ticket
 *   - orboto_move_ticket
 *   - orboto_close_ticket
 *   - orboto_comment
 *   - orboto_assign
 *   - orboto_unassign
 *   - orboto_set_milestone
 *   - orboto_add_ticket_dependency       (ORB-453)
 *   - orboto_remove_ticket_dependency    (ORB-453)
 *   - orboto_list_ticket_dependencies    (ORB-453)
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OrbotoApiError, type OrbotoClient } from '../orboto-client.js';
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
  client: OrbotoClient,
  projectId: string,
  email: string,
): Promise<string> {
  const members = await client.get<MemberRow[]>(`/projects/${projectId}/members`);
  const m = members.find((x) => x.user.email.toLowerCase() === email.toLowerCase());
  if (!m) throw new Error(`No project member with email "${email}".`);
  return m.userId;
}

async function resolveMilestoneId(
  client: OrbotoClient,
  projectId: string,
  milestoneName: string,
): Promise<string> {
  const milestones = await client.get<MilestoneRow[]>(`/projects/${projectId}/milestones`);
  const m = milestones.find((x) => x.name === milestoneName);
  if (!m) throw new Error(`Milestone "${milestoneName}" not found in project.`);
  return m.id;
}

async function resolveLabelIds(
  client: OrbotoClient,
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
// orboto_create_ticket
// ---------------------------------------------------------------------------

export const createTicketToolConfig = {
  title: 'Create a ticket',
  description:
    'Create a new ticket in the given project. Returns the new ticket\'s key (e.g. "ACME-42") so callers can chain follow-ups. The caller must have `ticket:create` on the project. **Duplicate-detection safety-net (ORB-831):** if `similarWarnings` appears in the response with one or more entries, the ticket WAS created but you should review whether to close it as a duplicate of the listed ticket(s) instead. The warnings are advisory — never blocking — but each entry is a ticket the system thinks the new one overlaps with. Prefer `orboto_check_similar` BEFORE creating when you want a dry-run. **Language-mismatch warning (ORB-890):** if `languageWarning` appears, the ticket was written in a language different from the workspace default. Consider rewriting in the expected language so search + duplicate-detection stay consistent. Non-blocking. **Before a mass-create (ORB-989):** call `orboto_whoami` first — its `workspaceLocale` field is the language you should write every ticket in. If the same `languageWarning` repeats, stop and clarify the intended language rather than pushing through the whole batch. **Strict mode (ORB-990):** if the workspace enforces ticket language, a mismatch is rejected (the tool returns a `blocked` result, not a created ticket) — rewrite in the workspace language, or set `allowLanguageMismatch: true` only when the language is genuinely intentional.',
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
    allowLanguageMismatch: z.boolean().optional().describe('Override strict ticket-language enforcement (ORB-990). Only set after a previous call was blocked AND you are sure the language is intentional — prefer rewriting in the workspace language.'),
  }).shape,
};

export function makeCreateTicketHandler(client: OrbotoClient) {
  return async (input: {
    projectKey: string; title: string; description?: string;
    type?: 'task' | 'bug' | 'story' | 'epic';
    priority?: 'blocker' | 'high' | 'normal' | 'low' | 'trivial';
    milestone?: string; assigneeEmails?: string[]; labels?: string[];
    parentTicketKey?: string; dueDate?: string; isPrivate?: boolean;
    allowLanguageMismatch?: boolean;
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

    // ORB-990 — strict ticket-language enforcement may reject this with
    // a 422; surface that as a clear block result instead of a raw error.
    const createPath = `/projects/${project.id}/tickets${input.allowLanguageMismatch ? '?allowLanguageMismatch=true' : ''}`;
    let created: TicketRow & {
      similarWarnings?: SimilarWarning[];
      languageWarning?: LanguageWarning;
    };
    try {
      created = await client.post<TicketRow & {
        similarWarnings?: SimilarWarning[];
        languageWarning?: LanguageWarning;
      }>(createPath, body);
    } catch (err) {
      const blocked = languageBlockResult(err, 'Ticket create');
      if (blocked) return blocked;
      throw err;
    }

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

    // ORB-831 / ORB-887 — surface the backend's `similarWarnings` to the
    // calling agent. The text block prepends a clearly-visible warning
    // when matches exist so a model scanning the result for "warning"
    // / "duplicate" notices and self-corrects.
    // ORB-890 / ORB-891 — same surface for `languageWarning` when the
    // detected language doesn't match the workspace default.
    const warnings = created.similarWarnings ?? [];
    const langWarning = created.languageWarning;
    const baseText = ticketSummaryText('Created', created);
    const parts: string[] = [baseText];
    if (warnings.length > 0) {
      parts.push(
        `\n⚠ Potential duplicates found — review before treating this as new work:\n${
          warnings.map((w) => `  - [${w.ticketKey ?? w.id.slice(0, 8)}] "${w.title}" (${formatSimilarity(w)})`).join('\n')
        }\n  If one of these covers the work, close [${created.ticketKey}] as a duplicate via orboto_close_ticket.`,
      );
    }
    if (langWarning) {
      parts.push(
        `\n⚠ Language mismatch — this ticket reads as "${langWarning.detected}" but the workspace default is "${langWarning.expected}". Consider rewriting in ${langWarning.expected.toUpperCase()} to keep search + duplicate-detection consistent across the project.`,
      );
    }
    const text = parts.join('\n');

    return {
      content: [{ type: 'text', text }],
      structuredContent: {
        ...ticketStructured(created),
        similarWarnings: warnings,
        ...(langWarning ? { languageWarning: langWarning } : {}),
      },
    };
  };
}

interface SimilarWarning {
  id: string;
  ticketKey: string | null;
  title: string;
  statusName: string | null;
  statusColor: string | null;
  statusCategory: string | null;
  similarity: number;
  matchMode: 'tsvector' | 'embedding';
}

interface LanguageWarning {
  // ORB-990 — machine-readable code + severity.
  code?: 'language_mismatch';
  severity?: 'warn' | 'block';
  detected: string;
  expected: string;
}

/**
 * ORB-990 — turn a strict-language 422 into a clear, non-throwing tool
 * result. The backend body is `{ error, languageWarning }`; we surface
 * the block reason and tell the agent how to proceed (rewrite, or retry
 * with the override) instead of letting the raw API error bubble up.
 * Returns null if the error isn't a language-enforcement 422.
 */
function languageBlockResult(err: unknown, verb: string): CallToolResult | null {
  if (!(err instanceof OrbotoApiError) || err.status !== 422) return null;
  let parsed: { error?: string; languageWarning?: LanguageWarning } = {};
  try { parsed = JSON.parse(err.body) as typeof parsed; } catch { /* non-JSON body */ }
  if (!parsed.languageWarning) return null;
  const lw = parsed.languageWarning;
  const text = `⛔ ${verb} blocked — strict ticket-language enforcement is on.\n` +
    `This content reads as "${lw.detected}" but the workspace language is "${lw.expected}".\n` +
    `Rewrite it in ${lw.expected.toUpperCase()}, or — only if you are sure the language is intentional — retry the same call with allowLanguageMismatch=true.`;
  return {
    content: [{ type: 'text', text }],
    structuredContent: { blocked: true, languageWarning: lw },
    isError: true,
  };
}

function formatSimilarity(w: SimilarWarning): string {
  const pct = `${Math.round(w.similarity * 100)}% ${w.matchMode === 'embedding' ? 'AI match' : 'text match'}`;
  return w.statusName ? `${w.statusName}, ${pct}` : pct;
}

// ---------------------------------------------------------------------------
// orboto_update_ticket
// ---------------------------------------------------------------------------

export const updateTicketToolConfig = {
  title: 'Update a ticket',
  description:
    'Patch one or more fields on a ticket (title, description, type, priority, dueDate, startDate, isPrivate, estimatedTimeMinutes). Use `orboto_move_ticket` for status, `orboto_set_milestone` for milestone, and `orboto_assign` / `orboto_unassign` for members.',
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
    allowLanguageMismatch: z.boolean().optional().describe('Override strict ticket-language enforcement (ORB-990). Only set after a previous call was blocked AND the language is intentional.'),
  }).shape,
};

export function makeUpdateTicketHandler(client: OrbotoClient) {
  return async ({ ticketKey, patch, allowLanguageMismatch }: {
    ticketKey: string;
    patch: Record<string, unknown>;
    allowLanguageMismatch?: boolean;
  }): Promise<CallToolResult> => {
    const ticket = await resolveTicketByKey(client, ticketKey);
    // ORB-990 — strict ticket-language enforcement may reject a
    // title/description patch with a 422; surface a clear block result.
    const patchPath = `/projects/${ticket.projectId}/tickets/${ticket.id}${allowLanguageMismatch ? '?allowLanguageMismatch=true' : ''}`;
    let updated: TicketRow & { languageWarning?: LanguageWarning };
    try {
      updated = await client.patch<TicketRow & { languageWarning?: LanguageWarning }>(patchPath, patch);
    } catch (err) {
      const blocked = languageBlockResult(err, 'Ticket update');
      if (blocked) return blocked;
      throw err;
    }
    const langWarning = updated.languageWarning;
    const parts = [ticketSummaryText('Updated', updated)];
    if (langWarning) {
      parts.push(
        `\n⚠ Language mismatch — this ticket reads as "${langWarning.detected}" but the workspace default is "${langWarning.expected}". Consider rewriting in ${langWarning.expected.toUpperCase()} to keep search + duplicate-detection consistent.`,
      );
    }
    return {
      content: [{ type: 'text', text: parts.join('\n') }],
      structuredContent: {
        ...ticketStructured(updated),
        ...(langWarning ? { languageWarning: langWarning } : {}),
      },
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_move_ticket
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

export function makeMoveTicketHandler(client: OrbotoClient) {
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
// orboto_close_ticket
// ---------------------------------------------------------------------------

export const closeTicketToolConfig = {
  title: 'Close a ticket',
  description:
    'Move a ticket to `done` and optionally post a closing comment in one call. Convenience wrapper around `orboto_move_ticket` + `orboto_comment` so the model doesn\'t need to chain two writes.',
  inputSchema: z.object({
    ticketKey: z.string().min(3),
    comment: z.string().min(1).optional().describe('Optional closing comment posted before the move.'),
  }).shape,
};

export function makeCloseTicketHandler(client: OrbotoClient) {
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
// orboto_delete_ticket
// ---------------------------------------------------------------------------

export const deleteTicketToolConfig = {
  title: 'Permanently delete a ticket',
  description:
    'DESTRUCTIVE, IRREVERSIBLE hard-delete of a ticket (by key): the row and its history are gone, and a `ticket.deleted` event + webhook fire. Strongly prefer moving the ticket to `wont_fix` (orboto_move_ticket) or closing it instead — wont_fix keeps the history and analytics intact. Only hard-delete a ticket that should truly never have existed (accidental duplicate, spam). Caller must have `ticket:delete`.',
  inputSchema: z.object({
    ticketKey: z.string().min(3),
  }).shape,
};

export function makeDeleteTicketHandler(client: OrbotoClient) {
  return async ({ ticketKey }: { ticketKey: string }): Promise<CallToolResult> => {
    const ticket = await resolveTicketByKey(client, ticketKey);
    await client.delete(`/projects/${ticket.projectId}/tickets/${ticket.id}`);
    const key = ticket.ticketKey ?? ticketKey;
    return {
      content: [{ type: 'text', text: `Permanently deleted ${key}. This cannot be undone.` }],
      structuredContent: { deleted: true, ticketKey: key, id: ticket.id },
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_comment
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

export function makeCommentHandler(client: OrbotoClient) {
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
// orboto_assign / orboto_unassign
// ---------------------------------------------------------------------------

export const assignToolConfig = {
  title: 'Assign a user to a ticket',
  description:
    'Add a project member as an assignee on a ticket. Multi-assignee is supported — this adds, it does not replace. Use `orboto_unassign` to remove.',
  inputSchema: z.object({
    ticketKey: z.string().min(3),
    assigneeEmail: z.string().email(),
  }).shape,
};

export function makeAssignHandler(client: OrbotoClient) {
  return async ({ ticketKey, assigneeEmail }: {
    ticketKey: string; assigneeEmail: string;
  }): Promise<CallToolResult> => {
    const ticket = await resolveTicketByKey(client, ticketKey);
    const userId = await resolveAssigneeId(client, ticket.projectId, assigneeEmail);
    try {
      await client.post(`/projects/${ticket.projectId}/tickets/${ticket.id}/assignees/${userId}`, {});
    } catch (err) {
      if (err instanceof OrbotoApiError && err.status === 409) {
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

export function makeUnassignHandler(client: OrbotoClient) {
  return async ({ ticketKey, assigneeEmail }: {
    ticketKey: string; assigneeEmail: string;
  }): Promise<CallToolResult> => {
    const ticket = await resolveTicketByKey(client, ticketKey);
    const userId = await resolveAssigneeId(client, ticket.projectId, assigneeEmail);
    try {
      await client.delete(`/projects/${ticket.projectId}/tickets/${ticket.id}/assignees/${userId}`);
    } catch (err) {
      // 404 = wasn't assigned. Idempotent success.
      if (err instanceof OrbotoApiError && err.status === 404) {
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
// orboto_set_milestone
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

export function makeSetMilestoneHandler(client: OrbotoClient) {
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

// ---------------------------------------------------------------------------
// orboto_add_ticket_dependency / remove / list — ORB-453
// ---------------------------------------------------------------------------

interface DependencyEdge {
  id: string;
  ticketKey: string | null;
  title: string;
  projectId: string;
  statusName: string | null;
  statusCategory: string | null;
}

export const addTicketDependencyToolConfig = {
  title: 'Add a ticket dependency',
  description:
    'Mark `ticketKey` as depending on `dependsOnKey` — i.e. `dependsOnKey` blocks `ticketKey`. Both tickets must live in the same project; cycles + self-dependencies are rejected by the API.',
  inputSchema: z.object({
    ticketKey: z.string().min(3).describe('The dependent ticket (the one being blocked).'),
    dependsOnKey: z.string().min(3).describe('The ticket that must complete first (the blocker).'),
  }).shape,
};

export function makeAddTicketDependencyHandler(client: OrbotoClient) {
  return async ({ ticketKey, dependsOnKey }: {
    ticketKey: string; dependsOnKey: string;
  }): Promise<CallToolResult> => {
    const ticket = await resolveTicketByKey(client, ticketKey);
    const dependsOn = await resolveTicketByKey(client, dependsOnKey);
    try {
      await client.post(
        `/projects/${ticket.projectId}/tickets/${ticket.id}/dependencies`,
        { dependsOnId: dependsOn.id },
      );
    } catch (err) {
      // 409 = edge already exists — idempotent success.
      if (err instanceof OrbotoApiError && err.status === 409) {
        return {
          content: [{ type: 'text', text: `[${ticket.ticketKey}] already depends on [${dependsOn.ticketKey}].` }],
          structuredContent: { ticketKey: ticket.ticketKey, dependsOnKey: dependsOn.ticketKey, alreadyExisted: true },
        };
      }
      throw err;
    }
    return {
      content: [{
        type: 'text',
        text: `[${ticket.ticketKey}] now depends on [${dependsOn.ticketKey}] — must complete first.`,
      }],
      structuredContent: {
        ticketKey: ticket.ticketKey,
        dependsOnKey: dependsOn.ticketKey,
      },
    };
  };
}

export const removeTicketDependencyToolConfig = {
  title: 'Remove a ticket dependency',
  description: 'Drop the dependency edge from `ticketKey` to `dependsOnKey`. Idempotent — removing an edge that isn\'t there returns the same success.',
  inputSchema: z.object({
    ticketKey: z.string().min(3),
    dependsOnKey: z.string().min(3),
  }).shape,
};

export function makeRemoveTicketDependencyHandler(client: OrbotoClient) {
  return async ({ ticketKey, dependsOnKey }: {
    ticketKey: string; dependsOnKey: string;
  }): Promise<CallToolResult> => {
    const ticket = await resolveTicketByKey(client, ticketKey);
    const dependsOn = await resolveTicketByKey(client, dependsOnKey);
    try {
      await client.delete(
        `/projects/${ticket.projectId}/tickets/${ticket.id}/dependencies/${dependsOn.id}`,
      );
    } catch (err) {
      // 404 = edge wasn't there. Idempotent success.
      if (err instanceof OrbotoApiError && err.status === 404) {
        return {
          content: [{ type: 'text', text: `[${ticket.ticketKey}] didn\'t depend on [${dependsOn.ticketKey}].` }],
          structuredContent: { ticketKey: ticket.ticketKey, dependsOnKey: dependsOn.ticketKey, alreadyAbsent: true },
        };
      }
      throw err;
    }
    return {
      content: [{
        type: 'text',
        text: `Removed dependency [${ticket.ticketKey}] → [${dependsOn.ticketKey}].`,
      }],
      structuredContent: {
        ticketKey: ticket.ticketKey,
        dependsOnKey: dependsOn.ticketKey,
      },
    };
  };
}

export const listTicketDependenciesToolConfig = {
  title: 'List a ticket\'s dependencies',
  description:
    'Show both directions of the dependency graph for a ticket: `blockedBy` (tickets that must finish first) and `blocks` (tickets waiting on this one).',
  inputSchema: z.object({
    ticketKey: z.string().min(3),
  }).shape,
};

export function makeListTicketDependenciesHandler(client: OrbotoClient) {
  return async ({ ticketKey }: { ticketKey: string }): Promise<CallToolResult> => {
    const ticket = await resolveTicketByKey(client, ticketKey);
    const data = await client.get<{ blockedBy: DependencyEdge[]; blocks: DependencyEdge[] }>(
      `/projects/${ticket.projectId}/tickets/${ticket.id}/dependencies`,
    );
    const fmt = (edges: DependencyEdge[]) =>
      edges.length === 0
        ? '_(none)_'
        : edges.map((e) => `- [${e.ticketKey ?? e.id.slice(0, 8)}] ${e.title}${e.statusName ? ` — ${e.statusName}` : ''}`).join('\n');
    const lines = [
      `# Dependencies for [${ticket.ticketKey}]`,
      '',
      '## Blocked by (must complete first)',
      fmt(data.blockedBy),
      '',
      '## Blocks (waiting on this ticket)',
      fmt(data.blocks),
    ];
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: {
        ticketKey: ticket.ticketKey,
        blockedBy: data.blockedBy.map((e) => ({ ticketKey: e.ticketKey, title: e.title, statusName: e.statusName })),
        blocks: data.blocks.map((e) => ({ ticketKey: e.ticketKey, title: e.title, statusName: e.statusName })),
      },
    };
  };
}

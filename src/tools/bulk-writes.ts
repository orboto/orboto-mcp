/**
 * ORB-799 — bulk-* writes.
 *
 * The wrapper's `bulk-*` family is one of its most-used clusters, used
 * in every phase-cleanup pass. MCP-side we collapse the wrapper's
 * `--from=- | @file | "ORB-1,ORB-2"` UX into a single typed `ticketKeys:
 * string[]` array — the calling agent already has the list as JSON, so
 * the wrapper's stdin/file-roundtrip is a regression there.
 *
 * Each tool:
 *   - Takes `ticketKeys: string[]` (1..200 keys) + tool-specific params
 *   - Has a `dryRun: boolean` modifier — when true, resolves every key
 *     to verify visibility + permission but does NOT issue the
 *     mutating call. Returns the same outcome shape with a
 *     `dryRun: true` marker so the caller can preview.
 *   - Returns `{ successful: [...], failed: [{ticketKey, error}], skipped: [...] }`
 *     so the model can branch on partial failures instead of parsing
 *     stderr progress lines like the wrapper does.
 *
 * Concurrency: serial per-ticket. Bulk operations land on a tenant DB
 * that other operators may be writing concurrently; spraying parallel
 * PATCHes against the same tickets is the kind of thing tenant rate
 * limits exist to slow down. A 200-ticket bulk-close at ~80ms/ticket
 * is ~16s — acceptable.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OrbotoApiError, type OrbotoClient } from '../orboto-client.js';
import { resolveTicketByKey, type TicketRow } from './shared.js';

const STATUS_CATEGORIES = ['todo', 'in_progress', 'in_review', 'done', 'wont_fix'] as const;
type StatusCategory = (typeof STATUS_CATEGORIES)[number];

const CATEGORY_TO_LEGACY: Record<StatusCategory, string> = {
  todo: 'TODO',
  in_progress: 'IN_PROGRESS',
  in_review: 'IN_REVIEW',
  done: 'DONE',
  wont_fix: 'WONT_FIX',
};

interface MemberRow { userId: string; user: { email: string } }

const TICKET_KEY_ARRAY = z.array(z.string().min(3)).min(1).max(200)
  .describe('Ticket keys (e.g. ["ACME-1", "ACME-2"]). Capped at 200 per call to keep the per-tenant rate-limit budget reasonable.');

interface BulkOutcome {
  successful: string[];
  failed: Array<{ ticketKey: string; error: string }>;
  skipped: string[];
  dryRun: boolean;
}

function emptyOutcome(dryRun: boolean): BulkOutcome {
  return { successful: [], failed: [], skipped: [], dryRun };
}

function bulkResult(action: string, outcome: BulkOutcome): CallToolResult {
  const lines = [
    `${outcome.dryRun ? '[dry-run] ' : ''}${action} — ${outcome.successful.length} ok, ${outcome.failed.length} failed${outcome.skipped.length ? `, ${outcome.skipped.length} skipped` : ''}.`,
  ];
  if (outcome.failed.length > 0) {
    lines.push('');
    lines.push('Failed:');
    for (const f of outcome.failed) lines.push(`  - ${f.ticketKey}: ${f.error}`);
  }
  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    structuredContent: outcome as unknown as Record<string, unknown>,
  };
}

function errMessage(err: unknown): string {
  if (err instanceof OrbotoApiError) {
    if (err.status === 403) return 'Forbidden — caller lacks permission on this ticket.';
    if (err.status === 404) return 'Not found.';
    return `HTTP ${err.status}: ${err.body || '(empty body)'}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Resolve N keys to N TicketRows. On any failure, record the ticketKey
 *  + error in `failed` and continue; downstream loops skip those. */
async function resolveBatch(
  client: OrbotoClient,
  ticketKeys: string[],
  outcome: BulkOutcome,
): Promise<Map<string, TicketRow>> {
  const resolved = new Map<string, TicketRow>();
  for (const k of ticketKeys) {
    try {
      const t = await resolveTicketByKey(client, k);
      resolved.set(k, t);
    } catch (err) {
      outcome.failed.push({ ticketKey: k, error: errMessage(err) });
    }
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// orboto_bulk_patch_tickets
// ---------------------------------------------------------------------------

export const bulkPatchTicketsToolConfig = {
  title: 'Apply the same patch to many tickets',
  description:
    'PATCH every ticket in `ticketKeys` with the same `patch` body. The patch shape mirrors `orboto_update_ticket`: title, description, type, priority, dueDate, startDate, isPrivate, estimatedTimeMinutes. To move many tickets between status categories, use `orboto_bulk_move_tickets` instead. Returns `{successful, failed, skipped, dryRun}` so the caller can branch on partial failures.',
  inputSchema: z.object({
    ticketKeys: TICKET_KEY_ARRAY,
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
    dryRun: z.boolean().optional().describe('Resolve every ticket to verify visibility/permission, but skip the actual PATCH.'),
  }).shape,
};

export function makeBulkPatchTicketsHandler(client: OrbotoClient) {
  return async ({ ticketKeys, patch, dryRun }: {
    ticketKeys: string[];
    patch: Record<string, unknown>;
    dryRun?: boolean;
  }): Promise<CallToolResult> => {
    const outcome = emptyOutcome(dryRun === true);
    const resolved = await resolveBatch(client, ticketKeys, outcome);
    for (const [k, t] of resolved) {
      if (dryRun) { outcome.skipped.push(k); continue; }
      try {
        await client.patch(`/projects/${t.projectId}/tickets/${t.id}`, patch);
        outcome.successful.push(k);
      } catch (err) {
        outcome.failed.push({ ticketKey: k, error: errMessage(err) });
      }
    }
    return bulkResult(`bulk_patch (${Object.keys(patch).join(',')})`, outcome);
  };
}

// ---------------------------------------------------------------------------
// orboto_bulk_move_tickets
// ---------------------------------------------------------------------------

export const bulkMoveTicketsToolConfig = {
  title: 'Move many tickets to a status category',
  description:
    'Move every ticket in `ticketKeys` to the same status category (todo / in_progress / in_review / done / wont_fix). Each ticket lands on its own project\'s first status with that category. Returns the per-ticket outcome.',
  inputSchema: z.object({
    ticketKeys: TICKET_KEY_ARRAY,
    statusCategory: z.enum(STATUS_CATEGORIES),
    dryRun: z.boolean().optional(),
  }).shape,
};

export function makeBulkMoveTicketsHandler(client: OrbotoClient) {
  return async ({ ticketKeys, statusCategory, dryRun }: {
    ticketKeys: string[]; statusCategory: StatusCategory; dryRun?: boolean;
  }): Promise<CallToolResult> => {
    const outcome = emptyOutcome(dryRun === true);
    const resolved = await resolveBatch(client, ticketKeys, outcome);
    const legacy = CATEGORY_TO_LEGACY[statusCategory];
    for (const [k, t] of resolved) {
      if (dryRun) { outcome.skipped.push(k); continue; }
      try {
        await client.patch(`/projects/${t.projectId}/tickets/${t.id}`, { status: legacy });
        outcome.successful.push(k);
      } catch (err) {
        outcome.failed.push({ ticketKey: k, error: errMessage(err) });
      }
    }
    return bulkResult(`bulk_move → ${statusCategory}`, outcome);
  };
}

// ---------------------------------------------------------------------------
// orboto_bulk_close_tickets
// ---------------------------------------------------------------------------

export const bulkCloseTicketsToolConfig = {
  title: 'Close many tickets (optionally with a shared comment)',
  description:
    'For every ticket in `ticketKeys`: optionally post the same `comment` first, then move it to `done`. Mirrors `orboto.mjs bulk-close`. Comment-first ordering means the close note lands in the audit trail even if the status PATCH 403s.',
  inputSchema: z.object({
    ticketKeys: TICKET_KEY_ARRAY,
    comment: z.string().min(1).optional().describe('Optional shared closing comment posted on each ticket before its status move.'),
    dryRun: z.boolean().optional(),
  }).shape,
};

export function makeBulkCloseTicketsHandler(client: OrbotoClient) {
  return async ({ ticketKeys, comment, dryRun }: {
    ticketKeys: string[]; comment?: string; dryRun?: boolean;
  }): Promise<CallToolResult> => {
    const outcome = emptyOutcome(dryRun === true);
    const resolved = await resolveBatch(client, ticketKeys, outcome);
    for (const [k, t] of resolved) {
      if (dryRun) { outcome.skipped.push(k); continue; }
      try {
        if (comment) {
          await client.post(`/tickets/${t.id}/comments`, { content: comment });
        }
        await client.patch(`/projects/${t.projectId}/tickets/${t.id}`, { status: 'DONE' });
        outcome.successful.push(k);
      } catch (err) {
        outcome.failed.push({ ticketKey: k, error: errMessage(err) });
      }
    }
    return bulkResult(comment ? 'bulk_close + comment' : 'bulk_close', outcome);
  };
}

// ---------------------------------------------------------------------------
// orboto_bulk_comment_tickets
// ---------------------------------------------------------------------------

export const bulkCommentTicketsToolConfig = {
  title: 'Post the same comment on many tickets',
  description:
    'Append the same comment body to every ticket in `ticketKeys`. Useful for "I am back-propagating decision X to all affected tickets" workflows. `isInternal=true` hides from external/guest users.',
  inputSchema: z.object({
    ticketKeys: TICKET_KEY_ARRAY,
    text: z.string().min(1),
    isInternal: z.boolean().optional(),
    dryRun: z.boolean().optional(),
  }).shape,
};

export function makeBulkCommentTicketsHandler(client: OrbotoClient) {
  return async ({ ticketKeys, text, isInternal, dryRun }: {
    ticketKeys: string[]; text: string; isInternal?: boolean; dryRun?: boolean;
  }): Promise<CallToolResult> => {
    const outcome = emptyOutcome(dryRun === true);
    const resolved = await resolveBatch(client, ticketKeys, outcome);
    for (const [k, t] of resolved) {
      if (dryRun) { outcome.skipped.push(k); continue; }
      try {
        await client.post(`/tickets/${t.id}/comments`, {
          content: text,
          isInternal: isInternal ?? false,
        });
        outcome.successful.push(k);
      } catch (err) {
        outcome.failed.push({ ticketKey: k, error: errMessage(err) });
      }
    }
    return bulkResult('bulk_comment', outcome);
  };
}

// ---------------------------------------------------------------------------
// orboto_bulk_assign_tickets / orboto_bulk_unassign_tickets
// ---------------------------------------------------------------------------

/** Resolve email → userId once per project. The bulk operation may
 *  touch tickets across multiple projects; we memoize the lookup so we
 *  don't refetch the members list for every ticket. */
async function makeAssigneeResolver(client: OrbotoClient, email: string) {
  const cache = new Map<string, string>();
  return async (projectId: string): Promise<string> => {
    const cached = cache.get(projectId);
    if (cached) return cached;
    const members = await client.get<MemberRow[]>(`/projects/${projectId}/members`);
    const m = members.find((x) => x.user.email.toLowerCase() === email.toLowerCase());
    if (!m) throw new Error(`No project member with email "${email}" in this project.`);
    cache.set(projectId, m.userId);
    return m.userId;
  };
}

export const bulkAssignTicketsToolConfig = {
  title: 'Assign the same user to many tickets',
  description:
    'POST `assigneeEmail` as an additional assignee on every ticket in `ticketKeys`. Multi-assignee is supported — this adds, it does not replace. Idempotent: a 409 (already assigned) counts as success.',
  inputSchema: z.object({
    ticketKeys: TICKET_KEY_ARRAY,
    assigneeEmail: z.string().email(),
    dryRun: z.boolean().optional(),
  }).shape,
};

export function makeBulkAssignTicketsHandler(client: OrbotoClient) {
  return async ({ ticketKeys, assigneeEmail, dryRun }: {
    ticketKeys: string[]; assigneeEmail: string; dryRun?: boolean;
  }): Promise<CallToolResult> => {
    const outcome = emptyOutcome(dryRun === true);
    const resolved = await resolveBatch(client, ticketKeys, outcome);
    const resolveAssignee = await makeAssigneeResolver(client, assigneeEmail);
    for (const [k, t] of resolved) {
      if (dryRun) { outcome.skipped.push(k); continue; }
      try {
        const userId = await resolveAssignee(t.projectId);
        try {
          await client.post(`/projects/${t.projectId}/tickets/${t.id}/assignees/${userId}`, {});
        } catch (err) {
          if (err instanceof OrbotoApiError && err.status === 409) {
            // Already assigned → idempotent success.
            outcome.successful.push(k);
            continue;
          }
          throw err;
        }
        outcome.successful.push(k);
      } catch (err) {
        outcome.failed.push({ ticketKey: k, error: errMessage(err) });
      }
    }
    return bulkResult(`bulk_assign ${assigneeEmail}`, outcome);
  };
}

export const bulkUnassignTicketsToolConfig = {
  title: 'Unassign the same user from many tickets',
  description:
    'DELETE `assigneeEmail` from every ticket in `ticketKeys`. Idempotent: a 404 (was not assigned) counts as success.',
  inputSchema: z.object({
    ticketKeys: TICKET_KEY_ARRAY,
    assigneeEmail: z.string().email(),
    dryRun: z.boolean().optional(),
  }).shape,
};

export function makeBulkUnassignTicketsHandler(client: OrbotoClient) {
  return async ({ ticketKeys, assigneeEmail, dryRun }: {
    ticketKeys: string[]; assigneeEmail: string; dryRun?: boolean;
  }): Promise<CallToolResult> => {
    const outcome = emptyOutcome(dryRun === true);
    const resolved = await resolveBatch(client, ticketKeys, outcome);
    const resolveAssignee = await makeAssigneeResolver(client, assigneeEmail);
    for (const [k, t] of resolved) {
      if (dryRun) { outcome.skipped.push(k); continue; }
      try {
        const userId = await resolveAssignee(t.projectId);
        try {
          await client.delete(`/projects/${t.projectId}/tickets/${t.id}/assignees/${userId}`);
        } catch (err) {
          if (err instanceof OrbotoApiError && err.status === 404) {
            // Wasn't assigned → idempotent success.
            outcome.successful.push(k);
            continue;
          }
          throw err;
        }
        outcome.successful.push(k);
      } catch (err) {
        outcome.failed.push({ ticketKey: k, error: errMessage(err) });
      }
    }
    return bulkResult(`bulk_unassign ${assigneeEmail}`, outcome);
  };
}

/**
 * ORB-799 - bulk-* writes.
 *
 * @see ORB-1, ORB-2
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

const TICKET_KEY_ARRAY = z.array(z.string().min(3)).min(1).max(200).optional()
  .describe('Ticket keys (e.g. ["ACME-1", "ACME-2"]). Capped at 200 per call to keep the per-tenant rate-limit budget reasonable. Give either ticketKeys or query.');
/** ORB-2054 - the target set can be an OQL query instead of a key list. */
const QUERY_SOURCE = z.string().min(1).max(8000).optional()
  .describe('OQL query selecting the tickets instead of ticketKeys (same grammar as orboto_query, caller ACL applies). At most 200 matches per call - narrow it or use POST /projects/{id}/tickets/bulk with `query` for a server-side run.');
const QUERY_PROJECT = z.string().optional()
  .describe('Project key that scopes `query` (prepended as project = KEY).');
/** Matches per call the MCP loop will process; above that the server-side bulk route is the right tool. */
export const BULK_QUERY_MAX = 200;

/** Resolve `query` to ticket keys through POST /query, paging until the cap. */
export async function resolveQueryKeys(client: OrbotoClient, query: string, projectKey?: string): Promise<string[]> {
  const oql = projectKey ? `project = ${projectKey} AND (${query})` : query;
  const keys: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await client.post<{ items: Array<{ ticketKey?: string; id: string }>; nextCursor: string | null }>('/query', {
      oql, syntax: 'oql', limit: 100, ...(cursor ? { cursor } : {}),
    });
    for (const t of page.items) keys.push(t.ticketKey ?? t.id);
    if (keys.length > BULK_QUERY_MAX) {
      throw new Error(`The query matches more than ${BULK_QUERY_MAX} tickets - narrow it, or call POST /projects/{id}/tickets/bulk with \`query\` (dryRun first) for a server-side run.`);
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  if (keys.length === 0) throw new Error('The query matched no tickets.');
  return keys;
}

interface TargetInput { ticketKeys?: string[]; query?: string; projectKey?: string }

/** One of ticketKeys / query, resolved to the key list the loops iterate. */
async function targetKeys(client: OrbotoClient, input: TargetInput): Promise<string[]> {
  if ((input.ticketKeys ? 1 : 0) + (input.query ? 1 : 0) !== 1) {
    throw new Error('Give exactly one of ticketKeys or query.');
  }
  return input.query ? resolveQueryKeys(client, input.query, input.projectKey) : (input.ticketKeys as string[]);
}

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
    `${outcome.dryRun ? '[dry-run] ' : ''}${action} - ${outcome.successful.length} ok, ${outcome.failed.length} failed${outcome.skipped.length ? `, ${outcome.skipped.length} skipped` : ''}.`,
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
    if (err.status === 403) return 'Forbidden - caller lacks permission on this ticket.';
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

export const bulkPatchTicketsToolConfig = {
  title: 'Apply the same patch to many tickets',
  description:
    'PATCH every ticket in `ticketKeys` (or the tickets `query` selects) with the same `patch` body. The patch shape mirrors `orboto_update_ticket`: title, description, type, priority, dueDate, startDate, isPrivate, estimatedTimeMinutes. To move many tickets between status categories, use `orboto_bulk_move_tickets` instead. Returns `{successful, failed, skipped, dryRun}` so the caller can branch on partial failures.',
  inputSchema: z.object({
    ticketKeys: TICKET_KEY_ARRAY,
    query: QUERY_SOURCE,
    projectKey: QUERY_PROJECT,
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
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
};

export function makeBulkPatchTicketsHandler(client: OrbotoClient) {
  return async ({ ticketKeys, query, projectKey, patch, dryRun }: {
    ticketKeys?: string[];
    query?: string;
    projectKey?: string;
    patch: Record<string, unknown>;
    dryRun?: boolean;
  }): Promise<CallToolResult> => {
    const outcome = emptyOutcome(dryRun === true);
    const resolved = await resolveBatch(client, await targetKeys(client, { ticketKeys, query, projectKey }), outcome);
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

export const bulkMoveTicketsToolConfig = {
  title: 'Move many tickets to a status category',
  description:
    'Move every ticket in `ticketKeys` (or the tickets `query` selects) to the same status category (todo / in_progress / in_review / done / wont_fix). Each ticket lands on its own project\'s first status with that category. Returns the per-ticket outcome.',
  inputSchema: z.object({
    ticketKeys: TICKET_KEY_ARRAY,
    query: QUERY_SOURCE,
    projectKey: QUERY_PROJECT,
    statusCategory: z.enum(STATUS_CATEGORIES),
    dryRun: z.boolean().optional(),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
};

export function makeBulkMoveTicketsHandler(client: OrbotoClient) {
  return async ({ ticketKeys, query, projectKey, statusCategory, dryRun }: {
    ticketKeys?: string[];
    query?: string;
    projectKey?: string; statusCategory: StatusCategory; dryRun?: boolean;
  }): Promise<CallToolResult> => {
    const outcome = emptyOutcome(dryRun === true);
    const resolved = await resolveBatch(client, await targetKeys(client, { ticketKeys, query, projectKey }), outcome);
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

export const bulkCloseTicketsToolConfig = {
  title: 'Close many tickets (optionally with a shared comment)',
  description:
    'For every ticket in `ticketKeys` (or the tickets `query` selects): optionally post the same `comment` first, then move it to `done`. Mirrors `orboto.mjs bulk-close`. Comment-first ordering means the close note lands in the audit trail even if the status PATCH 403s.',
  inputSchema: z.object({
    ticketKeys: TICKET_KEY_ARRAY,
    query: QUERY_SOURCE,
    projectKey: QUERY_PROJECT,
    comment: z.string().min(1).optional().describe('Optional shared closing comment posted on each ticket before its status move.'),
    dryRun: z.boolean().optional(),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
};

export function makeBulkCloseTicketsHandler(client: OrbotoClient) {
  return async ({ ticketKeys, query, projectKey, comment, dryRun }: {
    ticketKeys?: string[];
    query?: string;
    projectKey?: string; comment?: string; dryRun?: boolean;
  }): Promise<CallToolResult> => {
    const outcome = emptyOutcome(dryRun === true);
    const resolved = await resolveBatch(client, await targetKeys(client, { ticketKeys, query, projectKey }), outcome);
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

export const bulkCommentTicketsToolConfig = {
  title: 'Post the same comment on many tickets',
  description:
    'Append the same comment body to every ticket in `ticketKeys` (or the tickets `query` selects). Useful for "I am back-propagating decision X to all affected tickets" workflows. `isInternal=true` hides from external/guest users.',
  inputSchema: z.object({
    ticketKeys: TICKET_KEY_ARRAY,
    query: QUERY_SOURCE,
    projectKey: QUERY_PROJECT,
    text: z.string().min(1),
    isInternal: z.boolean().optional(),
    dryRun: z.boolean().optional(),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};

export function makeBulkCommentTicketsHandler(client: OrbotoClient) {
  return async ({ ticketKeys, query, projectKey, text, isInternal, dryRun }: {
    ticketKeys?: string[];
    query?: string;
    projectKey?: string; text: string; isInternal?: boolean; dryRun?: boolean;
  }): Promise<CallToolResult> => {
    const outcome = emptyOutcome(dryRun === true);
    const resolved = await resolveBatch(client, await targetKeys(client, { ticketKeys, query, projectKey }), outcome);
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
    'POST `assigneeEmail` as an additional assignee on every ticket in `ticketKeys` (or the tickets `query` selects). Multi-assignee is supported - this adds, it does not replace. Idempotent: a 409 (already assigned) counts as success.',
  inputSchema: z.object({
    ticketKeys: TICKET_KEY_ARRAY,
    query: QUERY_SOURCE,
    projectKey: QUERY_PROJECT,
    assigneeEmail: z.string().email(),
    dryRun: z.boolean().optional(),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
};

export function makeBulkAssignTicketsHandler(client: OrbotoClient) {
  return async ({ ticketKeys, query, projectKey, assigneeEmail, dryRun }: {
    ticketKeys?: string[];
    query?: string;
    projectKey?: string; assigneeEmail: string; dryRun?: boolean;
  }): Promise<CallToolResult> => {
    const outcome = emptyOutcome(dryRun === true);
    const resolved = await resolveBatch(client, await targetKeys(client, { ticketKeys, query, projectKey }), outcome);
    const resolveAssignee = await makeAssigneeResolver(client, assigneeEmail);
    for (const [k, t] of resolved) {
      if (dryRun) { outcome.skipped.push(k); continue; }
      try {
        const userId = await resolveAssignee(t.projectId);
        try {
          await client.post(`/projects/${t.projectId}/tickets/${t.id}/assignees/${userId}`, {});
        } catch (err) {
          if (err instanceof OrbotoApiError && err.status === 409) {
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
    'DELETE `assigneeEmail` from every ticket in `ticketKeys` (or the tickets `query` selects). Idempotent: a 404 (was not assigned) counts as success.',
  inputSchema: z.object({
    ticketKeys: TICKET_KEY_ARRAY,
    query: QUERY_SOURCE,
    projectKey: QUERY_PROJECT,
    assigneeEmail: z.string().email(),
    dryRun: z.boolean().optional(),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
};

export function makeBulkUnassignTicketsHandler(client: OrbotoClient) {
  return async ({ ticketKeys, query, projectKey, assigneeEmail, dryRun }: {
    ticketKeys?: string[];
    query?: string;
    projectKey?: string; assigneeEmail: string; dryRun?: boolean;
  }): Promise<CallToolResult> => {
    const outcome = emptyOutcome(dryRun === true);
    const resolved = await resolveBatch(client, await targetKeys(client, { ticketKeys, query, projectKey }), outcome);
    const resolveAssignee = await makeAssigneeResolver(client, assigneeEmail);
    for (const [k, t] of resolved) {
      if (dryRun) { outcome.skipped.push(k); continue; }
      try {
        const userId = await resolveAssignee(t.projectId);
        try {
          await client.delete(`/projects/${t.projectId}/tickets/${t.id}/assignees/${userId}`);
        } catch (err) {
          if (err instanceof OrbotoApiError && err.status === 404) {
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

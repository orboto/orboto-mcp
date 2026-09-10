/**
 * ORB-799 - composite ticket-lifecycle tools.
 *
 * @see ORB-179, ORB-181
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OrbotoApiError, type OrbotoClient } from '../orboto-client.js';
import { mcpInstanceToken, resolveTicketByKey, type TicketRow } from './shared.js';

interface UserRow {
  id: string;
  email: string;
  fullName: string | null;
  isBot?: boolean;
}

interface ActiveTimer {
  id: string;
  userId: string;
  ticketId: string;
  ticketTitle?: string;
  startedAt: string;
}

interface TicketWithAssignees extends TicketRow {
  assignees?: Array<{ id: string; email: string; fullName: string }>;
}

const CATEGORY_TO_LEGACY = {
  todo: 'TODO',
  in_progress: 'IN_PROGRESS',
  in_review: 'IN_REVIEW',
  done: 'DONE',
  wont_fix: 'WONT_FIX',
} as const;

export const claimToolConfig = {
  title: 'Claim a ticket (assign self + in_progress + timer)',
  description:
    'Composite of `assign self → move to in_progress → start timer` - the canonical "I am picking this up now" move. Idempotent: re-claiming an already-claimed in_progress ticket is a no-op. Set `sole=true` to remove every other assignee first (destructive take-over). Set `force=true` to allow re-claiming a `done` ticket (otherwise refuses, to prevent accidental reopens). Set `noTimer=true` to skip the timer start (e.g. when you only want ownership, not time tracking). If a different ticket has an active timer, it is stopped first (its elapsed time commits a time entry under the previous ticket). '
    + '`agentSessionToken` is a stable per-agent-instance token: on a bot/service account it scopes the timer to YOUR instance - concurrent per-instance timers and NO auto-stop, so you own both start and stop. Omit it on human accounts, which keep the single-timer behaviour.',
  inputSchema: z.object({
    ticketKey: z.string().min(3),
    sole: z.boolean().optional().describe('Take-over: remove every other assignee first.'),
    force: z.boolean().optional().describe('Allow re-claiming a `done` ticket.'),
    noTimer: z.boolean().optional().describe('Skip the timer start.'),
    agentSessionToken: z.string().optional().describe('Per-agent-instance token; scopes the timer on bot accounts.'),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
};

export function makeClaimHandler(client: OrbotoClient) {
  return async ({ ticketKey, sole, force, noTimer, agentSessionToken }: {
    ticketKey: string; sole?: boolean; force?: boolean; noTimer?: boolean; agentSessionToken?: string;
  }, extra?: { sessionId?: string }): Promise<CallToolResult> => {
    const me = await client.get<UserRow>('/users/me');
    const current = await resolveTicketByKey(client, ticketKey) as TicketWithAssignees;
    const currentAssignees = current.assignees ?? [];
    const alreadyAssigned = currentAssignees.some((a) => a.id === me.id);
    const currentCategory = current.statusCategory;

    if (currentCategory === 'done' && !force) {
      throw new Error(
        `Refusing to claim [${current.ticketKey}]: status is "done". Pass force=true to reopen + claim.`,
      );
    }

    if (sole) {
      for (const a of currentAssignees) {
        if (a.id === me.id) continue;
        try {
          await client.delete(`/projects/${current.projectId}/tickets/${current.id}/assignees/${a.id}`);
        } catch (err) {
          if (!(err instanceof OrbotoApiError) || err.status !== 404) throw err;
        }
      }
    }

    if (!alreadyAssigned) {
      try {
        await client.post(`/projects/${current.projectId}/tickets/${current.id}/assignees/${me.id}`, {});
      } catch (err) {
        if (!(err instanceof OrbotoApiError) || err.status !== 409) throw err;
      }
    }

    let finalTicket: TicketWithAssignees = current;
    if (currentCategory !== 'in_progress') {
      finalTicket = await client.patch<TicketWithAssignees>(
        `/projects/${current.projectId}/tickets/${current.id}`,
        { status: CATEGORY_TO_LEGACY.in_progress },
      );
    }

    let timerStarted = false;
    let timerWarning: string | null = null;
    const effectiveToken = agentSessionToken ?? (me.isBot ? mcpInstanceToken(undefined, extra) : undefined);
    if (!noTimer) {
      try {
        if (effectiveToken) {
          await client.post('/time/timer/start', { ticketId: current.id, agentSessionToken: effectiveToken });
          timerStarted = true;
        } else {
        const active = await client.get<ActiveTimer | null>('/time/timer').catch(() => null);
        if (active && active.ticketId && active.ticketId !== current.id) {
          const other = active.ticketTitle ? `"${active.ticketTitle}"` : active.ticketId;
          await client.post('/time/timer/stop', {
            note: `Auto-stopped by claim of ${finalTicket.ticketKey ?? current.id}`,
          }).catch(() => {
            timerWarning = `Failed to stop timer on ${other}; new timer not started.`;
          });
        } else if (active && active.ticketId === current.id) {
          timerStarted = true;
        }
        if (!timerStarted && !timerWarning) {
          await client.post('/time/timer/start', { ticketId: current.id });
          timerStarted = true;
        }
        }
      } catch (err) {
        if (err instanceof OrbotoApiError && err.status === 409) {
          timerWarning = 'A timer is already running on another ticket; could not start one here. Run `orboto_timer_stop` first.';
        } else {
          timerWarning = err instanceof Error ? err.message : String(err);
        }
      }
    }

    const noop =
      alreadyAssigned &&
      currentCategory === 'in_progress' &&
      !sole &&
      (noTimer || timerStarted);

    const lines = [
      `Claimed [${finalTicket.ticketKey}] ${finalTicket.title}`,
      `  status: ${finalTicket.statusName ?? finalTicket.status}`,
      noTimer ? '  timer: skipped (noTimer=true)' : `  timer: ${timerStarted ? 'started' : 'not started'}`,
      timerWarning ? `  warning: ${timerWarning}` : null,
      noop ? '  (no-op - already claimed + in_progress)' : null,
    ].filter((l): l is string => l !== null);

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: {
        ticketKey: finalTicket.ticketKey,
        status: finalTicket.statusName ?? finalTicket.status,
        statusCategory: finalTicket.statusCategory,
        assignedSelf: true,
        soleTakeover: sole === true,
        timerStarted,
        timerWarning,
        noop,
      },
    };
  };
}

export const unclaimToolConfig = {
  title: 'Unclaim a ticket (composite: unassign self + move to todo)',
  description:
    'Inverse of `orboto_claim`: remove the calling user as an assignee and move the ticket back to `todo`. Idempotent - if the caller wasn\'t an assignee, the unassign step is a no-op and the status move still happens. Does not stop a running timer (use `orboto_timer_stop` if you want that side-effect; staying separate avoids surprising the next claimant).',
  inputSchema: z.object({
    ticketKey: z.string().min(3),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
};

export function makeUnclaimHandler(client: OrbotoClient) {
  return async ({ ticketKey }: { ticketKey: string }): Promise<CallToolResult> => {
    const me = await client.get<UserRow>('/users/me');
    const ticket = await resolveTicketByKey(client, ticketKey) as TicketWithAssignees;
    let alreadyUnassigned = false;
    try {
      await client.delete(`/projects/${ticket.projectId}/tickets/${ticket.id}/assignees/${me.id}`);
    } catch (err) {
      if (err instanceof OrbotoApiError && err.status === 404) {
        alreadyUnassigned = true;
      } else {
        throw err;
      }
    }
    const updated = await client.patch<TicketWithAssignees>(
      `/projects/${ticket.projectId}/tickets/${ticket.id}`,
      { status: CATEGORY_TO_LEGACY.todo },
    );
    return {
      content: [{
        type: 'text',
        text: `Unclaimed [${updated.ticketKey}] - moved to ${updated.statusName ?? updated.status}${alreadyUnassigned ? ' (was not assigned)' : ''}.`,
      }],
      structuredContent: {
        ticketKey: updated.ticketKey,
        status: updated.statusName ?? updated.status,
        statusCategory: updated.statusCategory,
        alreadyUnassigned,
      },
    };
  };
}

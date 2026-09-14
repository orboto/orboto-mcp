/**
 * ORB-799 - composite ticket-lifecycle tools.
 *
 * @see ORB-179, ORB-181
 */
import { specGateFailure, isAlreadyAssigned } from './spec-schemas.js';
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

interface TicketWithAssignees extends Omit<TicketRow, 'assignees'> {
  assignees?: Array<{ id?: string; userId?: string; email: string; fullName: string }>;
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
    'Assign yourself, move to in_progress and start a timer. Repeated claims recheck the specification gate. Worker bots need ready, or override=true with a reason; enabled epics are blocked. sole removes other assignees after the gate passes. force permits reopening done tickets. noTimer skips time tracking. On human accounts a different active timer is stopped first and its elapsed time booked to that ticket. Bot timers are per instance and never auto-stop each other: agentSessionToken defaults to this MCP connection; own both start and stop.',
  inputSchema: z.object({
    ticketKey: z.string().min(3),
    override: z.boolean().optional().describe("Spec override; reason required."),
    reason: z.string().trim().min(1).max(2000).optional(),
    sole: z.boolean().optional().describe('Remove other assignees after gate.'),
    force: z.boolean().optional().describe('Reopen done.'),
    noTimer: z.boolean().optional().describe('No timer.'),
    agentSessionToken: z.string().optional().describe('Instance token for bot timers.'),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
};

export function makeClaimHandler(client: OrbotoClient) {
  return async ({ ticketKey, sole, force, override, reason, noTimer, agentSessionToken }: {
    ticketKey: string; override?: boolean; reason?: string; sole?: boolean; force?: boolean; noTimer?: boolean; agentSessionToken?: string;
  }, extra?: { sessionId?: string }): Promise<CallToolResult> => {
    const me = await client.get<UserRow>('/users/me');
    const current = await resolveTicketByKey(client, ticketKey) as TicketWithAssignees;
    const currentAssignees = current.assignees ?? [];
    const alreadyAssigned = currentAssignees.some((a) => (a.userId ?? a.id) === me.id);
    const currentCategory = current.statusCategory;

    if (currentCategory === 'done' && !force) {
      throw new Error(
        `Refusing to claim [${current.ticketKey}]: status is "done". Pass force=true to reopen + claim.`,
      );
    }

    try {
      await client.post(`/projects/${current.projectId}/tickets/${current.id}/assignees/${me.id}`, { override, reason });
    } catch (error) {
      const gate = error instanceof OrbotoApiError && error.status === 409 ? specGateFailure(error.body) : undefined;
      if (gate) return gate;
      if (!(error instanceof OrbotoApiError) || error.status !== 409 || !isAlreadyAssigned(error.body)) throw error;
    }

    if (sole) {
      for (const a of currentAssignees) {
        if ((a.userId ?? a.id) === me.id) continue;
        try {
          await client.delete(`/projects/${current.projectId}/tickets/${current.id}/assignees/${a.userId ?? a.id}`);
        } catch (err) {
          if (!(err instanceof OrbotoApiError) || err.status !== 404) throw err;
        }
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

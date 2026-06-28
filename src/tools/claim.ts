/**
 * ORB-799 — composite ticket-lifecycle tools.
 *
 * Two tools that bundle the most-used wrapper composites:
 *
 *   - orboto_claim   ≈ assign_self + move(in_progress) + timer_start
 *   - orboto_unclaim ≈ unassign_self + move(todo)
 *
 * The composite-atomic behaviour is the real value here — these are
 * the most-typed wrapper commands by agents during ticket pickup. The
 * 1:1 mirror of `orboto.mjs claim` semantics matters:
 *
 *   - `--sole` (`sole=true`) — destructive take-over: remove every
 *     other assignee before adding self. Use sparingly; the API has
 *     no atomic swap so this is a delete-loop + add.
 *   - `--force` (`force=true`) — allow re-claiming a `done` ticket
 *     (the wrapper refuses without it to prevent accidental reopen).
 *   - `--no-timer` (`noTimer=true`) — skip the timer_start side
 *     effect. Useful when the agent only wants ownership-by-assignee
 *     without committing time.
 *
 * Both tools are **idempotent** on the happy paths:
 *   - claim of a ticket where the caller is already an assignee and
 *     statusCategory is already `in_progress` → no PATCH, no extra
 *     assignee POST (the wrapper still POSTs once and 409s; we skip).
 *   - unclaim of a ticket where the caller isn't an assignee → 404 on
 *     DELETE is swallowed, status move still happens.
 *
 * Timer side-effects mirror ORB-179 (`claim`) + ORB-181 (`close`):
 *   - If a different ticket has an active timer, stop it first
 *     (commits the elapsed time-entry under the previous ticket's
 *     description), then start a fresh timer on this one.
 *   - Timer failures never roll back the assign/status work — we
 *     surface them as a `timerWarning` field on the structured
 *     response, same shape as the wrapper.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OrbotoApiError, type OrbotoClient } from '../orboto-client.js';
import { resolveTicketByKey, type TicketRow } from './shared.js';

interface UserRow {
  id: string;
  email: string;
  fullName: string | null;
  isBot?: boolean;
}

// ORB-1252 / ORB-1283 — auto-derived per-instance timer token (zero config):
// one MCP server process = one agent instance. On a bot/service account the
// timer is scoped to it (concurrent per-instance, no cross-instance stomp).
// A per-process random UUID (minted once at module load) is used rather than
// the PID, because PIDs are recycled by the OS — a fresh process could inherit
// a recycled PID and collide with a previous instance's stale/abandoned timer.
// Precedence at the call site: explicit agentSessionToken arg > per-connection
// MCP session id (HTTP) > this per-process token (stdio).
const MCP_AGENT_INSTANCE = `mcp-${randomUUID()}`;

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

// `statusCategory` is the discriminator the API exposes on every
// ticket-read response; we map it (rather than `status` legacy enum)
// because that's what the wrapper inspects too.
const CATEGORY_TO_LEGACY = {
  todo: 'TODO',
  in_progress: 'IN_PROGRESS',
  in_review: 'IN_REVIEW',
  done: 'DONE',
  wont_fix: 'WONT_FIX',
} as const;

// ---------------------------------------------------------------------------
// orboto_claim
// ---------------------------------------------------------------------------

export const claimToolConfig = {
  title: 'Claim a ticket (composite: assign self + move to in_progress + start timer)',
  description:
    'Composite of `assign self → move to in_progress → start timer` — the canonical "I am picking this up now" move. Idempotent: re-claiming an already-claimed in_progress ticket is a no-op. Set `sole=true` to remove every other assignee first (destructive take-over). Set `force=true` to allow re-claiming a `done` ticket (otherwise refuses, to prevent accidental reopens). Set `noTimer=true` to skip the timer start (e.g. when you only want ownership, not time tracking). If a different ticket has an active timer, it is stopped first (its elapsed time commits a time entry under the previous ticket).',
  inputSchema: z.object({
    ticketKey: z.string().min(3),
    sole: z.boolean().optional().describe('Destructive take-over: remove every other assignee before adding self.'),
    force: z.boolean().optional().describe('Allow re-claiming a ticket whose status is already `done`.'),
    noTimer: z.boolean().optional().describe('Skip the timer-start step. Assign + status move still happen.'),
    agentSessionToken: z.string().optional().describe('A stable per-agent-instance token. On a bot/service account this scopes the timer to your instance: concurrent per-instance timers, NO auto-stop (you own start AND stop). Omit on human accounts / for single-timer behaviour.'),
  }).shape,
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

    // --sole: destructive take-over. Remove every other assignee
    // first. Each DELETE tolerates a 404 (race condition where another
    // process already unassigned them).
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

    // Additive self-add. Skip if we're already on the ticket — POSTing
    // again would 409; idempotency here matters because agents call
    // claim defensively at the start of every operation.
    if (!alreadyAssigned) {
      try {
        await client.post(`/projects/${current.projectId}/tickets/${current.id}/assignees/${me.id}`, {});
      } catch (err) {
        // 409 = race-added by another process while we were checking.
        // Treat as already-assigned success.
        if (!(err instanceof OrbotoApiError) || err.status !== 409) throw err;
      }
    }

    // Only PATCH if we're not already in_progress. Saves an audit row
    // + websocket broadcast on the common re-claim path.
    let finalTicket: TicketWithAssignees = current;
    if (currentCategory !== 'in_progress') {
      finalTicket = await client.patch<TicketWithAssignees>(
        `/projects/${current.projectId}/tickets/${current.id}`,
        { status: CATEGORY_TO_LEGACY.in_progress },
      );
    }

    // Timer side-effects. Mirrors the wrapper's ORB-179 path: stop a
    // timer running on a different ticket, then start fresh here. A
    // 409 on the start side is captured as a warning rather than
    // raised, so the assign/status work still counts as success.
    let timerStarted = false;
    let timerWarning: string | null = null;
    // Bot/service accounts own their timer (per-instance, no auto-stop). Instance
    // id: explicit arg > per-connection MCP session id (distinct per client even
    // on a shared HTTP server) > per-process id (stdio). Human accounts fall
    // through to the legacy auto-stop path.
    const mcpInstance = extra?.sessionId ? `mcp-${extra.sessionId}` : MCP_AGENT_INSTANCE;
    const effectiveToken = agentSessionToken ?? (me.isBot ? mcpInstance : undefined);
    if (!noTimer) {
      try {
        if (effectiveToken) {
          // ORB-1252 — agent instance owns its timer: per-session, no auto-stop.
          // Idempotent on the same ticket; 409 if this session already runs a
          // different ticket (surfaced as a warning below).
          await client.post('/time/timer/start', { ticketId: current.id, agentSessionToken: effectiveToken });
          timerStarted = true;
        } else {
        const active = await client.get<ActiveTimer | null>('/time/timer').catch(() => null);
        if (active && active.ticketId && active.ticketId !== current.id) {
          const other = active.ticketTitle ? `"${active.ticketTitle}"` : active.ticketId;
          await client.post('/time/timer/stop', {
            note: `Auto-stopped by claim of ${finalTicket.ticketKey ?? current.id}`,
          }).catch(() => {
            // Swallow — we'll try start below; if start 409s we surface
            // the warning then.
            timerWarning = `Failed to stop timer on ${other}; new timer not started.`;
          });
        } else if (active && active.ticketId === current.id) {
          // Same ticket — effectively already started.
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
          // Any other timer error → keep the claim, surface the issue.
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
      noop ? '  (no-op — already claimed + in_progress)' : null,
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

// ---------------------------------------------------------------------------
// orboto_unclaim
// ---------------------------------------------------------------------------

export const unclaimToolConfig = {
  title: 'Unclaim a ticket (composite: unassign self + move to todo)',
  description:
    'Inverse of `orboto_claim`: remove the calling user as an assignee and move the ticket back to `todo`. Idempotent — if the caller wasn\'t an assignee, the unassign step is a no-op and the status move still happens. Does not stop a running timer (use `orboto_timer_stop` if you want that side-effect; staying separate avoids surprising the next claimant).',
  inputSchema: z.object({
    ticketKey: z.string().min(3),
  }).shape,
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
        text: `Unclaimed [${updated.ticketKey}] — moved to ${updated.statusName ?? updated.status}${alreadyUnassigned ? ' (was not assigned)' : ''}.`,
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

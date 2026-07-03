/**
 * ORB-244 Phase C Group 2 — time-tracking tools.
 *
 * Three tools that wrap the existing /time/timer/* + /tickets/:id/time-entries
 * endpoints:
 *   - orboto_timer_start (ticketKey, description?, replace?)
 *   - orboto_timer_stop  — closes the running timer; the API converts
 *                         elapsed time into a time_entries row using the
 *                         description set at start.
 *   - orboto_log_time    — direct time-entry POST for after-the-fact
 *                         logging (no running timer involved).
 *
 * Note: the wrapper's `timer-stop "note"` syntax sends a `note` field
 * the API silently ignores — the time entry's description is whatever
 * was set on `start`. To attach a note to a stopped session, post a
 * comment afterwards via `orboto_comment`. The MCP tool only accepts
 * what the API actually accepts.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OrbotoApiError, type OrbotoClient } from '../orboto-client.js';
import { resolveTicketByKey } from './shared.js';

interface ActiveTimer {
  id: string;
  userId: string;
  ticketId: string;
  startedAt: string;
  pausedAt: string | null;
  accumulatedSeconds: number;
  description: string | null;
  ticketTitle?: string;
  projectId?: string;
}

interface TimeEntry {
  id: string;
  ticketId: string;
  userId: string;
  durationMinutes: number;
  description: string | null;
  loggedAt: string;
  agentLabel?: string | null;
  // ORB-1368 - true when the entry was logged via an agent-flagged key or a
  // bot account. Server-derived; distinct from agentLabel (which instance).
  isAgentWork?: boolean;
}

// ---------------------------------------------------------------------------
// orboto_timer_start
// ---------------------------------------------------------------------------

export const timerStartToolConfig = {
  title: 'Start a timer on a ticket',
  description:
    'Start the user\'s stopwatch on a ticket. If a timer is already running on a different ticket, pass replace=true to auto-stop the previous one (its elapsed time is committed to time_entries before the new timer begins). Description becomes the time entry\'s note when this timer eventually stops.',
  inputSchema: z.object({
    ticketKey: z.string().min(3),
    description: z.string().optional().describe('Note for the resulting time entry. Set at start, not at stop.'),
    replace: z.boolean().optional().describe('If a timer is already running, stop+commit it first (default: 409 instead).'),
  }).shape,
};

export function makeTimerStartHandler(client: OrbotoClient) {
  return async ({ ticketKey, description, replace }: {
    ticketKey: string; description?: string; replace?: boolean;
  }): Promise<CallToolResult> => {
    const ticket = await resolveTicketByKey(client, ticketKey);
    const body: Record<string, unknown> = { ticketId: ticket.id };
    if (description) body.description = description;
    if (replace) body.replace = true;

    try {
      const timer = await client.post<ActiveTimer>('/time/timer/start', body);
      return {
        content: [{
          type: 'text',
          text: `Timer started on [${ticket.ticketKey}] ${ticket.title}${description ? ` — note: ${description}` : ''}`,
        }],
        structuredContent: {
          ticketKey: ticket.ticketKey,
          startedAt: timer.startedAt,
          description: timer.description,
        },
      };
    } catch (err) {
      // 409 = a timer is already running on a different ticket.
      // Surface the API's hint about `replace` rather than letting
      // the model guess.
      if (err instanceof OrbotoApiError && err.status === 409) {
        throw new Error(
          'A timer is already running on a different ticket. Pass replace=true to commit its elapsed time and start fresh on this one.',
        );
      }
      throw err;
    }
  };
}

// ---------------------------------------------------------------------------
// orboto_timer_stop
// ---------------------------------------------------------------------------

export const timerStopToolConfig = {
  title: 'Stop the running timer',
  description:
    'Stop the user\'s stopwatch. The API commits a time_entries row using the description set at start (or pause/resume), then deletes the active-timer record. Returns the duration in minutes.',
  inputSchema: z.object({}).shape,
};

export function makeTimerStopHandler(client: OrbotoClient) {
  return async (): Promise<CallToolResult> => {
    try {
      const res = await client.post<{ durationMinutes: number }>('/time/timer/stop', {});
      return {
        content: [{
          type: 'text',
          text: `Timer stopped — logged ${res.durationMinutes} min.`,
        }],
        structuredContent: { durationMinutes: res.durationMinutes },
      };
    } catch (err) {
      if (err instanceof OrbotoApiError && err.status === 404) {
        return {
          content: [{ type: 'text', text: 'No active timer to stop.' }],
          structuredContent: { durationMinutes: 0, alreadyStopped: true },
        };
      }
      throw err;
    }
  };
}

// ---------------------------------------------------------------------------
// orboto_log_time
// ---------------------------------------------------------------------------

export const logTimeToolConfig = {
  title: 'Log a time entry on a ticket',
  description:
    'Direct time-entry POST — for "I just spent 90 minutes on this last Tuesday but forgot to start a timer". `loggedAt` defaults to now; pass an ISO datetime to back-date.',
  inputSchema: z.object({
    ticketKey: z.string().min(3),
    durationMinutes: z.number().int().positive().describe('Duration in minutes (must be > 0).'),
    description: z.string().optional(),
    loggedAt: z.string().datetime().optional().describe('ISO 8601 datetime. Defaults to now.'),
  }).shape,
};

export function makeLogTimeHandler(client: OrbotoClient) {
  return async ({ ticketKey, durationMinutes, description, loggedAt }: {
    ticketKey: string; durationMinutes: number; description?: string; loggedAt?: string;
  }): Promise<CallToolResult> => {
    const ticket = await resolveTicketByKey(client, ticketKey);
    const body: Record<string, unknown> = { durationMinutes };
    if (description !== undefined) body.description = description;
    if (loggedAt) body.loggedAt = loggedAt;
    const entry = await client.post<TimeEntry>(`/tickets/${ticket.id}/time-entries`, body);
    return {
      content: [{
        type: 'text',
        text: `Logged ${entry.durationMinutes} min on [${ticket.ticketKey}]${entry.description ? ` — ${entry.description}` : ''}`,
      }],
      structuredContent: {
        ticketKey: ticket.ticketKey,
        entryId: entry.id,
        durationMinutes: entry.durationMinutes,
        description: entry.description,
        loggedAt: entry.loggedAt,
      },
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_list_time_entries  (ORB-1292)
// ---------------------------------------------------------------------------

export const listTimeEntriesToolConfig = {
  title: 'List a ticket\'s time entries',
  description:
    'List the time entries on a ticket (most recent first) with each entry\'s id, duration, date and agent label. Use this to FIND an over-tracked entry before fixing it with orboto_edit_time_entry / orboto_delete_time_entry.',
  inputSchema: z.object({
    ticketKey: z.string().min(3),
    limit: z.number().int().positive().max(100).optional().describe('Default 25.'),
  }).shape,
};

export function makeListTimeEntriesHandler(client: OrbotoClient) {
  return async ({ ticketKey, limit }: { ticketKey: string; limit?: number }): Promise<CallToolResult> => {
    const ticket = await resolveTicketByKey(client, ticketKey);
    const page = await client.get<{ items: TimeEntry[]; nextCursor: string | null }>(
      `/tickets/${ticket.id}/time-entries?limit=${limit ?? 25}`,
    );
    const lines = page.items.map((e) => {
      // ORB-1368 - agentLabel already flags a known agent instance; add a
      // bare [agent] marker for agent work with no instance label (a bot's
      // NULL-lane entry).
      const agentMark = e.agentLabel ? ` [${e.agentLabel}]` : (e.isAgentWork ? ' [agent]' : '');
      return `- ${e.durationMinutes} min - ${e.loggedAt}${agentMark}${e.description ? ` - ${e.description}` : ''} (id ${e.id})`;
    });
    return {
      content: [{
        type: 'text',
        text: page.items.length ? `Time entries on [${ticket.ticketKey}]:\n${lines.join('\n')}` : `No time entries on [${ticket.ticketKey}].`,
      }],
      structuredContent: { ticketKey: ticket.ticketKey, entries: page.items, nextCursor: page.nextCursor },
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_edit_time_entry  (ORB-1292)
// ---------------------------------------------------------------------------

export const editTimeEntryToolConfig = {
  title: 'Edit / correct a time entry',
  description:
    'Correct a time entry - fix an over-tracked duration, edit its note, change its date, or re-target it to another ticket. Use THIS (not orboto_log_time) to fix a wrong entry: log_time is additive and only makes the total worse. Get the entryId from orboto_list_time_entries (or an orboto_log_time response). Blocked if the entry is locked by an approved timesheet.',
  inputSchema: z.object({
    ticketKey: z.string().min(3).describe('The ticket the entry currently belongs to.'),
    entryId: z.string().uuid(),
    durationMinutes: z.number().int().positive().optional(),
    description: z.string().nullish(),
    loggedAt: z.string().datetime().optional(),
    moveToTicketKey: z.string().min(3).optional().describe('Re-target the entry to a different ticket.'),
  }).shape,
  annotations: { idempotentHint: true },
};

export function makeEditTimeEntryHandler(client: OrbotoClient) {
  return async ({ ticketKey, entryId, durationMinutes, description, loggedAt, moveToTicketKey }: {
    ticketKey: string; entryId: string; durationMinutes?: number; description?: string | null; loggedAt?: string; moveToTicketKey?: string;
  }): Promise<CallToolResult> => {
    const ticket = await resolveTicketByKey(client, ticketKey);
    const body: Record<string, unknown> = {};
    if (durationMinutes !== undefined) body.durationMinutes = durationMinutes;
    if (description !== undefined) body.description = description;
    if (loggedAt) body.loggedAt = loggedAt;
    if (moveToTicketKey) {
      const dest = await resolveTicketByKey(client, moveToTicketKey);
      body.ticketId = dest.id;
    }
    const updated = await client.patch<TimeEntry>(`/tickets/${ticket.id}/time-entries/${entryId}`, body);
    return {
      content: [{ type: 'text', text: `Updated time entry ${entryId.slice(0, 8)} on [${ticket.ticketKey}] → ${updated.durationMinutes} min.` }],
      structuredContent: { ticketKey: ticket.ticketKey, entryId: updated.id, durationMinutes: updated.durationMinutes, ticketId: updated.ticketId },
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_delete_time_entry  (ORB-1292)
// ---------------------------------------------------------------------------

export const deleteTimeEntryToolConfig = {
  title: 'Delete a time entry',
  description:
    'Delete a time entry - e.g. a bogus over-tracked entry that should not exist at all (prefer orboto_edit_time_entry when it should just have a different duration). You can delete your own; deleting another user\'s needs the `time:delete_others` permission. Blocked if locked by an approved timesheet. Get the entryId from orboto_list_time_entries.',
  inputSchema: z.object({
    ticketKey: z.string().min(3),
    entryId: z.string().uuid(),
  }).shape,
  annotations: { destructiveHint: true },
};

export function makeDeleteTimeEntryHandler(client: OrbotoClient) {
  return async ({ ticketKey, entryId }: { ticketKey: string; entryId: string }): Promise<CallToolResult> => {
    const ticket = await resolveTicketByKey(client, ticketKey);
    await client.delete(`/tickets/${ticket.id}/time-entries/${entryId}`);
    return {
      content: [{ type: 'text', text: `Deleted time entry ${entryId.slice(0, 8)} from [${ticket.ticketKey}].` }],
      structuredContent: { ticketKey: ticket.ticketKey, entryId, deleted: true },
    };
  };
}

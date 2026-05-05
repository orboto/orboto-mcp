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

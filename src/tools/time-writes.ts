/**
 * ORB-244 Phase C Group 2 - time-tracking tools.
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
  isAgentWork?: boolean;
}

interface BulkTimeEntryResult {
  entries: TimeEntry[];
  warnings: Array<{ kind: string; date: string; message: string }>;
  lockedDates: string[];
  totalMinutes: number;
}

export const timerStartToolConfig = {
  title: 'Start a timer on a ticket',
  description:
    'Start the user\'s stopwatch on a ticket. If a timer is already running on a different ticket, pass replace=true to auto-stop the previous one (its elapsed time is committed to time_entries before the new timer begins). Description becomes the time entry\'s note when this timer eventually stops.',
  inputSchema: z.object({
    ticketKey: z.string().min(3),
    description: z.string().optional().describe('Note for the time entry; set at start, not at stop.'),
    replace: z.boolean().optional().describe('Stop+commit a running timer first (default: 409).'),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
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
          text: `Timer started on [${ticket.ticketKey}] ${ticket.title}${description ? ` - note: ${description}` : ''}`,
        }],
        structuredContent: {
          ticketKey: ticket.ticketKey,
          startedAt: timer.startedAt,
          description: timer.description,
        },
      };
    } catch (err) {
      if (err instanceof OrbotoApiError && err.status === 409) {
        throw new Error(
          'A timer is already running on a different ticket. Pass replace=true to commit its elapsed time and start fresh on this one.',
        );
      }
      throw err;
    }
  };
}

export const timerStopToolConfig = {
  title: 'Stop the running timer',
  description:
    'Stop the user\'s stopwatch. The API commits a time_entries row using the description set at start (or pause/resume), then deletes the active-timer record. Returns the duration in minutes.',
  inputSchema: z.object({}).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
};

export function makeTimerStopHandler(client: OrbotoClient) {
  return async (): Promise<CallToolResult> => {
    try {
      const res = await client.post<{ durationMinutes: number; stopped?: boolean; laneFallback?: boolean }>('/time/timer/stop', {});
      if (res.stopped === false) {
        return {
          content: [{ type: 'text', text: 'No active timer to stop.' }],
          structuredContent: { durationMinutes: 0, alreadyStopped: true },
        };
      }
      return {
        content: [{
          type: 'text',
          text: `Timer stopped - logged ${res.durationMinutes} min.${res.laneFallback ? ' (matched via single-active-timer fallback - instance token differed from start)' : ''}`,
        }],
        structuredContent: { durationMinutes: res.durationMinutes, ...(res.laneFallback ? { laneFallback: true } : {}) },
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

export const logTimeToolConfig = {
  title: 'Log a time entry on a ticket',
  description:
    'Direct time-entry POST - for "I just spent 90 minutes on this last Tuesday but forgot to start a timer". `loggedAt` defaults to now; pass an ISO datetime to back-date. Pass `dates` (YYYY-MM-DD list) to book the same entry on several days in one call (ORB-2056): all-or-nothing, a day inside an approved timesheet refuses the set and names the day, capacity warnings come back advisory.',
  inputSchema: z.object({
    ticketKey: z.string().min(3),
    durationMinutes: z.number().int().positive().describe('Minutes, > 0.'),
    description: z.string().optional(),
    loggedAt: z.string().datetime().optional().describe('ISO 8601. Default: now. Ignored when `dates` is set.'),
    dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).min(1).max(200).optional().describe('Book this entry on each of these days (YYYY-MM-DD).'),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().describe('Wall-clock start for `dates`, workspace timezone. Default 09:00.'),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};

export function makeLogTimeHandler(client: OrbotoClient) {
  return async ({ ticketKey, durationMinutes, description, loggedAt, dates, time }: {
    ticketKey: string; durationMinutes: number; description?: string; loggedAt?: string; dates?: string[]; time?: string;
  }): Promise<CallToolResult> => {
    const ticket = await resolveTicketByKey(client, ticketKey);
    if (dates && dates.length > 0) {
      const template: Record<string, unknown> = { ticketId: ticket.id, durationMinutes };
      if (description !== undefined) template.description = description;
      if (time) template.time = time;
      const booked = await client.post<BulkTimeEntryResult>('/time-entries/bulk', { template, dates });
      const warn = booked.warnings.length ? ` - ${booked.warnings.length} capacity warning(s): ${booked.warnings.map((w) => `${w.date} ${w.kind}`).join(', ')}` : '';
      return {
        content: [{
          type: 'text',
          text: `Logged ${durationMinutes} min on [${ticket.ticketKey}] on ${booked.entries.length} day(s) (${booked.totalMinutes} min total)${warn}`,
        }],
        structuredContent: {
          ticketKey: ticket.ticketKey,
          entries: booked.entries.map((e) => ({ entryId: e.id, loggedAt: e.loggedAt, durationMinutes: e.durationMinutes })),
          totalMinutes: booked.totalMinutes,
          warnings: booked.warnings,
        },
      };
    }
    const body: Record<string, unknown> = { durationMinutes };
    if (description !== undefined) body.description = description;
    if (loggedAt) body.loggedAt = loggedAt;
    const entry = await client.post<TimeEntry>(`/tickets/${ticket.id}/time-entries`, body);
    return {
      content: [{
        type: 'text',
        text: `Logged ${entry.durationMinutes} min on [${ticket.ticketKey}]${entry.description ? ` - ${entry.description}` : ''}`,
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

export const listTimeEntriesToolConfig = {
  title: 'List a ticket\'s time entries',
  description:
    'List the time entries on a ticket (most recent first) with each entry\'s id, duration, date and agent label. Use this to FIND an over-tracked entry before fixing it with orboto_edit_time_entry / orboto_delete_time_entry.',
  inputSchema: z.object({
    ticketKey: z.string().min(3),
    limit: z.number().int().positive().max(100).optional().describe('Default 25.'),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeListTimeEntriesHandler(client: OrbotoClient) {
  return async ({ ticketKey, limit }: { ticketKey: string; limit?: number }): Promise<CallToolResult> => {
    const ticket = await resolveTicketByKey(client, ticketKey);
    const page = await client.get<{ items: TimeEntry[]; nextCursor: string | null }>(
      `/tickets/${ticket.id}/time-entries?limit=${limit ?? 25}`,
    );
    const lines = page.items.map((e) => {
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
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
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

export const deleteTimeEntryToolConfig = {
  title: 'Delete a time entry',
  description:
    'Delete a time entry - e.g. a bogus over-tracked entry that should not exist at all (prefer orboto_edit_time_entry when it should just have a different duration). You can delete your own; deleting another user\'s needs the `time:delete_others` permission. Blocked if locked by an approved timesheet. Get the entryId from orboto_list_time_entries.',
  inputSchema: z.object({
    ticketKey: z.string().min(3),
    entryId: z.string().uuid(),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
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

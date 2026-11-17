/**
 * ORB-244 Phase C Group 2 - time-tracking tools.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OrbotoApiError, type OrbotoClient } from '../orboto-client.js';
import { resolveTicketByKey } from './shared.js';
import { isoDateTime } from '../zod-v3-formats.js';

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
  source?: TimeEntrySource | null;
}

/** ORB-3102 - mirrors `TimeEntrySourceEnum` of shared-schema, pinned by the drift test. */
export const TIME_ENTRY_SOURCES = ['lease', 'timer', 'manual'] as const;
export type TimeEntrySource = (typeof TIME_ENTRY_SOURCES)[number];

/** ORB-3102 - mirrors `AgentUsageTotalsSchema` of shared-schema. */
export interface AgentUsageTotals {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  weightedTokens: number;
  costUsd: number;
  reports: number;
}

/** ORB-3101 - mirrors `DoneWithoutTimeSchema` of shared-schema. */
export interface DoneWithoutTime {
  reason: string;
  at: string;
  accountId: string | null;
  accountEmail: string | null;
  accountName: string | null;
  agentSession: string | null;
  status: string | null;
  automatic: boolean;
  source: string | null;
}

/** ORB-3102 - mirrors `TicketAgentTimeSchema` of shared-schema (`GET /tickets/:id/agent-time`). */
export interface TicketAgentTime {
  ticketId: string;
  minutes: { total: number; lease: number; timer: number; manual: number; unrecorded: number };
  declaredNone: DoneWithoutTime | null;
  usage: AgentUsageTotals | null;
  leases: Array<{
    id: string; userId: string; userEmail: string | null; userFullName: string | null; agentSessionId: string | null; agentLabel: string | null;
    startedAt: string; endedAt: string | null; stoppedBy: 'finish' | 'transition' | 'lane_stop' | 'expiry' | 'idle_cap' | null;
    bookedMinutes: number; accruedMinutes: number; timeEntryId: string | null; continuesLeaseId: string | null; usage: AgentUsageTotals | null;
  }>;
}

/** ORB-3101 - the line naming a done-without-time declaration: who declared it, when and why; empty when there is none. */
export function declaredNoneLine(declared: DoneWithoutTime | null): string[] {
  if (!declared) return [];
  const who = declared.agentSession ?? declared.accountName ?? declared.accountEmail ?? 'an agent account';
  return [`No time booked: ${who} moved it to ${declared.status ?? 'done'} on ${declared.at} without time - "${declared.reason}"`];
}

/** ORB-3102 - the usage line of a ticket: "no usage reported" is not zero. */
export function usageLine(usage: AgentUsageTotals | null): string {
  if (!usage) return 'no usage reported';
  const part = (label: string, value: number | null) => `${label} ${value ?? 'not reported'}`;
  return `${usage.weightedTokens} weighted tokens (${part('in', usage.inputTokens)}, ${part('out', usage.outputTokens)}, ${part('cache read', usage.cacheReadTokens)}, ${part('cache write', usage.cacheWriteTokens)}), $${usage.costUsd.toFixed(2)}`;
}

interface BulkTimeEntryResult {
  entries: TimeEntry[];
  warnings: Array<{ kind: string; date: string; message: string }>;
  lockedDates: string[];
  totalMinutes: number;
}

export const timerStartToolConfig = {
  title: 'Start a timer',
  description:
    'Start the user\'s stopwatch on a ticket. If a timer is already running on a different ticket, pass replace=true to auto-stop the previous one (its time is booked first). Description becomes the time entry\'s note when this timer eventually stops. Needs time:log on the ticket\'s project (403 errors.time.log_permission_required) and a ticket you can read (404).',
  inputSchema: z.object({
    ticketKey: z.string(),
    description: z.string().optional().describe('Entry note, set at start.'),
    replace: z.boolean().optional().describe('Commit a running timer first (default 409).'),
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
          { cause: err },
        );
      }
      throw err;
    }
  };
}

export const timerStopToolConfig = {
  title: 'Stop a timer',
  description:
    'Stop the user\'s stopwatch. The API commits a time_entries row using the description set at start (or pause/resume), then deletes the active-timer record. Returns the duration in minutes; bookingRefused: true means the timer ran but booked nothing because you can no longer read the ticket or lost time:log on its project. ticketKey: your timer on that ticket.',
  inputSchema: z.object({
    ticketKey: z.string().optional(),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
};

export function makeTimerStopHandler(client: OrbotoClient) {
  return async ({ ticketKey }: { ticketKey?: string } = {}): Promise<CallToolResult> => {
    const body: Record<string, unknown> = {};
    if (ticketKey) body.ticketId = (await resolveTicketByKey(client, ticketKey)).id;
    try {
      const res = await client.post<{ durationMinutes: number; stopped?: boolean; laneFallback?: boolean; bookingRefused?: boolean }>('/time/timer/stop', body);
      if (res.stopped === false) {
        return {
          content: [{ type: 'text', text: 'No active timer to stop.' }],
          structuredContent: { durationMinutes: 0, alreadyStopped: true },
        };
      }
      if (res.bookingRefused) {
        return {
          content: [{ type: 'text', text: 'Timer stopped - nothing booked: you can no longer read the ticket or lost time:log on its project.' }],
          structuredContent: { durationMinutes: 0, bookingRefused: true },
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
  title: 'Log a time entry',
  description:
    'Book time for work done without a timer. `loggedAt` defaults to now; pass an ISO datetime to back-date. Pass `dates` (YYYY-MM-DD list) to book the same entry on several days in one call (ORB-2056): all-or-nothing, a day inside an approved timesheet refuses the set and names the day, capacity warnings come back advisory.',
  inputSchema: z.object({
    ticketKey: z.string(),
    durationMinutes: z.number().int().positive(),
    description: z.string().optional(),
    loggedAt: isoDateTime().optional().describe('Default now. Ignored when `dates` is set.'),
    dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).min(1).max(200).optional().describe('Book on each of these days (YYYY-MM-DD).'),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().describe('Start for `dates`, workspace timezone. Default 09:00.'),
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
  title: 'List time entries',
  description:
    'List a ticket\'s time entries, newest first. Each carries its source; the answer adds the minutes per source, the running agent leases and the tokens and cost agents reported (not reported is not zero). Use this to FIND an over-tracked entry before fixing it with orboto_edit_time_entry / orboto_delete_time_entry.',
  inputSchema: z.object({
    ticketKey: z.string(),
    limit: z.number().int().positive().max(100).optional().describe('Default 25.'),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeListTimeEntriesHandler(client: OrbotoClient) {
  return async ({ ticketKey, limit }: { ticketKey: string; limit?: number }): Promise<CallToolResult> => {
    const ticket = await resolveTicketByKey(client, ticketKey);
    const page = await client.get<{ items: TimeEntry[]; nextCursor: string | null }>(`/tickets/${ticket.id}/time-entries?limit=${limit ?? 25}`);
    const agentTime = await client.get<TicketAgentTime>(`/tickets/${ticket.id}/agent-time`).catch(() => null);
    const lines = page.items.map((e) => {
      const agentMark = e.agentLabel ? ` [${e.agentLabel}]` : (e.isAgentWork ? ' [agent]' : '');
      const source = e.source ? ` (${e.source})` : '';
      return `- ${e.durationMinutes} min${source} - ${e.loggedAt}${agentMark}${e.description ? ` - ${e.description}` : ''} (id ${e.id})`;
    });
    const runningLeases = (agentTime?.leases ?? []).filter((l) => !l.endedAt).map((l) => ({
      agentLabel: l.agentLabel, userEmail: l.userEmail, startedAt: l.startedAt, accruedMinutes: l.accruedMinutes, usage: l.usage,
    }));
    const running = runningLeases.map((l) => `${l.agentLabel ?? l.userEmail} ${l.accruedMinutes} min so far`);
    const summary = agentTime ? [
      `${agentTime.minutes.total} min booked: lease ${agentTime.minutes.lease}, timer ${agentTime.minutes.timer}, manual ${agentTime.minutes.manual}, unrecorded ${agentTime.minutes.unrecorded}`,
      ...declaredNoneLine(agentTime.declaredNone),
      `Agent usage: ${usageLine(agentTime.usage)}`,
      ...(running.length ? [`Running agent leases: ${running.join(', ')}`] : []),
    ] : ['Agent time could not be read for this ticket.'];
    return {
      content: [{
        type: 'text',
        text: [page.items.length ? `Time entries on [${ticket.ticketKey}]:\n${lines.join('\n')}` : `No time entries on [${ticket.ticketKey}].`, ...summary].join('\n'),
      }],
      structuredContent: { ticketKey: ticket.ticketKey, entries: page.items, nextCursor: page.nextCursor, ...(agentTime ? { agentTime: { minutes: agentTime.minutes, declaredNone: agentTime.declaredNone, usage: agentTime.usage, runningLeases } } : {}) },
    };
  };
}

export const editTimeEntryToolConfig = {
  title: 'Edit / correct a time entry',
  description:
    'Correct a time entry: duration, note, date or ticket. Use THIS (not orboto_log_time) to fix a wrong entry: log_time is additive and only makes the total worse. Get the entryId from orboto_list_time_entries (or an orboto_log_time response). Blocked if the entry is locked by an approved timesheet.',
  inputSchema: z.object({
    ticketKey: z.string().describe('The entry\'s current ticket.'),
    entryId: z.guid(),
    durationMinutes: z.number().int().positive().optional(),
    description: z.string().nullish(),
    loggedAt: isoDateTime().optional(),
    moveToTicketKey: z.string().optional().describe('Move the entry to another ticket.'),
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
    'Delete a time entry. Use it for a bogus over-tracked entry that should not exist at all (prefer orboto_edit_time_entry when it should just have a different duration). You can delete your own; deleting another user\'s needs the `time:delete_others` permission. Blocked if locked by an approved timesheet. Get the entryId from orboto_list_time_entries.',
  inputSchema: z.object({
    ticketKey: z.string(),
    entryId: z.guid(),
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

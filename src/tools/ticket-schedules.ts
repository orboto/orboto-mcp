/**
 * ORB-626 - ticket meeting-schedule tools.
 *
 * Wrap the /tickets/:id/schedules endpoints:
 *   - orboto_list_ticket_schedules  - list a ticket's working sessions.
 *   - orboto_schedule_ticket_session - schedule a working session (drops a
 *     plan-block on every orboto attendee + sends an iCal invite).
 *   - orboto_cancel_ticket_session  - cancel a scheduled session (removes
 *     the plan-blocks + sends an iCal cancellation).
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';
import { resolveTicketByKey } from './shared.js';

interface ScheduleAttendee { userId: string; email: string }
interface TicketScheduleRow {
  id: string;
  ticketId: string;
  createdBy: string;
  title: string;
  startsAt: string;
  endsAt: string;
  location: string | null;
  notes: string | null;
  attendees: ScheduleAttendee[];
  externalAttendees: { email: string }[];
  sequence: number;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdByName?: string | null;
  ticketKey?: string | null;
}

function scheduleLine(s: TicketScheduleRow): string {
  const when = `${s.startsAt} -> ${s.endsAt}`;
  const people = s.attendees.length + s.externalAttendees.length;
  const state = s.cancelledAt ? ' [CANCELLED]' : '';
  return `- ${s.title}${state} - ${when} - ${people} attendee(s) (id ${s.id})`;
}

// ---------------------------------------------------------------------------
// orboto_list_ticket_schedules
// ---------------------------------------------------------------------------

export const listTicketSchedulesToolConfig = {
  title: 'List a ticket\'s scheduled working sessions',
  description:
    'List the meeting / working sessions scheduled on a ticket (by key). Active sessions only by default; pass includeCancelled=true for history. Returns each session\'s id, title, window and attendee count - get the id here before cancelling one with orboto_cancel_ticket_session.',
  inputSchema: z.object({
    ticketKey: z.string().min(3),
    includeCancelled: z.boolean().optional().describe('Include cancelled sessions (default: active only).'),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeListTicketSchedulesHandler(client: OrbotoClient) {
  return async ({ ticketKey, includeCancelled }: { ticketKey: string; includeCancelled?: boolean }): Promise<CallToolResult> => {
    const ticket = await resolveTicketByKey(client, ticketKey);
    const qs = includeCancelled ? '?includeCancelled=true' : '';
    const rows = await client.get<TicketScheduleRow[]>(`/tickets/${ticket.id}/schedules${qs}`);
    return {
      content: [{
        type: 'text',
        text: rows.length
          ? `Sessions on [${ticket.ticketKey}]:\n${rows.map(scheduleLine).join('\n')}`
          : `No scheduled sessions on [${ticket.ticketKey}].`,
      }],
      structuredContent: { ticketKey: ticket.ticketKey, schedules: rows },
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_schedule_ticket_session
// ---------------------------------------------------------------------------

export const scheduleTicketSessionToolConfig = {
  title: 'Schedule a working session on a ticket',
  description:
    'Schedule a working session ("scope review", "design crit") on a ticket. Drops a plan-block on every orboto attendee and emails each attendee an iCal invite. startsAt/endsAt are ISO 8601 datetimes. attendeeUserIds are orboto user UUIDs (from orboto_list_users); externalEmails are non-orboto guests who get the invite but no plan-block. Title defaults to "Working session: <TICKET-KEY>".',
  inputSchema: z.object({
    ticketKey: z.string().min(3),
    startsAt: z.string().datetime().describe('ISO 8601 start datetime.'),
    endsAt: z.string().datetime().describe('ISO 8601 end datetime (must be after startsAt).'),
    title: z.string().optional(),
    location: z.string().optional().describe('Free text - Zoom URL, room name, "remote".'),
    notes: z.string().optional(),
    attendeeUserIds: z.array(z.string().uuid()).optional().describe('orboto attendee user UUIDs.'),
    externalEmails: z.array(z.string().email()).optional().describe('External (non-orboto) guest emails.'),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};

export function makeScheduleTicketSessionHandler(client: OrbotoClient) {
  return async (args: {
    ticketKey: string; startsAt: string; endsAt: string; title?: string; location?: string; notes?: string;
    attendeeUserIds?: string[]; externalEmails?: string[];
  }): Promise<CallToolResult> => {
    const ticket = await resolveTicketByKey(client, args.ticketKey);
    const body: Record<string, unknown> = {
      startsAt: args.startsAt,
      endsAt: args.endsAt,
      attendeeUserIds: args.attendeeUserIds ?? [],
      externalEmails: args.externalEmails ?? [],
    };
    if (args.title !== undefined) body.title = args.title;
    if (args.location !== undefined) body.location = args.location;
    if (args.notes !== undefined) body.notes = args.notes;
    const row = await client.post<TicketScheduleRow>(`/tickets/${ticket.id}/schedules`, body);
    const people = row.attendees.length + row.externalAttendees.length;
    return {
      content: [{
        type: 'text',
        text: `Scheduled "${row.title}" on [${ticket.ticketKey}] (${row.startsAt} -> ${row.endsAt}) - ${people} attendee(s) invited. (id ${row.id})`,
      }],
      structuredContent: { ticketKey: ticket.ticketKey, scheduleId: row.id, schedule: row },
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_cancel_ticket_session
// ---------------------------------------------------------------------------

export const cancelTicketSessionToolConfig = {
  title: 'Cancel a scheduled working session',
  description:
    'Cancel a working session on a ticket. Removes every attendee\'s plan-block and emails an iCal cancellation to all attendees. Get the scheduleId from orboto_list_ticket_schedules.',
  inputSchema: z.object({
    ticketKey: z.string().min(3),
    scheduleId: z.string().uuid(),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
};

export function makeCancelTicketSessionHandler(client: OrbotoClient) {
  return async ({ ticketKey, scheduleId }: { ticketKey: string; scheduleId: string }): Promise<CallToolResult> => {
    const ticket = await resolveTicketByKey(client, ticketKey);
    const row = await client.delete<TicketScheduleRow>(`/tickets/${ticket.id}/schedules/${scheduleId}`);
    return {
      content: [{ type: 'text', text: `Cancelled session "${row.title}" on [${ticket.ticketKey}]. Attendees notified.` }],
      structuredContent: { ticketKey: ticket.ticketKey, scheduleId, cancelled: true },
    };
  };
}

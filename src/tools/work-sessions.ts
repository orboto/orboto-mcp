/**
 * ORB-1609 - work-session tools.
 *
 * A work session is the transactional record behind "I am working on
 * this ticket": it holds the lease, owns the timer, drives presence,
 * and carries the finish-time evidence (commit + verification). It is
 * the primitive `orboto work start / finish / next` (wave 3) is built
 * on, and it is what makes ownership visible ACROSS accounts - a lease
 * held by another team's bot is a 409 with the holder attached, not an
 * invisible collision discovered at push time.
 *
 * The three roles that are not `implementation` deliberately do NOT
 * reassign the ticket or move its status: a review / preflight /
 * integration session attaches to a ticket without pretending to own
 * its delivery. That is what makes one-ticket-one-commit workable for
 * work that produces no commit of its own.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OrbotoApiError, type OrbotoClient } from '../orboto-client.js';
import { mcpInstanceToken, resolveTicketByKey } from './shared.js';

interface WorkSessionRow {
  id: string;
  ticketId: string;
  role: string;
  status: string;
  startedAt: string;
  leaseUntil: string;
  activeTimerId: string | null;
  commitSha: string | null;
  ticketKey?: string | null;
  ticketTitle?: string | null;
  projectKey?: string | null;
  userEmail?: string | null;
  userFullName?: string | null;
}

interface LeaseHolder {
  sessionId: string;
  userEmail: string | null;
  userFullName: string | null;
  role: string;
  startedAt: string;
  leaseUntil: string;
}

function describe(s: WorkSessionRow): string {
  const key = s.ticketKey ?? s.ticketId.slice(0, 8);
  const who = s.userFullName ?? s.userEmail ?? 'unknown';
  return `  - ${key} [${s.role}] ${who} - lease until ${s.leaseUntil}${s.commitSha ? ` (commit ${s.commitSha.slice(0, 8)})` : ''}`;
}

// ---------------------------------------------------------------------------
// orboto_work_session_start
// ---------------------------------------------------------------------------

export const workSessionStartToolConfig = {
  title: 'Start (or renew) a work session on a ticket',
  description:
    'Take the work lease on a ticket in a given role and start its timer. This is the coordination primitive: exactly ONE active session per (ticket, role) exists workspace-wide, so a second agent attempting the same role gets a conflict naming the current holder instead of silently colliding. Re-calling with the same agent instance renews your own lease and is a no-op otherwise - safe to call defensively. Roles other than `implementation` (review / preflight / integration) attach to the ticket WITHOUT reassigning it or moving its status, so a reviewing agent no longer has to fake a claim. The lease expires on its own (default 15 min, renewed automatically by your subsequent calls), so a crashed agent never wedges a ticket. Pass `takeover: true` only when you have decided to displace the current holder - their session is closed and their time booked, and the takeover is visible in history.',
  inputSchema: z.object({
    ticketKey: z.string().min(3).describe('Ticket key like "ACME-42".'),
    role: z.enum(['implementation', 'review', 'preflight', 'integration']).optional()
      .describe('Default `implementation`. Use `review` for a review pass, `preflight` for a pre-work check, `integration` for merge/release work - those attach without reassigning the ticket.'),
    leaseSeconds: z.number().int().min(60).max(86_400).optional()
      .describe('How long the lease should hold without renewal. Default 900 (15 min).'),
    takeover: z.boolean().optional()
      .describe('Displace the current holder of this (ticket, role) lease. Their session is cancelled and their tracked time booked.'),
    startTimer: z.boolean().optional()
      .describe('Defaults to true for `implementation`, false for the attach-only roles.'),
    agentSessionToken: z.string().optional()
      .describe('Stable per-agent-instance token. Omit to use this MCP connection\'s own instance id.'),
  }).shape,
};

export function makeWorkSessionStartHandler(client: OrbotoClient) {
  return async (
    args: {
      ticketKey: string;
      role?: string;
      leaseSeconds?: number;
      takeover?: boolean;
      startTimer?: boolean;
      agentSessionToken?: string;
    },
    extra?: { sessionId?: string },
  ): Promise<CallToolResult> => {
    const ticket = await resolveTicketByKey(client, args.ticketKey);
    const token = mcpInstanceToken(args.agentSessionToken, extra);
    try {
      const res = await client.post<{ session: WorkSessionRow; reused: boolean; displaced?: LeaseHolder }>(
        '/work-sessions',
        {
          ticketId: ticket.id,
          ...(args.role ? { role: args.role } : {}),
          ...(args.leaseSeconds ? { leaseSeconds: args.leaseSeconds } : {}),
          ...(args.takeover ? { takeover: true } : {}),
          ...(args.startTimer !== undefined ? { startTimer: args.startTimer } : {}),
          agentSessionToken: token,
        },
      );
      const lines = [
        res.reused
          ? `Renewed your existing ${res.session.role} session on ${args.ticketKey}.`
          : `Started a ${res.session.role} work session on ${args.ticketKey}.`,
        `Session id: ${res.session.id} (pass this to orboto_work_session_finish).`,
        `Lease held until ${res.session.leaseUntil}; it renews automatically while you keep calling orboto.`,
        res.session.activeTimerId ? 'Timer running.' : 'No timer started for this role.',
      ];
      if (res.displaced) {
        lines.push(
          `Displaced ${res.displaced.userFullName ?? res.displaced.userEmail ?? 'the previous holder'} (session ${res.displaced.sessionId}); their tracked time was booked.`,
        );
      }
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: { session: res.session, reused: res.reused, displaced: res.displaced ?? null },
      };
    } catch (err) {
      if (err instanceof OrbotoApiError && err.status === 409) {
        // OrbotoApiError carries the raw body string; the 409 payload is the
        // standard i18n error triple plus `holder`, which is the whole point
        // of the conflict response - the caller must not need a second call
        // to learn who has the ticket.
        let holder: LeaseHolder | undefined;
        try {
          holder = (JSON.parse(err.body) as { holder?: LeaseHolder }).holder;
        } catch {
          holder = undefined;
        }
        const who = holder ? (holder.userFullName ?? holder.userEmail ?? holder.sessionId) : 'another agent';
        const until = holder ? holder.leaseUntil : 'unknown';
        return {
          content: [{
            type: 'text',
            text:
              `The ${args.role ?? 'implementation'} lease on ${args.ticketKey} is held by ${who} until ${until}.\n` +
              'Pick a different ticket, attach in another role (e.g. role="review"), wait for the lease to expire, ' +
              'or re-run with takeover=true if you have decided to displace them.',
          }],
          structuredContent: { conflict: true, holder: holder ?? null },
          isError: true,
        };
      }
      throw err;
    }
  };
}

// ---------------------------------------------------------------------------
// orboto_work_session_finish
// ---------------------------------------------------------------------------

export const workSessionFinishToolConfig = {
  title: 'Finish a work session (books time, frees the lease, records evidence)',
  description:
    'End a work session: its timer is stopped and booked, the (ticket, role) lease is released for the next agent, and the evidence you pass (commit sha + which gates you ran) is recorded on the session. Idempotent - finishing an already-finished session succeeds and still absorbs late evidence, so a retrying harness never has to distinguish "already done" from "failed". This does NOT close the ticket; ticket status is a separate, deliberate decision (use orboto_close_ticket once the acceptance criteria are verified).',
  inputSchema: z.object({
    sessionId: z.string().uuid().describe('The id returned by orboto_work_session_start.'),
    outcome: z.enum(['finished', 'cancelled']).optional()
      .describe('`finished` (default) = the work completed. `cancelled` = abandoned attempt; time is still booked, history stays honest.'),
    commitSha: z.string().optional().describe('The commit this session produced, when it produced one.'),
    verification: z.object({
      build: z.boolean().optional(),
      tests: z.boolean().optional(),
      lint: z.boolean().optional(),
      notes: z.string().optional(),
    }).optional().describe('Which gates you actually ran and what they said. This is the attestation a reviewer reads cold.'),
  }).shape,
};

export function makeWorkSessionFinishHandler(client: OrbotoClient) {
  return async (args: {
    sessionId: string;
    outcome?: 'finished' | 'cancelled';
    commitSha?: string;
    verification?: Record<string, unknown>;
  }): Promise<CallToolResult> => {
    const res = await client.post<{ session: WorkSessionRow; durationMinutes: number; changed: boolean }>(
      `/work-sessions/${args.sessionId}/finish`,
      {
        ...(args.outcome ? { outcome: args.outcome } : {}),
        ...(args.commitSha ? { commitSha: args.commitSha } : {}),
        ...(args.verification ? { verification: args.verification } : {}),
      },
    );
    const text = res.changed
      ? `Session ${args.sessionId} ${res.session.status}. Booked ${res.durationMinutes} min; the ${res.session.role} lease on ${res.session.ticketKey ?? res.session.ticketId} is free.`
      : `Session ${args.sessionId} was already ${res.session.status} - nothing to book. (Idempotent finish.)`;
    return {
      content: [{ type: 'text', text }],
      structuredContent: { session: res.session, durationMinutes: res.durationMinutes, changed: res.changed },
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_work_sessions
// ---------------------------------------------------------------------------

export const workSessionsToolConfig = {
  title: 'List live work sessions (who is working on what)',
  description:
    'The coordination view: every live work lease you can see, or the sessions on one ticket. Call this BEFORE picking up work in a fleet - a ticket with a live `implementation` lease is already being worked, and starting on it anyway is how two agents produce conflicting commits. Unlike agent presence (which reports who is online), this reports who OWNS what, across accounts.',
  inputSchema: z.object({
    ticketKey: z.string().optional().describe('Scope to one ticket. Omit to list every live session you can see.'),
    scope: z.enum(['mine', 'all']).optional().describe('`mine` = only my own sessions. Default `all`. Ignored when ticketKey is set.'),
    includeClosed: z.boolean().optional().describe('With ticketKey: also show finished/expired sessions (the ticket\'s work history).'),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeWorkSessionsHandler(client: OrbotoClient) {
  return async (args: { ticketKey?: string; scope?: 'mine' | 'all'; includeClosed?: boolean }): Promise<CallToolResult> => {
    let rows: WorkSessionRow[];
    let heading: string;
    if (args.ticketKey) {
      const ticket = await resolveTicketByKey(client, args.ticketKey);
      const qs = args.includeClosed ? '?includeClosed=true' : '';
      rows = await client.get<WorkSessionRow[]>(`/tickets/${ticket.id}/work-sessions${qs}`);
      heading = `Work sessions on ${args.ticketKey}`;
    } else if (args.scope === 'mine') {
      rows = await client.get<WorkSessionRow[]>('/work-sessions/mine');
      heading = 'My live work sessions';
    } else {
      rows = await client.get<WorkSessionRow[]>('/work-sessions/active');
      heading = 'Live work sessions';
    }
    const text = rows.length === 0
      ? `${heading}: none.`
      : [`${heading} (${rows.length}):`, ...rows.map(describe)].join('\n');
    return { content: [{ type: 'text', text }], structuredContent: { sessions: rows } };
  };
}

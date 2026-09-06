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
import {
  GIT_HEALTH_REASON_TEXT,
  ResourceClaimShape,
  type ClaimConflict,
  type LeaseHolder,
  type QueuedClaimResult,
  type StartBundleResponse,
  type StartDependencyEdge,
  type WorkSessionRow,
} from './work-sessions-shared.js';

function parseClaimConflicts(err: OrbotoApiError): ClaimConflict[] | undefined {
  try {
    return (JSON.parse(err.body) as { claimConflicts?: ClaimConflict[] }).claimConflicts;
  } catch {
    return undefined;
  }
}

function describeClaimConflicts(conflicts: ClaimConflict[]): string {
  return conflicts
    .map((c) => {
      const who = c.holders
        .map((h) => `${h.userFullName ?? h.userEmail ?? h.sessionId} on ${h.ticketKey ?? '(unknown ticket)'}`)
        .join(', ');
      return `  - ${c.claim.kind}:${c.claim.value} (${c.claim.mode}) blocked by ${who || 'an active writer'}`;
    })
    .join('\n');
}

function describe(s: WorkSessionRow): string {
  const key = s.ticketKey ?? s.ticketId.slice(0, 8);
  const who = s.userFullName ?? s.userEmail ?? 'unknown';
  return `  - ${key} [${s.role}] ${who} - lease until ${s.leaseUntil}${s.commitSha ? ` (commit ${s.commitSha.slice(0, 8)})` : ''}`;
}

// ---------------------------------------------------------------------------
// orboto_work_start - ORB-1611
// ---------------------------------------------------------------------------

// Mirrors apps/mcp/src/tools/session-start.ts's local shapes - kept
// duplicated rather than imported, same choice that file already made for
// its own bundle types (no shared MCP-side schema layer for these).
export const workStartToolConfig = {
  title: 'Start a work session and load the full context bundle',
  description:
    'ORB-1611 - the one-call ticket pickup. Acquires the (ticket, role) work lease with the exact same guarantees as orboto_work_session_start (exactly ONE active session per ticket+role workspace-wide, a conflict names the holder, resourceClaims apply atomically with the lease), AND in the SAME response returns the rules-hash ack (same semantics as orboto_session_start), the project primer, the ticket enriched with its description/status/priority, its checklists, its dependencies, that project\'s git connection health, and any other live sessions already on the ticket. This replaces the 8-15 separate calls (orboto_session_start, orboto_get_project_primer, orboto_get_ticket, orboto_get_checklists, orboto_list_ticket_dependencies, ...) a normal ticket pickup used to cost. Prefer this over orboto_work_session_start for picking up a ticket; use the plain tool only when you deliberately do not want the bundle (e.g. a mid-task lease renewal where you already have fresh context). A conflict never leaves a partial session behind - same rollback-on-conflict guarantee as orboto_work_session_start.',
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
    resourceClaims: z.array(z.object(ResourceClaimShape)).max(50).optional()
      .describe('ORB-1610 - resource claims to acquire alongside the lease. Same semantics as orboto_work_session_start\'s resourceClaims.'),
    onConflict: z.enum(['reject', 'queue']).optional()
      .describe('Only matters when `resourceClaims` is set. Default `reject`.'),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
};

export function makeWorkStartHandler(client: OrbotoClient) {
  // Per-connection rules-hash cache, mirrored from session-start.ts's
  // makeSessionStartHandler - this closure lives for one MCP connection.
  let lastKnownRulesHash: string | undefined;

  return async (
    args: {
      ticketKey: string;
      role?: string;
      leaseSeconds?: number;
      takeover?: boolean;
      startTimer?: boolean;
      agentSessionToken?: string;
      resourceClaims?: Array<{ kind: 'path' | 'named'; value: string; mode: 'read' | 'write' }>;
      onConflict?: 'reject' | 'queue';
    },
    extra?: { sessionId?: string },
  ): Promise<CallToolResult> => {
    const token = mcpInstanceToken(args.agentSessionToken, extra);
    let ticketId: string;
    try {
      ticketId = (await resolveTicketByKey(client, args.ticketKey)).id;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: message }], isError: true };
    }
    try {
      const res = await client.post<StartBundleResponse>(
        '/work-sessions/start',
        {
          ticketId,
          ...(args.role ? { role: args.role } : {}),
          ...(args.leaseSeconds ? { leaseSeconds: args.leaseSeconds } : {}),
          ...(args.takeover ? { takeover: true } : {}),
          ...(args.startTimer !== undefined ? { startTimer: args.startTimer } : {}),
          ...(args.resourceClaims && args.resourceClaims.length > 0 ? { resourceClaims: args.resourceClaims } : {}),
          ...(args.onConflict ? { onConflict: args.onConflict } : {}),
          agentSessionToken: token,
          ...(lastKnownRulesHash ? { knownRulesHash: lastKnownRulesHash } : {}),
        },
      );
      if (res.rulesHash) lastKnownRulesHash = res.rulesHash;

      const lines: string[] = [
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
      if (res.queued && res.queued.length > 0) {
        lines.push(
          'Queued (waiting for a conflicting writer to release):',
          ...res.queued.map((q) => `  - ${q.claim.kind}:${q.claim.value} - position ${q.position}`),
        );
      }

      lines.push('', '## Working rules');
      if (res.rulesUnchanged) {
        lines.push(`Unchanged since your last work-start on this connection (hash ${res.rulesHash}) - keep following what you already loaded.`);
      } else {
        lines.push(res.rules?.trim() || '(no workspace rules configured)');
      }

      lines.push('', '## Project primer');
      lines.push(res.primer.markdown.trim() || '(primer unavailable)');

      lines.push('', `## Ticket: ${res.ticket.ticketKey ?? args.ticketKey}`);
      lines.push(res.ticket.title);
      lines.push(`Status: ${res.ticket.statusName ?? res.ticket.status}  Priority: ${res.ticket.priority}  Type: ${res.ticket.type}`);
      if (res.ticket.description) lines.push('', res.ticket.description);

      lines.push('', '## Checklists');
      if (res.checklists.length === 0) {
        lines.push('(none)');
      } else {
        for (const cl of res.checklists) {
          lines.push(`${cl.title} (${cl.progress.done}/${cl.progress.total})${cl.triggersDone ? ' - triggers done' : ''}`);
          for (const i of cl.items) {
            const link = i.linkedTicketKey ? ` -> [${i.linkedTicketKey}] (${i.linkedTicketStatusCategory ?? 'unknown'})` : '';
            lines.push(`- [${i.effectiveCompleted ? 'x' : ' '}] ${i.content}${link}`);
          }
        }
      }

      // ORB-1614 - a cross-project blocker/dependent the caller cannot read
      // comes back with `title: null` - render a fixed placeholder instead
      // of the literal "null".
      const fmtDeps = (edges: StartDependencyEdge[]) =>
        edges.length === 0 ? '(none)' : edges.map((e) => `- [${e.ticketKey ?? '?'}] ${e.title ?? `External dependency (access restricted)${e.resolved ? ' - resolved' : ' - still open'}`}${e.statusName ? ` - ${e.statusName}` : ''}`).join('\n');
      lines.push('', '## Dependencies');
      lines.push('Blocked by:', fmtDeps(res.dependencies.blockedBy), 'Blocks:', fmtDeps(res.dependencies.blocks));

      const unhealthy = res.gitHealth.filter((c) => !c.healthy);
      if (unhealthy.length > 0) {
        lines.push('', '## Git connection health - WARNING');
        for (const c of unhealthy) {
          lines.push(`- "${c.name}" (${c.provider}) - ${GIT_HEALTH_REASON_TEXT[c.reason ?? ''] ?? c.reason ?? 'unknown reason'}`);
        }
      }

      lines.push('', '## Other sessions on this ticket');
      lines.push(
        res.siblingSessions.length === 0
          ? '(none)'
          : res.siblingSessions.map((s) => `  - [${s.role}] ${s.userFullName ?? s.userEmail ?? 'unknown'} - lease until ${s.leaseUntil}`).join('\n'),
      );

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: {
          session: res.session,
          reused: res.reused,
          displaced: res.displaced ?? null,
          queued: res.queued ?? [],
          rulesHash: res.rulesHash,
          rulesUnchanged: res.rulesUnchanged,
          primer: res.primer,
          ticket: res.ticket,
          checklists: res.checklists,
          dependencies: res.dependencies,
          gitHealth: res.gitHealth,
          siblingSessions: res.siblingSessions,
        },
      };
    } catch (err) {
      if (err instanceof OrbotoApiError && err.status === 409) {
        const claimConflicts = parseClaimConflicts(err);
        if (claimConflicts && claimConflicts.length > 0) {
          return {
            content: [{
              type: 'text',
              text:
                `One or more resource claims for ${args.ticketKey} conflict with an active writer:\n` +
                `${describeClaimConflicts(claimConflicts)}\n` +
                'Re-run with onConflict="queue" to wait instead of failing, or narrow the glob.',
            }],
            structuredContent: { claimConflict: true, claimConflicts },
            isError: true,
          };
        }
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
    resourceClaims: z.array(z.object(ResourceClaimShape)).max(50).optional()
      .describe('ORB-1610 - resource claims to acquire alongside the lease. `kind: "path"` takes a glob relative to the repo root (`src/**`, `apps/api/src/routes/tickets.ts`); `kind: "named"` takes an opaque exclusive-resource id (`unity-editor:main`, `git-push:orboto#develop`), compared by exact string equality. `mode: "write"` conflicts with any OVERLAPPING active write claim workspace-wide (across tickets and accounts) - editor refresh clobbering uncommitted changes and concurrent pushes staging each other\'s files are exactly what this prevents. `mode: "read"` never conflicts with anything, including another read.'),
    onConflict: z.enum(['reject', 'queue']).optional()
      .describe('Only matters when `resourceClaims` is set. Default `reject`: a conflicting write claim fails the WHOLE call with the conflicting holder(s) named - if this call would have created a brand-new session, that session is rolled back rather than left holding the lease without its claims. `queue`: the conflicting claim is accepted as `state: "waiting"` instead of failing; it is promoted automatically once the conflict clears (release, finish, or the next orboto_work_sessions read).'),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
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
      resourceClaims?: Array<{ kind: 'path' | 'named'; value: string; mode: 'read' | 'write' }>;
      onConflict?: 'reject' | 'queue';
    },
    extra?: { sessionId?: string },
  ): Promise<CallToolResult> => {
    const ticket = await resolveTicketByKey(client, args.ticketKey);
    const token = mcpInstanceToken(args.agentSessionToken, extra);
    try {
      const res = await client.post<{
        session: WorkSessionRow;
        reused: boolean;
        displaced?: LeaseHolder;
        queued?: QueuedClaimResult[];
      }>(
        '/work-sessions',
        {
          ticketId: ticket.id,
          ...(args.role ? { role: args.role } : {}),
          ...(args.leaseSeconds ? { leaseSeconds: args.leaseSeconds } : {}),
          ...(args.takeover ? { takeover: true } : {}),
          ...(args.startTimer !== undefined ? { startTimer: args.startTimer } : {}),
          ...(args.resourceClaims && args.resourceClaims.length > 0 ? { resourceClaims: args.resourceClaims } : {}),
          ...(args.onConflict ? { onConflict: args.onConflict } : {}),
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
      if (res.queued && res.queued.length > 0) {
        lines.push(
          'Queued (waiting for a conflicting writer to release):',
          ...res.queued.map((q) => `  - ${q.claim.kind}:${q.claim.value} - position ${q.position}`),
        );
      }
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: { session: res.session, reused: res.reused, displaced: res.displaced ?? null, queued: res.queued ?? [] },
      };
    } catch (err) {
      if (err instanceof OrbotoApiError && err.status === 409) {
        const claimConflicts = parseClaimConflicts(err);
        if (claimConflicts && claimConflicts.length > 0) {
          // ORB-1610 - a resourceClaims conflict, distinct from the lease
          // conflict below: the body carries `claimConflicts`, not `holder`.
          return {
            content: [{
              type: 'text',
              text:
                `One or more resource claims for ${args.ticketKey} conflict with an active writer:\n` +
                `${describeClaimConflicts(claimConflicts)}\n` +
                'Re-run with onConflict="queue" to wait instead of failing, or narrow the glob.',
            }],
            structuredContent: { claimConflict: true, claimConflicts },
            isError: true,
          };
        }
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
  title: 'Finish a work session (books time, frees the lease)',
  description:
    'End a work session: its timer is stopped and booked, the (ticket, role) lease is released for the next agent, and the evidence you pass (commit sha + which gates you ran) is recorded on the session. Idempotent - finishing an already-finished session succeeds and still absorbs late evidence, so a retrying harness never has to distinguish "already done" from "failed". This does NOT close the ticket; ticket status is a separate, deliberate decision (use orboto_close_ticket once the acceptance criteria are verified). Prefer orboto_work_finish (ORB-1612) for an `implementation` session that is actually done - it does this AND the ticket transition AND the completion note in one call.',
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
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
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
// orboto_work_finish - ORB-1612
// ---------------------------------------------------------------------------

interface FinishWorkResponse {
  session: WorkSessionRow;
  durationMinutes: number;
  changed: boolean;
  ticketTransitioned: boolean;
  ticketStatusCategory: string | null;
  deliveryModeWarning?: { code: string; message: string };
  noteCommented: boolean;
}

export const workFinishToolConfig = {
  title: 'Finish a work session AND close out the ticket in one call',
  description:
    'ORB-1612 - the one-call ticket exit, sibling of orboto_work_start on the entry side. Does everything orboto_work_session_finish does (stops and books the session\'s EXACT timer, releases the lease and every resource claim, idles your presence) PLUS: records a commitSha as an ATTESTATION when git ingestion has not seen it yet (never blocks - verification reconciles asynchronously once the webhook/backfill lands, so a lagging git connection can never wedge a ticket in review for hours), transitions the ticket per the ORB-1608 deliveryMode policy, and posts the completion note. Only an `implementation`-role session with outcome `finished` drives the ticket (default target category `done`) - `review`/`preflight`/`integration` sessions attach without reassigning the ticket (ORB-1609) and a `cancelled` outcome never auto-closes a ticket nobody actually finished; both still book time and free the lease. Idempotent: finishing an already-finished session, or one whose ticket is already at the target category, is a no-op result - not an error. A blocked transition (approval gate, dependency blocker, missing permission) is non-fatal: the session still finished, `ticketTransitioned` comes back false, and the ticket is left for a human or a follow-up call.',
  inputSchema: z.object({
    sessionId: z.string().uuid().describe('The id returned by orboto_work_start / orboto_work_session_start.'),
    outcome: z.enum(['finished', 'cancelled']).optional()
      .describe('`finished` (default) drives the ticket transition below. `cancelled` = abandoned attempt; time is still booked, the ticket is left untouched.'),
    commitSha: z.string().optional().describe('The commit this session produced. Recorded as an attestation immediately, verified asynchronously once git ingestion catches up - never blocks this call.'),
    verification: z.object({
      build: z.boolean().optional(),
      tests: z.boolean().optional(),
      lint: z.boolean().optional(),
      notes: z.string().optional(),
    }).optional().describe('Which gates you actually ran and what they said. This is the attestation a reviewer reads cold.'),
    targetCategory: z.enum(['todo', 'in_progress', 'in_review', 'done', 'wont_fix']).optional()
      .describe('Default `done`. Use `in_review` when a human should look at it first. Only applied for an implementation session with outcome `finished`.'),
    note: z.string().optional().describe('The completion note posted on the ticket. Auto-generated (booked time + commit + verification summary) when omitted.'),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
};

export function makeWorkFinishHandler(client: OrbotoClient) {
  return async (args: {
    sessionId: string;
    outcome?: 'finished' | 'cancelled';
    commitSha?: string;
    verification?: Record<string, unknown>;
    targetCategory?: string;
    note?: string;
  }): Promise<CallToolResult> => {
    const res = await client.post<FinishWorkResponse>(
      `/work-sessions/${args.sessionId}/finish-work`,
      {
        ...(args.outcome ? { outcome: args.outcome } : {}),
        ...(args.commitSha ? { commitSha: args.commitSha } : {}),
        ...(args.verification ? { verification: args.verification } : {}),
        ...(args.targetCategory ? { targetCategory: args.targetCategory } : {}),
        ...(args.note ? { note: args.note } : {}),
      },
    );
    const lines = [
      res.changed
        ? `Session ${args.sessionId} ${res.session.status}. Booked ${res.durationMinutes} min; the ${res.session.role} lease on ${res.session.ticketKey ?? res.session.ticketId} is free.`
        : `Session ${args.sessionId} was already ${res.session.status} - nothing to book. (Idempotent finish.)`,
    ];
    if (res.session.commitSha) {
      lines.push(`Commit ${res.session.commitSha}${res.session.commitVerified ? ' (verified by git ingestion)' : ' (attested - pending git verification)'}.`);
    }
    lines.push(
      res.ticketTransitioned
        ? `Ticket moved to ${res.ticketStatusCategory}.`
        : `Ticket left at ${res.ticketStatusCategory ?? 'its current status'} - not transitioned this call.`,
    );
    if (res.deliveryModeWarning) lines.push(`⚠ ${res.deliveryModeWarning.message}`);
    lines.push(res.noteCommented ? 'Completion note posted.' : 'No completion note posted (nothing new to report).');
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: {
        session: res.session,
        durationMinutes: res.durationMinutes,
        changed: res.changed,
        ticketTransitioned: res.ticketTransitioned,
        ticketStatusCategory: res.ticketStatusCategory,
        deliveryModeWarning: res.deliveryModeWarning ?? null,
        noteCommented: res.noteCommented,
      },
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

// ---------------------------------------------------------------------------
// orboto_work_session_claims_add
// ---------------------------------------------------------------------------

export const workSessionClaimsAddToolConfig = {
  title: 'Add resource claims to a live work session',
  description:
    'ORB-1610 - declare more resource claims on a session you already hold (from orboto_work_session_start), without touching the ticket lease or timer. Use this when you did not know the files/resources you would touch at start time, or need to widen scope mid-task. Same conflict rule as start: `write` claims conflict with any OVERLAPPING active write claim workspace-wide; `read` claims never conflict. Default `onConflict: "reject"` fails the WHOLE call (nothing is added) and names every conflicting holder; `queue` accepts the conflicting ones as `state: "waiting"`.',
  inputSchema: z.object({
    sessionId: z.string().uuid().describe('The id returned by orboto_work_session_start.'),
    claims: z.array(z.object(ResourceClaimShape)).min(1).max(50)
      .describe('Claims to add. `kind: "path"` = glob relative to the repo root. `kind: "named"` = exact-match exclusive resource id.'),
    onConflict: z.enum(['reject', 'queue']).optional().describe('Default `reject`.'),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
};

export function makeWorkSessionClaimsAddHandler(client: OrbotoClient) {
  return async (args: {
    sessionId: string;
    claims: Array<{ kind: 'path' | 'named'; value: string; mode: 'read' | 'write' }>;
    onConflict?: 'reject' | 'queue';
  }): Promise<CallToolResult> => {
    try {
      const res = await client.post<{ session: WorkSessionRow; queued: QueuedClaimResult[] }>(
        `/work-sessions/${args.sessionId}/claims`,
        { claims: args.claims, ...(args.onConflict ? { onConflict: args.onConflict } : {}) },
      );
      const granted = (res.session.resourceClaims ?? []).filter((c) => c.state !== 'waiting');
      const lines = [`Session ${args.sessionId} now holds ${granted.length} granted claim(s).`];
      if (res.queued.length > 0) {
        lines.push(
          'Queued (waiting for a conflicting writer to release):',
          ...res.queued.map((q) => `  - ${q.claim.kind}:${q.claim.value} - position ${q.position}`),
        );
      }
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: { session: res.session, queued: res.queued },
      };
    } catch (err) {
      if (err instanceof OrbotoApiError && err.status === 409) {
        const claimConflicts = parseClaimConflicts(err);
        if (claimConflicts && claimConflicts.length > 0) {
          return {
            content: [{
              type: 'text',
              text:
                `No claims were added to session ${args.sessionId} - one or more conflict with an active writer:\n` +
                `${describeClaimConflicts(claimConflicts)}\n` +
                'Re-run with onConflict="queue" to wait instead of failing, or narrow the glob.',
            }],
            structuredContent: { claimConflict: true, claimConflicts },
            isError: true,
          };
        }
      }
      throw err;
    }
  };
}

// ---------------------------------------------------------------------------
// orboto_work_session_claims_release
// ---------------------------------------------------------------------------

export const workSessionClaimsReleaseToolConfig = {
  title: 'Release resource claims from a live work session',
  description:
    'ORB-1610 - drop specific resource claims (or all of them) from a session you hold, WITHOUT finishing the session or touching the ticket lease/timer. Releasing a granted write claim immediately runs a grant pass, so the earliest queued waiter for that resource is promoted as part of this call - useful once you know you are done touching a subtree but are not done with the ticket. Omit `claims` to release everything the session holds.',
  inputSchema: z.object({
    sessionId: z.string().uuid().describe('The id returned by orboto_work_session_start.'),
    claims: z.array(z.object({ kind: z.enum(['path', 'named']), value: z.string().min(1).max(500) })).optional()
      .describe('Which claims to release, matched by kind+value. Omit to release ALL claims on this session.'),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
};

export function makeWorkSessionClaimsReleaseHandler(client: OrbotoClient) {
  return async (args: {
    sessionId: string;
    claims?: Array<{ kind: 'path' | 'named'; value: string }>;
  }): Promise<CallToolResult> => {
    const session = await client.delete<WorkSessionRow>(
      `/work-sessions/${args.sessionId}/claims`,
      { ...(args.claims && args.claims.length > 0 ? { claims: args.claims } : {}) },
    );
    const remaining = session.resourceClaims ?? [];
    const text = args.claims && args.claims.length > 0
      ? `Released ${args.claims.length} claim(s) from session ${args.sessionId}. ${remaining.length} claim(s) remain.`
      : `Released every claim on session ${args.sessionId}.`;
    return {
      content: [{ type: 'text', text }],
      structuredContent: { session },
    };
  };
}

/**
 * ORB-1613 - `orboto_work_next`, the pull side of low-management dispatch
 * (Wave 3 of ORB-1602), in its own module since ORB-1930 added the peek.
 * The shapes it shares with `orboto_work_start` live in
 * work-sessions-shared.ts.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';
import { mcpInstanceToken } from './shared.js';
import { GIT_HEALTH_REASON_TEXT, ResourceClaimShape, type StartBundleResponse, type StartDependencyEdge } from './work-sessions-shared.js';

// ---------------------------------------------------------------------------
// orboto_work_next - ORB-1613 (Wave 3 of ORB-1602)
// ---------------------------------------------------------------------------

// ORB-1799 - your own tickets in this project that are still in_progress
// with a landed commit and no activity for N working days.
interface LandedIdleHint {
  ticketId: string;
  ticketKey: string | null;
  title: string;
  idleWorkingDays: number;
  lastActivityAt: string;
  commitCount: number;
}

interface NextWorkResponse {
  reserved: StartBundleResponse | null;
  reason: 'all-blocked' | 'all-leased' | 'none-matching' | 'autonomy_paused' | 'lane_paused' | 'lane_limit_reached' | null;
  /** ORB-1930 - set only on a `peek: true` call that found work. */
  candidate?: { ticketId: string; ticketKey: string | null; title: string; priority: string | null } | null;
  retryAfterSeconds: number | null;
  earliestFreeAt: string | null;
  candidatesConsidered: number;
  landedIdle?: LandedIdleHint[];
}

/** ORB-1799 - rendered identically on every exit (reserved, empty, paused):
 *  an agent that just pulled fresh work is exactly the one about to forget
 *  the ticket it already finished. Empty array renders nothing. */
function landedIdleLines(rows: LandedIdleHint[] | undefined): string[] {
  if (!rows || rows.length === 0) return [];
  return [
    '',
    '## Landed, idle - finished-looking work of yours awaiting the status move',
    ...rows.map((r) => `- ${r.ticketKey ?? r.ticketId} "${r.title}" - ${r.commitCount} commit(s) linked, no activity for ${r.idleWorkingDays} working day(s) (since ${r.lastActivityAt}).`),
    'Verify each is actually finished, then move it into the review lane (orboto_work_finish with targetCategory "in_review", or orboto_move_ticket) - do NOT re-implement it.',
  ];
}

export const workNextToolConfig = {
  title: 'Pull and reserve the next ready ticket (worker-pool dispatch)',
  description:
    'ORB-1613 - the pull side of low-management dispatch, sibling of orboto_work_start on the "I already know which ticket" side. Picks the highest-priority ticket in a project that is READY FOR THE REQUESTED ROLE (default role implementation pulls TODO tickets; `role: "review"` pulls tickets in the in_review status category instead, and NEVER offers a ticket the caller itself implemented - the review lane primitive, ORB-1777), unblocked (every dependency closed), not already leased under the requested role, and not blocked by a conflicting resourceClaim - then reserves it with the EXACT same guarantees as orboto_work_start (atomic lease acquire + the full context bundle: rules ack, primer, ticket, checklists, dependencies, git health, siblings) in the same response. Priority then ticket number, deterministic - never a coin flip on ties. Two workers calling this concurrently never receive the SAME ticket: the underlying reservation is the identical partial-unique-index INSERT orboto_work_start uses, just walked across an ordered candidate list - a collision just advances to the next candidate. Epics are never returned (they are containers, not directly implementable). When nothing is ready, the response is a STRUCTURED result (`reserved: null`) with a `reason` (`none-matching` = no todo tickets at all; `all-blocked` = candidates exist but all have open dependencies; `all-leased` = ready candidates exist but are all currently leased or claim-conflicted; `autonomy_paused` = ORB-1774, this agent identity or the whole workspace has autonomous pulls paused by an operator - idle and wait for an operator/notify wakeup instead of retrying) and, ONLY when derivable from an actual active lease, a `retryAfterSeconds` backoff hint (`earliestFreeAt` null and `retryAfterSeconds` null means no signal exists - never a fabricated constant). This is never an error - a worker pool should back off on the hint rather than poll hot. Prefer this over orboto_work_start whenever the caller does not care WHICH ticket it gets, only that it gets the best available one right now. Every response - reserved, empty or paused - also carries `landedIdle`: YOUR OWN tickets in this project that are still in_progress with a linked commit and no activity for days (ORB-1799). Those are finished-looking work nobody handed to the review lane; move them on instead of re-implementing them.',
  inputSchema: z.object({
    projectKey: z.string().min(1).describe('Project key (e.g. "ACME") or UUID.'),
    agentTag: z.string().min(1).max(64).optional()
      .describe('ORB-1772 - preferred-not-exclusive routing tag: tickets labeled `agent:<tag>` rank first for a matching caller, foreign `agent:*` tags rank last but stay eligible. Lowercased server-side. Set it to this worker\'s routing tag (often the model or fleet lane name).'),
    role: z.enum(['implementation', 'review', 'preflight', 'integration']).optional()
      .describe('Default `implementation`. The dispatcher only reserves a ticket whose (ticket, role) lease is free for THIS role.'),
    leaseSeconds: z.number().int().min(60).max(86_400).optional()
      .describe('How long the lease should hold without renewal. Default 900 (15 min).'),
    startTimer: z.boolean().optional()
      .describe('Defaults to true for `implementation`, false for the attach-only roles.'),
    agentSessionToken: z.string().optional()
      .describe('Stable per-agent-instance token. Omit to use this MCP connection\'s own instance id.'),
    resourceClaims: z.array(z.object(ResourceClaimShape)).max(50).optional()
      .describe('ORB-1610 - resource claims to acquire alongside the reservation, AND to filter candidates: a ticket already held under a conflicting GRANTED write claim elsewhere is skipped even when its (ticket, role) lease is free.'),
    onConflict: z.enum(['reject', 'queue']).optional()
      .describe('Only matters when `resourceClaims` is set on the WINNING candidate. Default `reject`.'),
    peek: z.boolean().optional()
      .describe('ORB-1930 - answer "is there work for me?" WITHOUT reserving anything: the same candidate walk (role pool, lane caps, labels, dependencies, leases), but no lease, no timer, no lane quota consumed. Returns `candidate` (the ticket a real pull would reserve right now) or the usual empty reason. Use it before spending a model turn on self-tasking.'),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};

export function makeWorkNextHandler(client: OrbotoClient) {
  // Per-connection rules-hash cache, same pattern as orboto_work_start.
  let lastKnownRulesHash: string | undefined;

  return async (
    args: {
      projectKey: string;
      agentTag?: string;
      role?: string;
      leaseSeconds?: number;
      startTimer?: boolean;
      agentSessionToken?: string;
      resourceClaims?: Array<{ kind: 'path' | 'named'; value: string; mode: 'read' | 'write' }>;
      onConflict?: 'reject' | 'queue';
      peek?: boolean;
    },
    extra?: { sessionId?: string },
  ): Promise<CallToolResult> => {
    const token = mcpInstanceToken(args.agentSessionToken, extra);
    const res = await client.post<NextWorkResponse>('/work-sessions/next', {
      projectKey: args.projectKey,
      ...(args.peek ? { peek: true } : {}),
      ...(args.agentTag ? { agentTag: args.agentTag } : {}),
      ...(args.role ? { role: args.role } : {}),
      ...(args.leaseSeconds ? { leaseSeconds: args.leaseSeconds } : {}),
      ...(args.startTimer !== undefined ? { startTimer: args.startTimer } : {}),
      ...(args.resourceClaims && args.resourceClaims.length > 0 ? { resourceClaims: args.resourceClaims } : {}),
      ...(args.onConflict ? { onConflict: args.onConflict } : {}),
      agentSessionToken: token,
      ...(lastKnownRulesHash ? { knownRulesHash: lastKnownRulesHash } : {}),
    });

    if (!res.reserved) {
      // ORB-1930 - a peek that found work: name it, reserve nothing.
      if (args.peek && res.candidate) {
        const c = res.candidate;
        return {
          content: [{
            type: 'text',
            text: [
              `Work is ready in "${args.projectKey}": ${c.ticketKey ?? c.ticketId} - ${c.title}${c.priority ? ` (${c.priority})` : ''}.`,
              'Nothing was reserved (peek). Call orboto_work_next without `peek` to take it.',
              ...landedIdleLines(res.landedIdle),
            ].join('\n'),
          }],
          structuredContent: {
            reserved: null,
            reason: null,
            candidate: c,
            candidatesConsidered: res.candidatesConsidered,
            ...(res.landedIdle && res.landedIdle.length > 0 ? { landedIdle: res.landedIdle } : {}),
          },
        };
      }
      // ORB-1774 - a pause is an operator decision, not a backoff situation:
      // tell the agent to idle, not to poll for a free slot.
      if (res.reason === 'autonomy_paused') {
        return {
          content: [{
            type: 'text',
            text: [
              'Autonomous work is PAUSED for this agent (by an operator, per-bot or workspace-wide). Do not poll for new tickets - idle and wait for an operator instruction or an agent-notify wakeup. Explicitly assigned work via orboto_work_start still runs.',
              ...landedIdleLines(res.landedIdle),
            ].join('\n'),
          }],
          structuredContent: {
            reserved: null,
            reason: res.reason,
            retryAfterSeconds: null,
            earliestFreeAt: null,
            candidatesConsidered: 0,
            ...(res.landedIdle && res.landedIdle.length > 0 ? { landedIdle: res.landedIdle } : {}),
          },
        };
      }
      const lines = [`No ready ticket in "${args.projectKey}" right now (${res.reason}).`];
      lines.push(
        res.retryAfterSeconds != null
          ? `Retry in ~${res.retryAfterSeconds}s (earliest known free: ${res.earliestFreeAt}).`
          : 'No derivable ETA - poll again later or check the project board.',
      );
      lines.push(`Candidates considered: ${res.candidatesConsidered}.`);
      lines.push(...landedIdleLines(res.landedIdle));
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: {
          reserved: null,
          reason: res.reason,
          retryAfterSeconds: res.retryAfterSeconds,
          earliestFreeAt: res.earliestFreeAt,
          candidatesConsidered: res.candidatesConsidered,
          ...(res.landedIdle && res.landedIdle.length > 0 ? { landedIdle: res.landedIdle } : {}),
        },
      };
    }

    const r = res.reserved;
    if (r.rulesHash) lastKnownRulesHash = r.rulesHash;

    const lines: string[] = [
      r.reused
        ? `Renewed your existing ${r.session.role} session on ${r.ticket.ticketKey ?? r.session.ticketId}.`
        : `Reserved ${r.ticket.ticketKey ?? r.session.ticketId} - started a ${r.session.role} work session.`,
      `Session id: ${r.session.id} (pass this to orboto_work_session_finish / orboto_work_finish).`,
      `Lease held until ${r.session.leaseUntil}; it renews automatically while you keep calling orboto.`,
      r.session.activeTimerId ? 'Timer running.' : 'No timer started for this role.',
    ];
    if (r.queued && r.queued.length > 0) {
      lines.push(
        'Queued (waiting for a conflicting writer to release):',
        ...r.queued.map((q) => `  - ${q.claim.kind}:${q.claim.value} - position ${q.position}`),
      );
    }

    lines.push('', '## Working rules');
    if (r.rulesUnchanged) {
      lines.push(`Unchanged since your last call on this connection (hash ${r.rulesHash}) - keep following what you already loaded.`);
    } else {
      lines.push(r.rules?.trim() || '(no workspace rules configured)');
    }

    lines.push('', '## Project primer');
    lines.push(r.primer.markdown.trim() || '(primer unavailable)');

    lines.push('', `## Ticket: ${r.ticket.ticketKey ?? '?'}`);
    lines.push(r.ticket.title);
    lines.push(`Status: ${r.ticket.statusName ?? r.ticket.status}  Priority: ${r.ticket.priority}  Type: ${r.ticket.type}`);
    if (r.ticket.description) lines.push('', r.ticket.description);

    lines.push('', '## Checklists');
    if (r.checklists.length === 0) {
      lines.push('(none)');
    } else {
      for (const cl of r.checklists) {
        lines.push(`${cl.title} (${cl.progress.done}/${cl.progress.total})${cl.triggersDone ? ' - triggers done' : ''}`);
        for (const i of cl.items) {
          const link = i.linkedTicketKey ? ` -> [${i.linkedTicketKey}] (${i.linkedTicketStatusCategory ?? 'unknown'})` : '';
          lines.push(`- [${i.effectiveCompleted ? 'x' : ' '}] ${i.content}${link}`);
        }
      }
    }

    // ORB-1614 - see the comment on the other fmtDeps above.
    const fmtDeps = (edges: StartDependencyEdge[]) =>
      edges.length === 0 ? '(none)' : edges.map((e) => `- [${e.ticketKey ?? '?'}] ${e.title ?? `External dependency (access restricted)${e.resolved ? ' - resolved' : ' - still open'}`}${e.statusName ? ` - ${e.statusName}` : ''}`).join('\n');
    lines.push('', '## Dependencies');
    lines.push('Blocked by:', fmtDeps(r.dependencies.blockedBy), 'Blocks:', fmtDeps(r.dependencies.blocks));

    const unhealthy = r.gitHealth.filter((c) => !c.healthy);
    if (unhealthy.length > 0) {
      lines.push('', '## Git connection health - WARNING');
      for (const c of unhealthy) {
        lines.push(`- "${c.name}" (${c.provider}) - ${GIT_HEALTH_REASON_TEXT[c.reason ?? ''] ?? c.reason ?? 'unknown reason'}`);
      }
    }

    lines.push('', '## Other sessions on this ticket');
    lines.push(
      r.siblingSessions.length === 0
        ? '(none)'
        : r.siblingSessions.map((s) => `  - [${s.role}] ${s.userFullName ?? s.userEmail ?? 'unknown'} - lease until ${s.leaseUntil}`).join('\n'),
    );
    lines.push(...landedIdleLines(res.landedIdle));

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: {
        reserved: {
          session: r.session,
          reused: r.reused,
          queued: r.queued ?? [],
          rulesHash: r.rulesHash,
          rulesUnchanged: r.rulesUnchanged,
          primer: r.primer,
          ticket: r.ticket,
          checklists: r.checklists,
          dependencies: r.dependencies,
          gitHealth: r.gitHealth,
          siblingSessions: r.siblingSessions,
        },
        reason: null,
        retryAfterSeconds: null,
        earliestFreeAt: null,
        candidatesConsidered: res.candidatesConsidered,
        ...(res.landedIdle && res.landedIdle.length > 0 ? { landedIdle: res.landedIdle } : {}),
      },
    };
  };
}

/**
 * ORB-1093 - `orboto_session_start`: a re-orientation digest for the
 * start of a session AND right after a context compaction, the points
 * where coding agents lose the thread. Composes the workspace
 * working-rules + the caller's in-progress work + timer into one
 * briefing so the agent re-anchors on how to work and what it was
 * doing. Read-only.
 *
 * ORB-1605 - also surfaces git-connection health for the projects the
 * caller currently has open work in. A dead/unhealthy connection means
 * commit ingestion may be stalled, which the agent should know about
 * BEFORE it assumes a closing check that depends on git activity is
 * reliable.
 *
 * ORB-1607 - lean startup contract:
 *   (a) rules-hash ack. `/agent-instructions` now returns a stable
 *       `rulesHash`. This handler remembers the last hash it saw FOR
 *       THE LIFETIME OF THIS MCP CONNECTION (one handler closure per
 *       `buildOrbotoMcpServer` call - see server.ts) and passes it back
 *       as `knownRulesHash` on every subsequent call. An unchanged hash
 *       collapses the multi-thousand-token rules block into a one-line
 *       ack, which is most of the field-measured 12-18k token/session
 *       cost on a workspace with configured instruction blocks. Never
 *       exposed as a tool input - the caller (an LLM) just calls the
 *       tool the same way every time; the cache is transparent.
 *   (b) optional `ticketKey` input bundles a project primer, the full
 *       ticket (incl. dependencies + checklists), that project's git
 *       health, and any other agent sessions currently working the same
 *       ticket into the SAME response - replacing what would otherwise
 *       be >=4 separate tool calls (get_project_primer, get_ticket,
 *       get_checklists, list_ticket_dependencies) at the point an agent
 *       has the least context loaded.
 *
 * ORB-1818 - the rules INDEX. Measured on production 2026-09-03: the
 * last 15 `session_start` calls cost 21.8k-29.3k characters each, 89 %
 * of it the assembled rule text, and none was ever truncated (the tool
 * held a 48k per-tool budget). A result is re-sent on every later
 * request, so that block was the single largest carry cost an agent
 * paid, on every cold start, whether or not it needed a single rule.
 *
 * The default answer now carries the rules HASH plus one line per rule
 * block (title only, in delivery order) and a `response_expand` handle;
 * the full, byte-identical text is one call away via `rulesOnly: true`
 * (stateless, never truncated) or that handle (in-process, 15 min). The
 * ack semantics are unchanged: a caller that already acked this exact
 * hash gets neither the text NOR the index, and `forceRules: true`
 * still returns the full text inline for offline agents and operator
 * debugging.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';
import { resolveTicketByKey, type TicketRow , applyAgentProfile } from './shared.js';
import { PROTECT_TEXT_META, storePayload } from '../response-budget.js';
import { loadRequiredRules } from '../required-rules.js';
import { GIT_HEALTH_REASON_TEXT } from './git-health-reasons.js';

export const sessionStartToolConfig = {
  title: 'Load the rules you must follow + re-orient',
  description:
    'THE canonical way to LOAD the binding workspace rules you must follow as an agent. Run it as your FIRST action in a session and immediately AFTER any context compaction. Returns a one-line-per-rule INDEX of the binding working-rules plus their hash (or a compact "unchanged" ack on a repeat call within the same connection) - read the index, then call this tool again with `rulesOnly: true` to read the full text of the rules whenever you do not already hold that exact hash, and expand before acting on any rule whose title touches what you are about to do. Also returns your in-progress tickets - each flagged LANDED, IDLE when it has a linked commit but has not moved for days, i.e. finished work you never handed to review - your running timer, and a warning if a project\'s git connection looks unhealthy (commit ingestion may be stalled). Pass `ticketKey` to also get a one-shot bundle for that ticket: project primer, the full ticket with dependencies + checklists, that project\'s git health, and any other agent sessions currently on it - replacing several separate calls. (Do NOT use orboto_list_agent_instructions to read the rules - that tool MANAGES/edits rule blocks for admins; this one is what you read to know how to work.) Read-only; no side effects. '
    // ORB-1805 - parameter prose moved out of the input schema (paid for
    // at every connect) into the description orboto_help serves in full.
    + '**Parameters.** `rulesOnly: true` returns ONLY the complete rules text (nothing else) and is never truncated - the cheapest way to read the rules the index listed. `projectId` adds that project\'s rules on top of the workspace + personal ones. `ticketKey` ("ACME-42") bundles that ticket\'s primer, full detail, dependencies, checklists, git health and other active agent sessions into the same response. `forceRules: true` returns the full rules text inline with the rest of the digest even when this connection already delivered them - use it whenever the rules are NOT in your context right now: after a compaction, a /clear, or a fresh agent taking over an existing connection. `agentKind` (coding, orchestrator, reviewer, runner) and `modelTier` (frontier, standard, small) are your self-declared classification; rule blocks and per-tier rule text are targeted by them.',
  inputSchema: z.object({
    projectId: z.string().uuid().optional().describe('Also load this project\'s rules.'),
    ticketKey: z.string().min(3).optional().describe('Ticket key ("ACME-42") - bundles that ticket\'s full context.'),
    // ORB-1697 - the caller is the only party that knows whether it still
    // HOLDS the rules. See the ack-defect note on the handler below.
    forceRules: z.boolean().optional().describe('Always return the full rules; set it when you do not hold them.'),
    // ORB-1818 - the stateless way back from the index to the full text.
    rulesOnly: z.boolean().optional().describe('Return ONLY the complete rules text.'),
    // ORB-1753 - self-declared classification for rule targeting; defaults
    // to ORBOTO_AGENT_KIND / ORBOTO_MODEL_TIER env, then the api-key's
    // standing profile server-side.
    agentKind: z.string().min(1).max(32).optional().describe('coding | orchestrator | reviewer | runner.'),
    modelTier: z.string().min(1).max(32).optional().describe('frontier | standard | small.'),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

interface Me { email?: string; fullName?: string; locale?: string; workspaceLocale?: string }
interface Ticket {
  ticketKey: string;
  title: string;
  status?: string;
  statusName?: string;
  projectId?: string;
  // ORB-1799 - "landed, idle": still in_progress, has a linked commit, no
  // activity for N working days. Finished-looking work that was never handed
  // to the review lane - the exact thing a re-orienting agent forgets.
  landedIdle?: boolean;
  landedIdleWorkingDays?: number | null;
}
interface Timer { ticketId?: string | null; ticketKey?: string; startedAt?: string }
// ORB-1605 / ORB-1638 - mirrors GitConnectionHealthSchema in @orboto/shared-schema.
interface GitConnectionHealth {
  connectionId: string;
  name: string;
  provider: string;
  connected: boolean;
  healthy: boolean;
  lastEventAt: string | null;
  reason: string | null;
  outboundReachable: boolean | null;
  inboundDelivering: boolean | null;
  deliveryError: string | null;
  lastProbeAt: string | null;
}
interface ChecklistItemRow {
  content: string;
  effectiveCompleted: boolean;
  linkedTicketKey: string | null;
  linkedTicketTitle: string | null;
  linkedTicketStatusCategory: string | null;
}
interface ChecklistRow {
  title: string;
  triggersDone: boolean;
  progress: { done: number; total: number };
  items: ChecklistItemRow[];
}
interface DependencyEdge {
  ticketKey: string | null;
  // ORB-1614 - null on an opaque cross-project stub the caller cannot
  // read (see `external`/`resolved`).
  title: string | null;
  statusName: string | null;
  statusCategory: string | null;
  external?: boolean;
  resolved?: boolean;
}
interface PrimerJsonResponse {
  markdown: string;
  totalTokens: number;
  truncatedSections: string[];
}
interface ActiveAgentRow {
  userId: string;
  userEmail: string;
  userFullName: string | null;
  status: string;
  workingOnTicket: { id: string; key: string | null; title: string } | null;
  lastSeenAt: string;
}

// Cap how many distinct projects we probe for git health - a session's
// in-progress work is capped at 20 tickets already, so this rarely
// exceeds a handful, but bound it defensively so a pathological account
// can't turn session-start into N parallel requests.
const MAX_GIT_HEALTH_PROJECTS = 8;

/** ORB-1607 - build the `--ticket` one-shot bundle. Never throws: an
 *  unresolvable/unauthorized ticket key comes back as a text error
 *  section instead of failing the whole digest (the rules + in-progress
 *  work above it are still useful on their own). */
async function buildTicketBundle(
  client: OrbotoClient,
  ticketKey: string,
): Promise<{ lines: string[]; structured: Record<string, unknown>; projectId?: string }> {
  let resolved: TicketRow;
  try {
    resolved = await resolveTicketByKey(client, ticketKey);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      lines: ['', `## Ticket bundle: ${ticketKey}`, `Could not load this ticket: ${message}`],
      structured: { ticketKey, error: message },
    };
  }

  const [enriched, checklists, deps, primer, gitHealthConnections, activeSessions] = await Promise.all([
    // resolveTicketByKey hits the by-key endpoint, which returns a bare
    // row (no statusCategory / assignees / description). Re-fetch the
    // enriched by-id shape, mirroring orboto_get_ticket.
    client.get<TicketRow>(`/projects/${resolved.projectId}/tickets/${resolved.id}`).catch(() => resolved),
    client.get<ChecklistRow[]>(`/tickets/${resolved.id}/checklists`)
      .then((r) => (Array.isArray(r) ? r : []))
      .catch(() => [] as ChecklistRow[]),
    client
      .get<{ blockedBy: DependencyEdge[]; blocks: DependencyEdge[] }>(`/projects/${resolved.projectId}/tickets/${resolved.id}/dependencies`)
      .then((r) => ({
        blockedBy: Array.isArray(r?.blockedBy) ? r.blockedBy : [],
        blocks: Array.isArray(r?.blocks) ? r.blocks : [],
      }))
      .catch(() => ({ blockedBy: [] as DependencyEdge[], blocks: [] as DependencyEdge[] })),
    client.get<PrimerJsonResponse>(`/projects/${resolved.projectId}/ai-primer?format=json`).catch(() => null),
    client
      .get<{ connections: GitConnectionHealth[] }>(`/projects/${resolved.projectId}/git-health`)
      .then((r) => (Array.isArray(r?.connections) ? r.connections : []))
      .catch(() => [] as GitConnectionHealth[]),
    // ORB-704 - non-admins only see their own sessions; that's an
    // acceptable "cheaply available" degrade, not a bug to work around.
    client.get<ActiveAgentRow[]>('/v1/agent/presence').catch(() => [] as ActiveAgentRow[]),
  ]);
  // ORB-1697 - `enriched ?? resolved` trusted truthiness: a 200 whose body
  // is `{}` is truthy, so the fallback never fired and the bundle rendered
  // "Ticket bundle: undefined" with empty fields. Fall back on the row we
  // already resolved unless the enriched read actually carries a ticket.
  const full = enriched?.ticketKey ? enriched : resolved;
  // ORB-1697 - the `.catch` above only covers a REJECTED request. A 200 with
  // an unexpected body (a wrapped/paginated shape, or an older instance)
  // would make `.filter` throw and take the whole digest down over an
  // optional section. Coerce instead.
  const sessions = Array.isArray(activeSessions) ? activeSessions : [];
  const connections = Array.isArray(gitHealthConnections) ? gitHealthConnections : [];
  const sessionsOnTicket = sessions.filter((s) => s.workingOnTicket?.key === full.ticketKey);
  const unhealthy = connections.filter((c) => !c.healthy);

  const lines: string[] = ['', `## Ticket bundle: ${full.ticketKey}`];

  lines.push('', '### Project primer');
  lines.push(primer?.markdown?.trim() || '(primer unavailable)');

  lines.push('', '### Ticket');
  lines.push(`[${full.ticketKey}] ${full.title}`);
  lines.push(`Status: ${full.statusName ?? full.status}  Priority: ${full.priority}  Type: ${full.type}`);
  if (full.description) lines.push('', full.description);

  lines.push('', '### Checklists');
  if (checklists.length === 0) lines.push('(none)');
  else {
    for (const cl of checklists) {
      lines.push(`${cl.title} (${cl.progress.done}/${cl.progress.total})${cl.triggersDone ? ' · triggers done' : ''}`);
      for (const i of cl.items) {
        const link = i.linkedTicketKey ? ` ↪ [${i.linkedTicketKey}] (${i.linkedTicketStatusCategory ?? 'unknown'})` : '';
        lines.push(`- [${i.effectiveCompleted ? 'x' : ' '}] ${i.content}${link}`);
      }
    }
  }

  lines.push('', '### Dependencies');
  // ORB-1614 - a cross-project blocker/dependent the caller cannot read
  // comes back with `title: null` - render a fixed, non-identifying
  // placeholder instead of the literal "null".
  const fmtDeps = (edges: DependencyEdge[]) =>
    edges.length === 0 ? '(none)' : edges.map((e) => `- [${e.ticketKey ?? '?'}] ${e.title ?? `External dependency (access restricted)${e.resolved ? ' - resolved' : ' - still open'}`}${e.statusName ? ` - ${e.statusName}` : ''}`).join('\n');
  lines.push('Blocked by:', fmtDeps(deps.blockedBy), 'Blocks:', fmtDeps(deps.blocks));

  if (unhealthy.length > 0) {
    lines.push('', '### Git connection health - WARNING');
    for (const c of unhealthy) {
      lines.push(`- "${c.name}" (${c.provider}) - ${GIT_HEALTH_REASON_TEXT[c.reason ?? ''] ?? c.reason ?? 'unknown reason'}`);
    }
  }

  lines.push('', '### Active agent sessions on this ticket');
  lines.push(
    sessionsOnTicket.length === 0
      ? '(none visible - non-admin callers only see their own sessions)'
      : sessionsOnTicket.map((s) => `- ${s.userFullName ?? s.userEmail} - ${s.status}, last seen ${s.lastSeenAt}`).join('\n'),
  );

  return {
    lines,
    projectId: resolved.projectId,
    structured: {
      ticketKey: full.ticketKey,
      title: full.title,
      status: full.statusName ?? full.status,
      priority: full.priority,
      type: full.type,
      description: full.description ?? null,
      primer: primer ? { markdown: primer.markdown, totalTokens: primer.totalTokens, truncatedSections: primer.truncatedSections } : null,
      checklists: checklists.map((cl) => ({
        title: cl.title,
        progress: cl.progress,
        items: cl.items.map((i) => ({ content: i.content, done: i.effectiveCompleted })),
      })),
      dependencies: {
        blockedBy: deps.blockedBy.map((e) => ({ ticketKey: e.ticketKey, title: e.title, statusName: e.statusName, external: e.external, resolved: e.resolved })),
        blocks: deps.blocks.map((e) => ({ ticketKey: e.ticketKey, title: e.title, statusName: e.statusName, external: e.external, resolved: e.resolved })),
      },
      // ORB-1697 - only the connections that need attention. A healthy
      // connection is 11 fields of "everything is fine" the agent never
      // acts on; the count preserves the fact that connections exist.
      gitHealth: { unhealthy, healthyCount: connections.length - unhealthy.length },
      activeSessions: sessionsOnTicket.map((s) => ({ userFullName: s.userFullName, userEmail: s.userEmail, status: s.status, lastSeenAt: s.lastSeenAt })),
    },
  };
}

export function makeSessionStartHandler(client: OrbotoClient) {
  // ORB-1607 - per-connection rules-hash cache. `buildOrbotoMcpServer`
  // calls this factory once per MCP connection, so this closure variable
  // lives for exactly that connection's lifetime and resets on reconnect.
  //
  // ORB-1697 - the defect that cache had: a stdio MCP server outlives
  // `/clear` and every context compaction, so a repeat call answered
  // "unchanged, keep following what you already loaded" at exactly the
  // moment the agent no longer held the rules. The connection is the wrong
  // thing to key the ack on; only the CALLER knows what is still in its
  // context. Hence `forceRules`, and an ack text that says so.
  let lastKnownRulesHash: string | undefined;

  return async (input: { projectId?: string; ticketKey?: string; forceRules?: boolean; rulesOnly?: boolean; agentKind?: string; modelTier?: string } = {}): Promise<CallToolResult> => {
    const rulesParams = new URLSearchParams();
    if (input.projectId) rulesParams.set('projectId', input.projectId);
    // ORB-1753 - rule targeting: explicit input > env > (server-side) the
    // api-key's standing profile. The rules hash is profile-specific
    // server-side, so the cached ack stays valid per profile.
    applyAgentProfile(rulesParams, { agentKind: input.agentKind, modelTier: input.modelTier });
    // ORB-1818 - both full-text answers bypass the ack: the caller is
    // asking for the text precisely because it does not hold it.
    const wantsFullRules = input.forceRules === true || input.rulesOnly === true;
    if (lastKnownRulesHash && !wantsFullRules) rulesParams.set('knownRulesHash', lastKnownRulesHash);
    const rulesQs = rulesParams.toString();
    const rulesPath = rulesQs ? `/agent-instructions?${rulesQs}` : '/agent-instructions';

    // ORB-1818 - `rulesOnly`: the STATELESS way back from the index to the
    // full text. The `response_expand` handle the index also carries lives
    // in this process' memory (15 min, 16 payloads), so a server restart,
    // a reconnect or simply 16 later truncations can retire it - and a
    // binding rule must never become unreachable. This path re-reads the
    // rules from the API instead, costs one call, and skips the whole rest
    // of the digest. Protected in both halves: it IS the rule text.
    if (input.rulesOnly) {
      const rules = await loadRequiredRules(client, rulesPath);
      if (rules.rulesHash) lastKnownRulesHash = rules.rulesHash;
      const text = rules.instructions ?? '';
      return {
        _meta: { [PROTECT_TEXT_META]: true },
        content: [{
          type: 'text',
          text: [
            '# orboto working rules - complete',
            `Hash ${rules.rulesHash ?? '(unknown)'}. Follow these; they are binding.`,
            '',
            text || '(no workspace rules configured)',
          ].join('\n'),
        }],
        structuredContent: {
          rules: rules.instructions ?? '',
          rulesHash: rules.rulesHash ?? null,
          rulesUnchanged: false,
          rulesDelivery: 'full',
          rulesChars: (rules.instructions ?? '').length,
        },
      };
    }

    const [me, rules, assigned, timer, inboxRaw] = await Promise.all([
      client.get<Me>('/users/me').catch(() => null),
      loadRequiredRules(client, rulesPath, rulesParams.get('knownRulesHash') ?? undefined),
      // ORB-1330 - a re-orientation briefing must only list OPEN work.
      // Filter to in_progress + in_review so DONE tickets can't pose as
      // "what you're working on" at the moment the agent has the least
      // context and would otherwise re-claim / re-report finished work.
      // Cap 20.
      client.get<{ items?: Ticket[] } | Ticket[]>('/users/me/assigned-tickets?statuses=IN_PROGRESS,IN_REVIEW&limit=20').catch(() => ({ items: [] })),
      client.get<Timer>('/time/timer').catch(() => null),
      // ORB-1727 - unread agent messages, delivered right where an agent
      // re-orients. Coerced defensively (ORB-1697 lesson) and optional.
      client.get<{ messages?: Array<{ id: string; fromUserId: string; kind: string; subject: string; createdAt: string }> }>('/v1/agent/messages?limit=10')
        .then((r) => (Array.isArray(r?.messages) ? r.messages : []))
        .catch(() => []),
    ]);
    const pendingMessages = inboxRaw.map((m) => ({ id: m.id, fromUserId: m.fromUserId, kind: m.kind, subject: m.subject, createdAt: m.createdAt }));
    const tickets: Ticket[] = Array.isArray(assigned) ? assigned : (assigned?.items ?? []);

    // ORB-1605 - git-connection health for every project the caller has
    // open work in right now. Cheap, computed, read-only (see
    // services/git-health.ts) - safe to fan out on every session start.
    const projectIds = [...new Set(tickets.map((t) => t.projectId).filter((id): id is string => !!id))].slice(0, MAX_GIT_HEALTH_PROJECTS);
    const gitHealthByProject = await Promise.all(
      projectIds.map(async (projectId) => ({
        projectId,
        connections: await client
          .get<{ connections: GitConnectionHealth[] }>(`/projects/${projectId}/git-health`)
          // ORB-1697 - `.catch` covers a rejected request, not a 200 whose
          // body lacks `connections` (an older instance, or a shape change).
          // Without the guard, an optional warning section takes the whole
          // digest down at the moment the agent has the least context.
          .then((r) => (Array.isArray(r?.connections) ? r.connections : []))
          .catch(() => [] as GitConnectionHealth[]),
      })),
    );
    const gitHealthWithConnections = gitHealthByProject.filter((p) => p.connections.length > 0);
    const unhealthyWarnings = gitHealthWithConnections.flatMap((p) =>
      p.connections
        .filter((c) => !c.healthy)
        .map((c) => `- Project ${p.projectId}: connection "${c.name}" (${c.provider}) is unhealthy - ${GIT_HEALTH_REASON_TEXT[c.reason ?? ''] ?? c.reason ?? 'unknown reason'}. If closing a ticket here depends on commit/PR ingestion, verify manually - ingestion may be stalled.`),
    );

    // ORB-1607 - the optional one-shot ticket bundle, built after the
    // rest so it doesn't hold up the core digest on a slow primer render.
    const bundle = input.ticketKey ? await buildTicketBundle(client, input.ticketKey) : null;

    // ORB-1697 - when the caller named the ticket it is working, the
    // cross-project assigned list is noise: it measured 3.5k characters of
    // other projects' tickets on a real call. List the ones in the same
    // project, count the rest so nothing is hidden.
    const scopeProjectId = bundle?.projectId;
    const scopedTickets = scopeProjectId
      ? tickets.filter((t) => !t.projectId || t.projectId === scopeProjectId)
      : tickets;
    const elsewhereCount = tickets.length - scopedTickets.length;

    const lines: string[] = ['# orboto session start'];
    if (me) lines.push(`You are ${me.fullName ?? me.email}${me.email ? ` (${me.email})` : ''}.`);
    if (me?.workspaceLocale || me?.locale) lines.push(`Write tickets / comments / docs in: ${me.workspaceLocale ?? me.locale}.`);
    // ORB-1818 - three delivery modes for the rules, cheapest first:
    //   ack    - this connection already delivered this exact hash.
    //   index  - one line per rule + the hash + a handle; the default.
    //   full   - the text inline (forceRules, or an API too old to send
    //            an index - never leave a caller without its rules).
    const rulesText = rules.instructions ?? '';
    const rulesIndex = Array.isArray(rules.rulesIndex)
      ? rules.rulesIndex.map((e) => e?.title).filter((t): t is string => typeof t === 'string' && t.length > 0)
      : [];
    const deliverIndex = !rules.rulesUnchanged && input.forceRules !== true && rulesIndex.length > 0 && rulesText.length > 0;
    const deliverFull = !rules.rulesUnchanged && !deliverIndex && rulesText.length > 0;
    const rulesChars = rules.rulesChars ?? rulesText.length;
    // The way back, spelled out for the structured half too: Claude Code
    // keeps `structuredContent` and drops the text block, so a pointer
    // that lives only in the Markdown reaches half the clients.
    const HOW_TO_READ_RULES =
      'Call orboto_session_start { rulesOnly: true } for the complete rule text (one call, never truncated). '
      + 'Do that whenever you do not already hold this exact rulesHash - after a compaction, a /clear, or as a fresh agent.';
    let rulesHandle: string | undefined;
    lines.push('', '## Working rules - follow these');
    if (rules.rulesUnchanged) {
      // ORB-1697 - never assert that the caller still HAS the rules. This
      // connection delivered them once, which says nothing about whether
      // they survived a compaction or a /clear on the client side.
      lines.push(
        `Unchanged since this connection last delivered them (hash ${rules.rulesHash}), so they were left out to save context.`,
        'If the rules are NOT in your context right now - after a compaction, a /clear, or because you are a fresh agent on an existing connection - call this tool again with rulesOnly=true (rules alone) or forceRules=true (rules plus this digest) and read them in full. Do not proceed on a half-remembered rule set.',
      );
    } else if (deliverIndex) {
      // The full text stays one call away in BOTH directions: statelessly
      // via rulesOnly, and via the standard ORB-1697 expand handle while
      // this process still holds it.
      rulesHandle = storePayload('orboto_session_start', {
        structuredContent: { rules: rules.instructions ?? '' },
        text: rules.instructions ?? '',
        omitted: [{ path: 'rules', kind: 'string', omittedChars: rulesText.length }],
      });
      lines.push(
        `${rulesIndex.length} rule(s) bind you (${rulesChars} characters, hash ${rules.rulesHash}). Titles only - the full text is NOT in this response.`,
        `${HOW_TO_READ_RULES} Read any rule below whose title touches what you are about to do BEFORE you do it. (orboto_response_expand { handle: "${rulesHandle}", path: "rules" } serves the same text from this process for 15 minutes.)`,
        ...rulesIndex.map((title, i) => `${i + 1}. ${title}`),
      );
    } else {
      lines.push(rulesText || '(no workspace rules configured)');
    }
    lines.push('', '## Your in-progress work');
    if (tickets.length === 0) lines.push('No tickets currently assigned to you - claim or create one before you start coding.');
    else {
      for (const t of scopedTickets) {
        // ORB-1799 - the flag is the whole point of listing this ticket
        // again, so it goes on the SAME line, not into a separate section
        // a compaction-recovering agent might skim past.
        const landed = t.landedIdle
          ? ` - LANDED, IDLE ${t.landedIdleWorkingDays ?? '?'} working day(s): a commit is linked but the ticket never moved. Verify it is finished, then move it to review (orboto_work_finish / move_ticket) instead of re-implementing it.`
          : '';
        lines.push(`- ${t.ticketKey} [${t.statusName ?? t.status}] ${t.title}${landed}`);
      }
    }
    if (elsewhereCount > 0) {
      lines.push(`(+ ${elsewhereCount} open ticket(s) assigned to you in other projects - call orboto_my_tickets to list them.)`);
    }
    if (unhealthyWarnings.length > 0) {
      lines.push('', '## Git connection health - WARNING', ...unhealthyWarnings);
    }
    lines.push('', '## Timer');
    lines.push(timer?.ticketId ? `Running on ${timer.ticketKey ?? timer.ticketId} since ${timer.startedAt ?? 'earlier'}.` : 'No timer running.');
    if (pendingMessages.length > 0) {
      lines.push('', '## Agent messages - unread');
      for (const m of pendingMessages) lines.push(`- [${m.kind}] ${m.subject} (from ${m.fromUserId}, ${m.createdAt}, id ${m.id})`);
      lines.push('Handle them, then acknowledge via orboto_messages { ackIds: [...] }; reply via orboto_agent_notify with threadId.');
    }
    if (bundle) lines.push(...bundle.lines);
    lines.push('', 'Re-run this after any context compaction to re-sync.');
    const result: CallToolResult = {
      // ORB-1818 - when the full rule text IS the payload, neither half
      // may be cut; see PROTECT_TEXT_META. The index answer carries no
      // rule text and is budgeted like any other response.
      ...(deliverFull ? { _meta: { [PROTECT_TEXT_META]: true } } : {}),
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: {
        // ORB-1818 - empty in index/ack mode: the whole point is that the
        // text is not carried. `rulesDelivery` says which answer this is.
        rules: deliverFull ? (rules.instructions ?? '') : '',
        rulesHash: rules.rulesHash ?? null,
        rulesUnchanged: rules.rulesUnchanged === true,
        rulesDelivery: rules.rulesUnchanged ? 'ack' : deliverIndex ? 'index' : 'full',
        ...(deliverIndex
          ? { rulesIndex, rulesChars, rulesHandle, rulesHowToRead: HOW_TO_READ_RULES }
          : {}),
        ...(rules.rulesUnchanged ? { rulesHowToRead: HOW_TO_READ_RULES } : {}),
        inProgress: scopedTickets.map((t) => ({
          ticketKey: t.ticketKey,
          title: t.title,
          status: t.statusName ?? t.status ?? null,
          // ORB-1799 - only carried when true; a `false` on every row is
          // budget spent on "nothing to see here" (see the MCP response
          // budget contract in CLAUDE.md).
          ...(t.landedIdle ? { landedIdle: true, landedIdleWorkingDays: t.landedIdleWorkingDays ?? null } : {}),
        })),
        ...(elsewhereCount > 0 ? { inProgressElsewhereCount: elsewhereCount } : {}),
        timer: timer?.ticketId ? { ticketKey: timer.ticketKey ?? null, startedAt: timer.startedAt ?? null } : null,
        // ORB-1697 - unhealthy connections only; a healthy one is 11 fields
        // the agent never acts on. `healthyCount` keeps the fact visible.
        gitHealth: {
          unhealthy: gitHealthWithConnections
            .map((p) => ({ projectId: p.projectId, connections: p.connections.filter((c) => !c.healthy) }))
            .filter((p) => p.connections.length > 0),
          healthyCount: gitHealthWithConnections.reduce(
            (n, p) => n + p.connections.filter((c) => c.healthy).length,
            0,
          ),
        },
        ...(pendingMessages.length > 0 ? { pendingMessages } : {}),
        ...(bundle ? { ticketBundle: bundle.structured } : {}),
      },
    };
    lastKnownRulesHash = rules.rulesHash;
    return result;
  };
}

/**
 * ORB-705 - MCP coordination tools.
 *
 * @see ORB-704, ORB-706
 */
import { z } from 'zod';
import {
  AGENT_WAKE_LABELS, AgentInventoryKindSchema, AgentSessionWakeSchema, type AgentInventoryEntry, type AgentSessionWake,
} from './agent-presence-schema.js';
import { AgentPresenceRowSchema, type AgentPresenceRow } from './agent-presence-row.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OrbotoApiError, type OrbotoClient } from '../orboto-client.js';
import { mcpInstanceToken, presenceRefusal } from './shared.js';
import { AgentSessionRoleSchema, AgentSessionScopeSchema, type AgentSessionScope } from './agent-session-scope.js';

interface HeartbeatResponse {
  sessionToken: string;
  sessionId: string;
  scope: AgentSessionScope | null;
  startedBy?: string | null;
  wake?: AgentSessionWake;
  notes?: string[];
}

export const agentHeartbeatToolConfig = {
  title: 'Agent heartbeat (Multi-Agent Coordination)',
  description:
    'Register or refresh this agent\'s presence with status detail. A live connection already counts as online (an open MCP event stream, `orboto messages --follow`, the agent WebSocket) - the heartbeat adds status: idle (default) | working (+workingOnTicketId) | blocked, capabilities (free-form strings for operator filters) and clientInfo.name (the runtime), and is the only presence path for turn-based clients without a standing connection. Rows older than 90 s count as offline; persist the returned sessionToken and send it on later heartbeats. `scope` { projectKeys, ticketKeys, role } declares this session\'s responsibility (ORB-2136); an empty object clears it. `startedBy`: starter session id, same account.',
  inputSchema: z.object({
    sessionToken: z.string().nullable().optional(),
    scope: AgentSessionScopeSchema.optional(),
    status: z.enum(['idle', 'working', 'blocked']).optional(),
    workingOnTicketId: z.string().uuid().nullable().optional(),
    capabilities: z.array(z.string()).max(200).optional(),
    clientInfo: z.object({
      name: z.string().optional(),
      version: z.string().optional(),
      host: z.string().optional(),
      user_agent: z.string().optional(),
    }).optional(),
    startedBy: z.string().uuid().optional(),
  }).shape,
  outputSchema: z.object({
    sessionToken: z.string(),
    sessionId: z.string().uuid(),
    scope: AgentSessionScopeSchema.nullable(),
    startedBy: z.string().uuid().nullable().optional(),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
};

export function makeAgentHeartbeatHandler(client: OrbotoClient) {
  return async (
    args: {
      sessionToken?: string | null;
      scope?: AgentSessionScope | null;
      status?: 'idle' | 'working' | 'blocked';
      workingOnTicketId?: string | null;
      capabilities?: string[];
      clientInfo?: { name?: string; version?: string; host?: string; user_agent?: string };
      startedBy?: string;
    },
    extra?: unknown,
  ): Promise<CallToolResult> => {
    let res: HeartbeatResponse;
    try {
      res = await client.post<HeartbeatResponse>('/v1/agent/heartbeat', args, { instanceToken: mcpInstanceToken(undefined, extra as { sessionId?: string } | undefined) });
    } catch (err) {
      const refused = presenceRefusal(err);
      if (!refused) throw err;
      return { content: [{ type: 'text', text: `heartbeat refused (ORB-2553) - ${refused.message}` }], isError: true };
    }
    const scope = res.scope ? ` scope=${JSON.stringify(res.scope)}` : '';
    const notes = (res.notes ?? []).map((n) => `\n${n}`).join('');
    return {
      content: [{ type: 'text', text: `heartbeat ack - sessionToken=${res.sessionToken.slice(0, 8)}… session ${res.sessionId.slice(0, 8)}${scope}${notes}` }],
      structuredContent: {
        sessionToken: res.sessionToken, sessionId: res.sessionId, scope: res.scope ?? null, ...(res.startedBy !== undefined ? { startedBy: res.startedBy } : {}),
        ...(res.wake ? { wake: res.wake } : {}), ...(res.notes ? { notes: res.notes } : {}),
      },
    };
  };
}

type PresenceRow = AgentInventoryEntry & { origin?: SessionOrigin; state?: string; redacted?: boolean };

/** ORB-2544 - where a session runs and its state, as one directory phrase; empty when the instance predates the origin. */
export interface SessionOrigin { host: string | null; repo: string | null; pid: number | null; client: string | null; clientVersion: string | null; harness: string | null; startedAt: string | null }
export function originText(s: { origin?: SessionOrigin; state?: string }): string {
  if (!s.origin) return '';
  const o = s.origin;
  const where = [o.host ?? 'unknown host', o.repo, o.pid ? `pid ${o.pid}` : null, o.harness, o.client ? `${o.client}${o.clientVersion ? ` ${o.clientVersion}` : ''}` : null].filter(Boolean).join(' ');
  return ` [${s.state ?? 'live'}] on ${where}${o.startedAt ? ` since ${o.startedAt}` : ''}`;
}

/** ORB-2548 - the page an MCP presence read returns by default, sized so four rows fit the 4,000-character budget. */
export const PRESENCE_PAGE_LIMIT = 4;

/** ORB-2548 - the server-side filters orboto_who and orboto_agent_presence share, as the `GET /v1/agent/who` query. */
export interface PresenceFilters {
  project?: string; role?: string; state?: string; email?: string; sessionId?: string;
  kind?: 'agent' | 'human'; wake?: AgentSessionWake; limit?: number; cursor?: string; for?: string;
}

export const PresenceFilterShape = {
  role: AgentSessionRoleSchema.optional(),
  state: z.enum(['live', 'quiet', 'orphaned', 'unknown_origin']).optional(),
  email: z.string().min(3).max(320).optional(),
  sessionId: z.string().min(8).max(36).optional(),
  kind: AgentInventoryKindSchema.optional(),
  wake: AgentSessionWakeSchema.optional(),
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().max(500).optional(),
};

export function presenceQuery(args: PresenceFilters, extra: Record<string, string> = {}): string {
  const qs = new URLSearchParams(extra);
  for (const key of ['project', 'role', 'state', 'email', 'sessionId', 'kind', 'wake', 'cursor', 'for'] as const) {
    const value = args[key]?.trim();
    if (value) qs.set(key, value);
  }
  qs.set('limit', String(args.limit ?? PRESENCE_PAGE_LIMIT));
  return qs.toString();
}

/** ORB-2548 - the answer for a project filter the API does not know or the caller may not see (its 404). */
export function unknownProjectText(key: string): string {
  return `Project "${key.trim().toUpperCase()}" is unknown or not visible to you - no session is listed for it.`;
}

/** Runs the presence read; a 404 for a project filter becomes null, so the tool answers unknownProjectText instead of a raw error. */
export async function readPresence<T>(client: OrbotoClient, path: string, project: string | undefined): Promise<T | null> {
  try {
    return await client.get<T>(path);
  } catch (err) {
    if (project?.trim() && err instanceof OrbotoApiError && err.status === 404) return null;
    throw err;
  }
}

/** The line that ends a page with more rows behind it. */
export function nextPageLine(nextCursor: string | null | undefined): string[] {
  return nextCursor ? [`More sessions: call again with cursor "${nextCursor}", or narrow with email, sessionId, project, role, kind, wake or state.`] : [];
}

function presenceRow(s: PresenceRow): AgentPresenceRow {
  const o = s.origin;
  return {
    sessionId: s.sessionId, userEmail: s.userEmail, userFullName: s.userFullName, kind: s.kind,
    owner: s.owner?.name ?? s.owner?.email ?? (s.actsAs ? `acts as ${s.actsAs.name ?? s.actsAs.email}` : null),
    status: s.status, lane: s.lane?.name ?? null, scope: s.scope ?? null, memberProjects: s.projects.length,
    connections: [...new Set(s.connections.map((c) => c.type))], ...(s.wake ? { wake: s.wake } : {}), ...(s.state ? { state: s.state } : {}),
    origin: o ? { host: o.host, repo: o.repo, pid: o.pid, harness: o.harness, client: o.client } : null,
    workingOn: s.workingOnTicket ? s.workingOnTicket.key ?? s.workingOnTicket.id : null,
    lastSeenAt: String(s.lastSeenAt), ...(s.redacted ? { redacted: true } : {}),
  };
}

function presenceLine(s: PresenceRow): string {
  const name = s.userFullName ?? s.userEmail;
  const runtime = s.clientInfo.name ?? 'unknown';
  const work = s.workingOnTicket ? ` · working on [${s.workingOnTicket.projectKey ?? '?'}] ${s.workingOnTicket.key ?? s.workingOnTicket.id} (${s.workingOnTicket.title})` : '';
  const owner = s.owner?.name ?? s.owner?.email ?? (s.actsAs ? `acts as ${s.actsAs.name ?? s.actsAs.email}` : s.kind === 'agent' ? 'unassigned' : 'self');
  const declared = s.scope?.projectKeys ?? [];
  const scope = s.scope?.role || declared.length ? `; scope: ${s.scope?.role ?? 'no role'}${declared.length ? ` on ${declared.join(', ')}` : ''}` : '';
  const keys = s.projects.map((p) => p.key);
  const projects = keys.length === 0 ? '' : keys.length <= 8 ? `; projects: ${keys.join(', ')}` : `; member of ${keys.length} projects`;
  const connections = s.connections.length ? `; connections: ${[...new Set(s.connections.map((c) => c.type))].join(', ')}` : '';
  return `- ${name} <${s.userEmail}> (${runtime}, instance ${s.sessionId}) - ${s.status}${originText(s)}${work}; owner: ${owner}${s.lane ? `; lane: ${s.lane.name}` : ''}${scope}${projects}${connections}${s.wake ? `; ${AGENT_WAKE_LABELS[s.wake]}` : ''}`;
}

export const agentPresenceToolConfig = {
  title: 'Workspace agent presence',
  description:
    'Active agent instances. The orboto_who set from GET /v1/agent/who?include=inventory: lane workers and reviewers, inbox, MCP and runner connections. Each row: sessionId, account, kind (agent | human by credential), owner or acts-as, status, lane, declared scope, member project count, connection types, wake (on_call: nothing wakes it), state (live | quiet | orphaned | unknown_origin), origin (host, repo, pid, harness, client), current ticket. Filters run on the server: email, sessionId (id or 8+ character prefix), projectKey (sessions declared on it), role, kind, wake, state; 4 rows a page, nextCursor continues (cursor). A projectKey that is unknown or not visible to you answers so in one line, with no rows. Operators (admin:agents:read or admin:system:read) see the workspace, others their own sessions and those on their projects, a foreign row redacted. The full inventory row: `orboto agents --json`.',
  inputSchema: z.object({
    projectKey: z.string().min(1).max(64).optional(),
    ...PresenceFilterShape,
  }).shape,
  outputSchema: z.object({
    sessions: z.array(AgentPresenceRowSchema),
    nextCursor: z.string().nullable(),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeAgentPresenceHandler(client: OrbotoClient) {
  return async (args: PresenceFilters & { projectKey?: string } = {}): Promise<CallToolResult> => {
    const { projectKey, ...filters } = args;
    const project = projectKey ?? filters.project;
    const res = await readPresence<{ inventory?: PresenceRow[]; nextCursor?: string | null }>(client, `/v1/agent/who?${presenceQuery({ ...filters, project }, { include: 'inventory' })}`, project);
    if (!res) return { content: [{ type: 'text', text: unknownProjectText(project!) }], structuredContent: { sessions: [], nextCursor: null } };
    const rows = res.inventory ?? [];
    const filtered = Object.entries(args).some(([key, value]) => key !== 'limit' && key !== 'cursor' && value !== undefined && value !== '');
    const lines = rows.length === 0
      ? [filtered ? 'No active agent session matches the filter.' : 'No active agent sessions in the workspace.']
      : [`${rows.length} active session(s)${res.nextCursor ? ' on this page' : ''}:`, ...rows.map(presenceLine), ...nextPageLine(res.nextCursor)];
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { sessions: rows.map(presenceRow), nextCursor: res.nextCursor ?? null },
    };
  };
}

/** ORB-2563 - mirror of AGENT_MESSAGE_PRIORITIES and the sender lines in @orboto/shared-schema agent-message-dedupe.ts (drift test in agent-coordination.test.ts). */
export const NOTIFY_PRIORITIES = ['normal', 'urgent'] as const;
export function repeatedSendNotice(repeatCount: number): string {
  return `already delivered (sent ${repeatCount} times), not sent again`;
}
export function reminderSentNotice(reminderCount: number, repeatCount: number): string {
  return `reminder ${reminderCount} sent (sent ${repeatCount} times)`;
}

/** ORB-2263 - mirror of AgentNotifyRoutedToSchema in @orboto/shared-schema (drift test in agent-coordination.test.ts). */
export const NOTIFY_ROUTED_TO = ['session', 'scope', 'account'] as const;

interface NotifyResponse {
  ok: true;
  messageId: string;
  toSessionId: string | null;
  routedTo?: (typeof NOTIFY_ROUTED_TO)[number];
  routingNote?: string;
  recipients?: Array<{ label: string; sessionId: string | null }>;
  queued?: boolean;
  hint?: string;
  ownerHint?: { ownerAddress: string; topic: string; target: string; routed: boolean; text: string };
  deduplicated?: boolean;
  repeatCount?: number;
  reminded?: boolean;
  reminderCount?: number;
  wakeable?: boolean;
}

interface NoRecipientBody {
  errorKey?: string;
  errorParams?: { address?: string; reason?: string; liveSessions?: Array<{ shortId: string; email: string; addresses: string[] }> };
}

/** ORB-2264 - the 409 `no_recipient` as a tool error naming who could receive it instead. */
export function noRecipientText(err: OrbotoApiError): string | null {
  if (err.status !== 409) return null;
  let body: NoRecipientBody;
  try { body = JSON.parse(err.body) as NoRecipientBody; } catch { return null; }
  if (body.errorKey !== 'errors.agents.no_recipient') return null;
  const p = body.errorParams ?? {};
  const live = (p.liveSessions ?? []).map((s) => `${s.addresses[0] ?? s.email} (${s.email}, ${s.shortId})`);
  const ways = 'a role address in `to` (integrator@KEY), `toSessionRef` with an instance short id, or `queue: true` with `project` (a role address needs no project) to keep it until a session declares the project or the role';
  if (p.reason === 'ambiguous_account') {
    return `not sent: ${p.address ?? 'that account'} has ${live.length} live sessions you may address and a request needs one of them. Sessions: ${live.join('; ')}. Send again with \`toSessionRef\` set to the instance short id of one, or address a role (${ways}).`;
  }
  return `not sent: no live session can receive a request to ${p.address ?? '?'} (${p.reason ?? 'no_recipient'}). `
    + (live.length ? `Live sessions: ${live.join('; ')}. ` : 'No live session answers there. ')
    + `Ways on: ${ways}.`;
}

/** ORB-2542 - the 409 `owner_mismatch` as a tool error naming the owner and both ways on. */
export function ownerMismatchText(err: OrbotoApiError): string | null {
  if (err.status !== 409) return null;
  let body: { errorKey?: string; errorParams?: { ownerHint?: { text?: string }; owner?: string; target?: string; topic?: string } };
  try { body = JSON.parse(err.body); } catch { return null; }
  if (body.errorKey !== 'errors.agents.owner_mismatch') return null;
  const p = body.errorParams ?? {};
  const text = p.ownerHint?.text ?? `"${p.topic ?? '?'}" belongs to ${p.owner ?? '?'}, not ${p.target ?? '?'}`;
  return `not sent: ${text}. Send again with route: true to deliver it to ${p.owner ?? 'the owner'}, or forceTarget: true to keep the target.`;
}

/** ORB-2563 - the 429 `reminder_too_soon` as a tool error naming when the next reminder is allowed. */
export function reminderTooSoonText(err: OrbotoApiError): string | null {
  if (err.status !== 429) return null;
  let body: { errorKey?: string; errorParams?: { messageId?: string; retryAfter?: number } };
  try { body = JSON.parse(err.body); } catch { return null; }
  if (body.errorKey !== 'errors.agents.reminder_too_soon') return null;
  return `not sent: message ${body.errorParams?.messageId ?? '?'} was sent or reminded too recently; the next reminder is allowed in ${body.errorParams?.retryAfter ?? '?'} seconds.`;
}

export const agentNotifyToolConfig = {
  title: 'Notify an agent or user',
  description:
    'Message an agent or user. `to` takes a role address integrator@KEY (every live session with that role on the project, any account), an account email or a session id; targetEmail names the account (with a role address it narrows to that account). kind: request|error = work inside the scope the recipient holds (request needs a target + outcome); info = information; complete = result (needs outcome). outcome: one sentence, 10 to 1000 characters; body: the plain text of the message (any length, lands in payload.body; payload may carry other JSON); threadId links a reply to the message it answers. toSessionRef (instance short id, session ref or id) reaches ONE session of the account; alone (no to, no targetEmail) a session id or short id addresses that session; project scopes an account message to sessions declared on it. A request to an account email without project or toSessionRef goes to its one live session, with several it is refused listing them (pick one with toSessionRef). A request no live session can receive is refused (no_recipient, naming the live sessions of the project; see orboto_who) unless queue: true holds it until a session declares the project; queued to a role address (worker@KEY) it waits for the first session that declares that role, and a queued request to an account address on the project of the owner address goes to the owner role. The answer names routedTo; routingNote "no session declared KEY" means nothing wakes - escalate. A request on a topic another role owns (orboto_who for) is refused; route: true sends it to the owner, forceTarget: true keeps the target. project is a key or UUID; senderRef defaults to this MCP session. An identical send (same recipient, project, kind, subject, payload; no threadId, no attachments) within the dedupe window (default 24 h) is not delivered again: the text says so and names the existing message. remind: true is a deliberate reminder of it (notifies again, at most one per 15 min, faster is refused with retryAfter); urgent: true is never suppressed and counts as a reminder. Loops and retries never set remind or urgent.',
  inputSchema: z.object({
    targetEmail: z.string().email().optional(),
    to: z.string().min(3).max(200).optional(),
    queue: z.boolean().optional(),
    kind: z.enum(['info', 'request', 'complete', 'error']).default('info'),
    subject: z.string().min(1).max(200),
    outcome: z.string().optional(),
    body: z.string().optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
    threadId: z.string().uuid().optional(),
    project: z.string().min(1).max(64).optional(),
    senderRef: z.string().min(1).max(128).optional(),
    toSessionRef: z.string().min(1).max(200).optional(),
    route: z.boolean().optional(),
    forceTarget: z.boolean().optional(),
    remind: z.boolean().optional(),
    urgent: z.boolean().optional(),
  }).shape,
  outputSchema: z.object({
    ok: z.literal(true),
    messageId: z.string().uuid(),
    toSessionId: z.string().uuid().nullable(),
    routedTo: z.enum(NOTIFY_ROUTED_TO),
    routingNote: z.string().optional(),
    recipients: z.array(z.string()).optional(),
    queued: z.boolean().optional(),
    owner: z.string().optional(),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};

export const agentBroadcastToolConfig = {
  title: 'Scoped broadcast to other agents',
  description:
    'Fan-out to every agent in a scope: workspace (all internal members), project (members of scopeId = project UUID) or topic (any string). Each recipient gets an inbox copy (orboto_messages, ackable); live subscribers also get a resources/updated push on orboto://broadcast/<scope>/<scope_id>. The scope replay keeps agent_broadcast_retention_days (default 7).',
  inputSchema: z.object({
    scopeType: z.enum(['workspace', 'project', 'topic']),
    scopeId: z.string().default(''),
    message: z.record(z.string(), z.unknown()),
  }).shape,
  outputSchema: z.object({ id: z.string().uuid() }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};

export function makeAgentBroadcastHandler(client: OrbotoClient) {
  return async (args: {
    scopeType: 'workspace' | 'project' | 'topic';
    scopeId?: string;
    message: Record<string, unknown>;
  }): Promise<CallToolResult> => {
    const res = await client.post<{ id: string }>('/v1/agent/broadcast', {
      scopeType: args.scopeType,
      scopeId: args.scopeId ?? '',
      message: args.message,
    });
    return {
      content: [{ type: 'text', text: `broadcast posted - id=${res.id}` }],
      structuredContent: { id: res.id },
    };
  };
}

export const NOTIFY_OUTCOME_MIN = 10;
export const NOTIFY_OUTCOME_MAX = 1000;
export const NOTIFY_BODY_MAX_BYTES = 900 * 1024;

/** ORB-2555 - a complete example call for a kind, the answer to every refusal. */
export function notifyExample(kind: string, to?: string): string {
  const target = to ?? 'integrator@KEY';
  switch (kind) {
    case 'request': return `orboto_agent_notify { to: "${target}", kind: "request", subject: "<one line>", outcome: "<what must be true when it is done>", body: "<details, any length>" }`;
    case 'complete': return `orboto_agent_notify { to: "${target}", kind: "complete", subject: "<one line>", outcome: "<what is now true>", threadId: "<message id answered>" }`;
    case 'error': return `orboto_agent_notify { to: "${target}", kind: "error", subject: "<one line>", body: "<what failed and what you tried>" }`;
    default: return `orboto_agent_notify { to: "${target}", kind: "info", subject: "<one line>", body: "<text>" }`;
  }
}

/** ORB-2223 - the message-kind definition this versioned sender enforces; the API only warns. ORB-2555 - every refusal names the flag and carries a complete example. */
export function notifyDefinitionError(args: { kind?: string; outcome?: string; body?: string; payload?: Record<string, unknown>; to?: string; targetEmail?: string; toSessionRef?: string }): string | null {
  const kind = args.kind ?? 'info';
  const example = (text: string) => `Invalid arguments: ${text} Example: ${notifyExample(kind, args.to)}`;
  if (!args.to && !args.targetEmail && !args.toSessionRef?.trim()) return example('name a recipient - `to` (integrator@KEY, an email or a session id), `targetEmail`, or `toSessionRef` (a session id or its short id).');
  const outcome = args.outcome?.trim() ?? '';
  if ((kind === 'request' || kind === 'complete') && !outcome) {
    return example(`\`outcome\` is required for a ${kind} - the outcome sentence (what must be true when it is done, or what was delivered), ${NOTIFY_OUTCOME_MIN} to ${NOTIFY_OUTCOME_MAX} characters.`);
  }
  if (outcome && outcome.length < NOTIFY_OUTCOME_MIN) return example(`\`outcome\` has ${outcome.length} characters, at least ${NOTIFY_OUTCOME_MIN} are needed.`);
  if (outcome.length > NOTIFY_OUTCOME_MAX) {
    return example(`\`outcome\` has ${outcome.length} characters, at most ${NOTIFY_OUTCOME_MAX} are allowed: keep the outcome to one sentence and put the long text into \`body\` (any length, it lands in payload.body).`);
  }
  if (args.body !== undefined && !args.body.trim()) return example('`body` is empty - give the text or leave it out.');
  if (args.body !== undefined && args.payload && 'body' in args.payload) return example('`body` and `payload.body` are both set - use one of them.');
  const bodyBytes = args.body === undefined ? 0 : Buffer.byteLength(args.body.replace(/[\r\n]+$/, ''));
  if (bodyBytes > NOTIFY_BODY_MAX_BYTES) return example(`\`body\` has ${bodyBytes} bytes, at most ${NOTIFY_BODY_MAX_BYTES} (900 KiB) are allowed: split it into several messages or attach a file with the CLI.`);
  return null;
}

export function makeAgentNotifyHandler(client: OrbotoClient) {
  return async (args: {
    targetEmail?: string;
    to?: string;
    queue?: boolean;
    kind?: 'info' | 'request' | 'complete' | 'error';
    subject: string;
    outcome?: string;
    body?: string;
    payload?: Record<string, unknown>;
    threadId?: string;
    project?: string;
    senderRef?: string;
    toSessionRef?: string;
    route?: boolean;
    forceTarget?: boolean;
    remind?: boolean;
    urgent?: boolean;
  }, extra?: unknown): Promise<CallToolResult> => {
    const invalid = notifyDefinitionError(args);
    if (invalid) return { isError: true, content: [{ type: 'text', text: invalid }] };
    const senderRef = mcpInstanceToken(args.senderRef, extra as { sessionId?: string } | undefined);
    let res: NotifyResponse;
    try {
      const { urgent, body, ...rest } = args;
      const payload = body !== undefined ? { ...(rest.payload ?? {}), body: body.replace(/[\r\n]+$/, '') } : rest.payload;
      res = await client.post<NotifyResponse>('/v1/agent/notify', { ...rest, ...(payload ? { payload } : {}), ...(urgent ? { priority: NOTIFY_PRIORITIES[1] } : {}), senderRef, ownerCheck: 'refuse' }, { instanceToken: mcpInstanceToken(undefined, extra as { sessionId?: string } | undefined) });
    } catch (err) {
      const refused = err instanceof OrbotoApiError ? noRecipientText(err) ?? ownerMismatchText(err) ?? reminderTooSoonText(err) : null;
      if (refused) return { isError: true, content: [{ type: 'text', text: refused }] };
      throw err;
    }
    const who = res.ownerHint?.routed ? res.ownerHint.ownerAddress : args.to ?? args.targetEmail ?? '?';
    const recipients = (res.recipients ?? []).map((r) => r.label);
    const sessionOnly = !res.ownerHint?.routed && !args.to && !args.targetEmail;
    const target = recipients.length > 1 ? recipients.join(', ') : res.toSessionId ? `${sessionOnly ? '' : `${who} `}session ${res.toSessionId.slice(0, 8)}` : who;
    const routedTo = res.routedTo ?? (res.toSessionId ? 'session' : 'account');
    const note = res.routingNote ? ` - ${res.routingNote}` : '';
    if (res.deduplicated) {
      const repeats = res.repeatCount ?? 2;
      const line = res.reminded ? reminderSentNotice(res.reminderCount ?? 1, repeats) : repeatedSendNotice(repeats);
      return {
        content: [{ type: 'text', text: `${line}: ${target} (message ${res.messageId})` }],
        structuredContent: {
          ok: true, messageId: res.messageId, toSessionId: res.toSessionId ?? null, routedTo,
        },
      };
    }
    return {
      content: [{ type: 'text', text: `${res.queued ? 'queued for' : 'notified'} ${target} (message ${res.messageId}, routed to ${routedTo}${note})${res.ownerHint?.routed ? `\nrouted to the owner of "${res.ownerHint.topic}" instead of ${res.ownerHint.target}` : ''}${res.hint ? `\nhint: ${res.hint}` : ''}` }],
      structuredContent: {
        ok: true, messageId: res.messageId, toSessionId: res.toSessionId ?? null, routedTo,
        ...(res.routingNote ? { routingNote: res.routingNote } : {}),
        ...(recipients.length ? { recipients } : {}),
        ...(res.queued ? { queued: true } : {}),
        ...(res.ownerHint?.routed ? { owner: res.ownerHint.ownerAddress } : {}),
        ...(res.wakeable !== undefined ? { wakeable: res.wakeable } : {}),
      },
    };
  };
}

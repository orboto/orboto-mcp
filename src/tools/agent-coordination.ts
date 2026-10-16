/**
 * ORB-705 - MCP coordination tools.
 *
 * @see ORB-704, ORB-706
 */
import { z } from 'zod';
import { AgentInventoryEntrySchema, AgentInventoryKindSchema, type AgentInventoryEntry } from './agent-presence-schema.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OrbotoApiError, type OrbotoClient } from '../orboto-client.js';
import { mcpInstanceToken } from './shared.js';
import { AgentSessionScopeSchema, type AgentSessionScope } from './agent-session-scope.js';

interface HeartbeatResponse {
  sessionToken: string;
  sessionId: string;
  scope: AgentSessionScope | null;
  startedBy?: string | null;
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
    capabilities: z.array(z.string()).optional(),
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
    const res = await client.post<HeartbeatResponse>('/v1/agent/heartbeat', args, { instanceToken: mcpInstanceToken(undefined, extra as { sessionId?: string } | undefined) });
    const scope = res.scope ? ` scope=${JSON.stringify(res.scope)}` : '';
    return {
      content: [{ type: 'text', text: `heartbeat ack - sessionToken=${res.sessionToken.slice(0, 8)}… session ${res.sessionId.slice(0, 8)}${scope}` }],
      structuredContent: { sessionToken: res.sessionToken, sessionId: res.sessionId, scope: res.scope ?? null, ...(res.startedBy !== undefined ? { startedBy: res.startedBy } : {}) },
    };
  };
}

type PresenceRow = AgentInventoryEntry & { origin?: SessionOrigin; state?: string };

/** ORB-2544 - where a session runs and its state, as one directory phrase; empty when the instance predates the origin. */
export interface SessionOrigin { host: string | null; repo: string | null; pid: number | null; client: string | null; clientVersion: string | null; harness: string | null; startedAt: string | null }
export function originText(s: { origin?: SessionOrigin; state?: string }): string {
  if (!s.origin) return '';
  const o = s.origin;
  const where = [o.host ?? 'unknown host', o.repo, o.pid ? `pid ${o.pid}` : null, o.harness, o.client ? `${o.client}${o.clientVersion ? ` ${o.clientVersion}` : ''}` : null].filter(Boolean).join(' ');
  return ` [${s.state ?? 'live'}] on ${where}${o.startedAt ? ` since ${o.startedAt}` : ''}`;
}

export const agentPresenceToolConfig = {
  title: 'Workspace agent presence',
  description:
    'Active agent instances. The orboto_who set: lane workers and reviewers, inbox, MCP and runner connections; rows carry kind (agent | human, by credential; isBot is its alias), actsAs, owner, projects, connections, lane, sessionId, userEmail, runtime (clientInfo.name), capabilities, status, current ticket, reconnects, origin (host, repo, pid, client, harness, credential) and state (live | quiet | orphaned | unknown_origin). Operators (admin:agents:read or admin:system:read) see the workspace, others their own sessions and those declared on their projects, a foreign row redacted (redacted: true, no pid, repo, machine, connections, inbox or owner). Check it before dispatching a sub-task. projectKey and kind filter client-side like `orboto agents --project KEY --bots|--humans`.',
  inputSchema: z.object({
    projectKey: z.string().min(1).max(64).optional().describe('Keep only rows whose projects contain this project key (case-insensitive).'),
    kind: AgentInventoryKindSchema.optional().describe('Keep only rows classified as agent or human by their credential.'),
  }).shape,
  outputSchema: z.object({
    sessions: z.array(AgentInventoryEntrySchema),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

/** Client-side view filter (ORB-2135); the inventory route stays unfiltered and the chat mirror applies the same rule. */
export function filterPresenceRows<T extends Pick<AgentInventoryEntry, 'kind' | 'projects'>>(rows: T[], args: { projectKey?: string; kind?: 'agent' | 'human' }): T[] {
  const key = args.projectKey?.trim().toUpperCase();
  return rows.filter((row) => (!args.kind || row.kind === args.kind) && (!key || row.projects.some((p) => p.key.toUpperCase() === key)));
}

export function makeAgentPresenceHandler(client: OrbotoClient) {
  return async (args: { projectKey?: string; kind?: 'agent' | 'human' } = {}): Promise<CallToolResult> => {
    const all = (await client.get<{ inventory?: PresenceRow[] }>('/v1/agent/who?include=inventory')).inventory ?? [];
    const sessions = filterPresenceRows(all, args);
    const lines: string[] = [];
    if (sessions.length === 0) {
      lines.push(all.length === 0 ? 'No active agent sessions in the workspace.' : `No active agent sessions match the filter (${all.length} active in the workspace).`);
    } else {
      lines.push(`${sessions.length} active session(s):`);
      for (const s of sessions) {
        const name = s.userFullName ?? s.userEmail;
        const runtime = s.clientInfo.name ?? 'unknown';
        const work = s.workingOnTicket
          ? ` · working on [${s.workingOnTicket.projectKey ?? '?'}] ${s.workingOnTicket.key ?? s.workingOnTicket.id} (${s.workingOnTicket.title})`
          : '';
        lines.push(`- ${name} <${s.userEmail}> (${runtime}, instance ${s.sessionId}) - ${s.status}${originText(s)}${work}; owner: ${s.owner?.name ?? s.owner?.email ?? (s.actsAs ? `acts as ${s.actsAs.name ?? s.actsAs.email}` : s.kind === 'agent' ? 'unassigned' : 'self')}${s.lane ? `; lane: ${s.lane.name}` : ''}${s.projects.length ? `; projects: ${s.projects.map((p) => p.key).join(', ')}` : ''}${s.connections.length ? `; connections: ${s.connections.map((c) => c.type).join(', ')}` : ''}`);
      }
    }
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { sessions },
    };
  };
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
  return `not sent: no live session can receive a request to ${p.address ?? '?'} (${p.reason ?? 'no_recipient'}). `
    + (live.length ? `Live sessions: ${live.join('; ')}. ` : 'No live session declared the project. ')
    + 'Address one of them, or send again with queue: true and project to keep it until a session declares the project.';
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

export const agentNotifyToolConfig = {
  title: 'Notify an agent or user',
  description:
    'Message an agent or user. `to` takes a role address integrator@KEY (every live session with that role on the project, any account), an account email or a session id; targetEmail names the account (with a role address it narrows to that account). kind: request|error = work inside the scope the recipient holds (request needs a target + outcome); info = information; complete = result (needs outcome). payload: free-form JSON; threadId links a reply to the message it answers. toSessionRef (instance short id, session ref or id) reaches ONE session of the account; project scopes an account message to sessions declared on it. A request no live session can receive is refused (no_recipient, naming the live sessions of the project; see orboto_who) unless queue: true holds it until a session declares the project. The answer names routedTo; routingNote "no session declared KEY" means nothing wakes - escalate. A request on a topic another role owns (orboto_who for) is refused; route: true sends it to the owner, forceTarget: true keeps the target. project is a key or UUID; senderRef defaults to this MCP session.',
  inputSchema: z.object({
    targetEmail: z.string().email().optional(),
    to: z.string().min(3).max(200).optional(),
    queue: z.boolean().optional(),
    kind: z.enum(['info', 'request', 'complete', 'error']).default('info'),
    subject: z.string().min(1).max(200),
    outcome: z.string().min(10).max(1000).optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
    threadId: z.string().uuid().optional(),
    project: z.string().min(1).max(64).optional(),
    senderRef: z.string().min(1).max(128).optional(),
    toSessionRef: z.string().min(1).max(200).optional(),
    route: z.boolean().optional(),
    forceTarget: z.boolean().optional(),
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

/** ORB-2223 - the message-kind definition this versioned sender enforces; the API only warns. */
export function notifyDefinitionError(args: { kind?: string; outcome?: string; project?: string; toSessionRef?: string; to?: string; targetEmail?: string }): string | null {
  const kind = args.kind ?? 'info';
  if (!args.to && !args.targetEmail) return 'Invalid arguments: name a recipient - `to` (integrator@KEY, an email or a session id) or `targetEmail`.';
  if ((kind === 'request' || kind === 'complete') && !args.outcome?.trim()) {
    return `Invalid arguments: \`outcome\` is required for a ${kind} - the outcome sentence (what must be true when it is done, or what was delivered).`;
  }
  if (kind === 'request' && !args.project && !args.toSessionRef && !(args.to && !args.to.includes('.'))) {
    return 'Invalid arguments: a request needs a target - a role address in `to` (integrator@KEY), `project` (key or UUID) or `toSessionRef`.';
  }
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
    payload?: Record<string, unknown>;
    threadId?: string;
    project?: string;
    senderRef?: string;
    toSessionRef?: string;
    route?: boolean;
    forceTarget?: boolean;
  }, extra?: unknown): Promise<CallToolResult> => {
    const invalid = notifyDefinitionError(args);
    if (invalid) return { isError: true, content: [{ type: 'text', text: invalid }] };
    const senderRef = mcpInstanceToken(args.senderRef, extra as { sessionId?: string } | undefined);
    let res: NotifyResponse;
    try {
      res = await client.post<NotifyResponse>('/v1/agent/notify', { ...args, senderRef, ownerCheck: 'refuse' }, { instanceToken: mcpInstanceToken(undefined, extra as { sessionId?: string } | undefined) });
    } catch (err) {
      const refused = err instanceof OrbotoApiError ? noRecipientText(err) ?? ownerMismatchText(err) : null;
      if (refused) return { isError: true, content: [{ type: 'text', text: refused }] };
      throw err;
    }
    const who = res.ownerHint?.routed ? res.ownerHint.ownerAddress : args.to ?? args.targetEmail ?? '?';
    const recipients = (res.recipients ?? []).map((r) => r.label);
    const target = recipients.length > 1 ? recipients.join(', ') : res.toSessionId ? `${who} session ${res.toSessionId.slice(0, 8)}` : who;
    const routedTo = res.routedTo ?? (res.toSessionId ? 'session' : 'account');
    const note = res.routingNote ? ` - ${res.routingNote}` : '';
    return {
      content: [{ type: 'text', text: `${res.queued ? 'queued for' : 'notified'} ${target} (message ${res.messageId}, routed to ${routedTo}${note})${res.ownerHint?.routed ? `\nrouted to the owner of "${res.ownerHint.topic}" instead of ${res.ownerHint.target}` : ''}${res.hint ? `\nhint: ${res.hint}` : ''}` }],
      structuredContent: {
        ok: true, messageId: res.messageId, toSessionId: res.toSessionId ?? null, routedTo,
        ...(res.routingNote ? { routingNote: res.routingNote } : {}),
        ...(recipients.length ? { recipients } : {}),
        ...(res.queued ? { queued: true } : {}),
        ...(res.ownerHint?.routed ? { owner: res.ownerHint.ownerAddress } : {}),
      },
    };
  };
}

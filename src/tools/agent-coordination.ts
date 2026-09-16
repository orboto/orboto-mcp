/**
 * ORB-705 - MCP coordination tools.
 *
 * @see ORB-704, ORB-706
 */
import { z } from 'zod';
import { AgentInventoryEntrySchema, AgentInventoryKindSchema, type AgentInventoryEntry } from './agent-presence-schema.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';
import { mcpInstanceToken } from './shared.js';

interface HeartbeatResponse {
  sessionToken: string;
  sessionId: string;
}

export const agentHeartbeatToolConfig = {
  title: 'Agent heartbeat (Multi-Agent Coordination)',
  description:
    'Register or refresh this agent\'s presence with status detail. A live connection already counts as online (an open MCP event stream, `orboto messages --follow`, the agent WebSocket) - the heartbeat adds status: idle (default) | working (+workingOnTicketId) | blocked, capabilities (free-form strings for operator filters) and clientInfo.name (the runtime), and is the only presence path for turn-based clients without a standing connection. Rows older than 90 s count as offline; persist the returned sessionToken and send it on later heartbeats.',
  inputSchema: z.object({
    sessionToken: z.string().nullable().optional(),
    status: z.enum(['idle', 'working', 'blocked']).optional(),
    workingOnTicketId: z.string().uuid().nullable().optional(),
    capabilities: z.array(z.string()).optional(),
    clientInfo: z.object({
      name: z.string().optional(),
      version: z.string().optional(),
      host: z.string().optional(),
      user_agent: z.string().optional(),
    }).optional(),
  }).shape,
  outputSchema: z.object({
    sessionToken: z.string(),
    sessionId: z.string().uuid(),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
};

export function makeAgentHeartbeatHandler(client: OrbotoClient) {
  return async (
    args: {
      sessionToken?: string | null;
      status?: 'idle' | 'working' | 'blocked';
      workingOnTicketId?: string | null;
      capabilities?: string[];
      clientInfo?: { name?: string; version?: string; host?: string; user_agent?: string };
    },
  ): Promise<CallToolResult> => {
    const res = await client.post<HeartbeatResponse>('/v1/agent/heartbeat', args);
    return {
      content: [{ type: 'text', text: `heartbeat ack - sessionToken=${res.sessionToken.slice(0, 8)}…` }],
      structuredContent: { sessionToken: res.sessionToken, sessionId: res.sessionId },
    };
  };
}

type PresenceRow = AgentInventoryEntry;

export const agentPresenceToolConfig = {
  title: 'Workspace agent presence',
  description:
    'Returns all active orboto agent instances, including lane workers/reviewers, inbox and MCP connections and registered runners. Session freshness is 90 seconds; lanes retain their 300-second heartbeat grace. Unexpired work leases keep their owning instance visible. Ticket metadata and claims retain ordinary ticket visibility. Rows include `kind` (agent or human, classified by the credential: agent API key, OAuth grant, lane, external token or bot account; `isBot` is its alias), `actsAs` (the human account an AI client acts under), `projects` (memberships plus lane projects), `connections` (type + label per credential or attachment, `live_events` for the MCP event bridge), owner, lane and stable sessionId; separate instances of one account remain separate. Callers with admin:system:read see every agent; other users see only their own sessions (useful for "is my dispatcher daemon alive?" checks). Each row exposes `userId`, `userEmail`, the agent runtime (`clientInfo.name`), declared `capabilities`, current `status`, and the ticket the agent is working on if any. Use this to plan multi-agent work - e.g. before dispatching a sub-task, look up which other agents are active and what they\'re working on so you don\'t step on a parallel run. Filters `projectKey` (rows whose `projects` contain the key) and `kind` (agent | human) narrow the list client-side, the same way `orboto agents --project KEY --bots|--humans` does.',
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
    const all = await client.get<PresenceRow[]>('/v1/agent/inventory');
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
        lines.push(`- ${name} <${s.userEmail}> (${runtime}, instance ${s.sessionId}) - ${s.status}${work}; owner: ${s.owner?.name ?? s.owner?.email ?? (s.actsAs ? `acts as ${s.actsAs.name ?? s.actsAs.email}` : s.kind === 'agent' ? 'unassigned' : 'self')}${s.lane ? `; lane: ${s.lane.name}` : ''}${s.projects.length ? `; projects: ${s.projects.map((p) => p.key).join(', ')}` : ''}${s.connections.length ? `; connections: ${s.connections.map((c) => c.type).join(', ')}` : ''}`);
      }
    }
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { sessions },
    };
  };
}

interface NotifyResponse {
  ok: true;
  messageId: string;
}

export const agentNotifyToolConfig = {
  title: 'Notify another agent / user',
  description:
    'Send a fire-and-forget message to a user (bot or human) by email; it lands in their inbox (orboto_messages) and, for humans, in-app. kind: info | request (answer expected) | complete (sub-task done) | error. payload: free-form JSON; threadId links a reply to the message it answers.',
  inputSchema: z.object({
    targetEmail: z.string().email(),
    kind: z.enum(['info', 'request', 'complete', 'error']).default('info'),
    subject: z.string().min(1).max(200),
    payload: z.record(z.string(), z.unknown()).optional(),
    threadId: z.string().uuid().optional(),
    project: z.string().min(1).max(64).optional().describe('Project key or UUID: scope the message to the recipient session working that project.'),
    senderRef: z.string().min(1).max(128).optional().describe('Sender-session ref for self-echo exclusion; defaults to this MCP session.'),
  }).shape,
  outputSchema: z.object({
    ok: z.literal(true),
    messageId: z.string().uuid(),
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

export function makeAgentNotifyHandler(client: OrbotoClient) {
  return async (args: {
    targetEmail: string;
    kind?: 'info' | 'request' | 'complete' | 'error';
    subject: string;
    payload?: Record<string, unknown>;
    threadId?: string;
    project?: string;
    senderRef?: string;
  }, extra?: unknown): Promise<CallToolResult> => {
    const senderRef = mcpInstanceToken(args.senderRef, extra as { sessionId?: string } | undefined);
    const res = await client.post<NotifyResponse>('/v1/agent/notify', { ...args, senderRef });
    return {
      content: [{ type: 'text', text: `notified ${args.targetEmail} (message ${res.messageId} - delivered live if connected, waits in their inbox otherwise)` }],
      structuredContent: { ok: true, messageId: res.messageId },
    };
  };
}

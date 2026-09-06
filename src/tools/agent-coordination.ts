/**
 * ORB-705 - MCP coordination tools.
 *
 * Three tools layered on the ORB-704 REST surface:
 *   orboto_agent_heartbeat - wraps POST /v1/agent/heartbeat. Returns
 *     the sessionToken the agent persists for next call.
 *   orboto_agent_presence - wraps GET /v1/agent/presence. Returns
 *     active sessions visible to the caller (own only for non-admin,
 *     workspace-wide for super-admin).
 *   orboto_agent_notify - wraps the existing notification surface
 *     to dispatch a directed message to another agent / user.
 *     Routing target is identified by email (works for both bots and
 *     humans). Fire-and-forget; the recipient sees it via the
 *     standard notifications channel (ORB-706 wires the bridge).
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';
import { mcpInstanceToken } from './shared.js';

// ---------------------------------------------------------------------------
// orboto_agent_heartbeat
// ---------------------------------------------------------------------------

interface HeartbeatResponse {
  sessionToken: string;
  sessionId: string;
}

export const agentHeartbeatToolConfig = {
  title: 'Agent heartbeat (Multi-Agent Coordination)',
  description:
    'Register or refresh this agent\'s presence. Call on startup and every ~30 s; rows older than 90 s count as offline. Persist the returned sessionToken and send it on later heartbeats. status: idle (default) | working (+workingOnTicketId) | blocked. capabilities: free-form strings for operator filters. clientInfo.name = the runtime (claude-code, cursor, ...).',
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

// ---------------------------------------------------------------------------
// orboto_agent_presence
// ---------------------------------------------------------------------------

interface PresenceRow {
  userId: string;
  userEmail: string;
  userFullName: string | null;
  sessionId: string;
  status: string;
  workingOnTicket: { id: string; key: string | null; title: string; projectKey: string | null } | null;
  capabilities: string[];
  clientInfo: { name?: string; version?: string; host?: string; user_agent?: string };
  lastSeenAt: string;
  createdAt: string;
}

export const agentPresenceToolConfig = {
  title: 'Workspace agent presence',
  description:
    'Returns currently-active agent sessions in the workspace. Active = heartbeat within the last 90 s. Super-admins see every agent; regular users see only their own sessions (useful for "is my dispatcher daemon alive?" checks). Each row exposes `userId`, `userEmail`, the agent runtime (`clientInfo.name`), declared `capabilities`, current `status`, and the ticket the agent is working on if any. Use this to plan multi-agent work - e.g. before dispatching a sub-task, look up which other agents are active and what they\'re working on so you don\'t step on a parallel run.',
  inputSchema: z.object({}).shape,
  outputSchema: z.object({
    sessions: z.array(z.object({
      userId: z.string().uuid(),
      userEmail: z.string(),
      userFullName: z.string().nullable(),
      sessionId: z.string().uuid(),
      status: z.string(),
      workingOnTicket: z.object({
        id: z.string().uuid(),
        key: z.string().nullable(),
        title: z.string(),
        projectKey: z.string().nullable(),
      }).nullable(),
      capabilities: z.array(z.string()),
      clientInfo: z.record(z.string(), z.string()),
      lastSeenAt: z.string(),
      createdAt: z.string(),
    })),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeAgentPresenceHandler(client: OrbotoClient) {
  return async (): Promise<CallToolResult> => {
    const sessions = await client.get<PresenceRow[]>('/v1/agent/presence');
    const lines: string[] = [];
    if (sessions.length === 0) {
      lines.push('No active agent sessions in the workspace.');
    } else {
      lines.push(`${sessions.length} active session(s):`);
      for (const s of sessions) {
        const name = s.userFullName ?? s.userEmail;
        const runtime = s.clientInfo.name ?? 'unknown';
        const work = s.workingOnTicket
          ? ` · working on [${s.workingOnTicket.projectKey ?? '?'}] ${s.workingOnTicket.key ?? s.workingOnTicket.id} (${s.workingOnTicket.title})`
          : '';
        lines.push(`- ${name} (${runtime}) - ${s.status}${work}`);
      }
    }
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { sessions },
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_agent_notify
// ---------------------------------------------------------------------------

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
    // ORB-1727 - reply chaining: the id of the inbox message being answered.
    threadId: z.string().uuid().optional(),
    // ORB-1732 - optional project scope: address "the agent working project
    // X" when the recipient identity runs multiple sessions.
    project: z.string().min(1).max(64).optional().describe('Project key or UUID: scope the message to the recipient session working that project.'),
    // ORB-1742 - defaults to this MCP session's instance token so a shared
    // identity never wakes itself with its own outbound mail.
    senderRef: z.string().min(1).max(128).optional().describe('Sender-session ref for self-echo exclusion; defaults to this MCP session.'),
  }).shape,
  outputSchema: z.object({
    ok: z.literal(true),
    messageId: z.string().uuid(),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};

// ---------------------------------------------------------------------------
// orboto_agent_broadcast (ORB-964)
// ---------------------------------------------------------------------------

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
    // ORB-1742 - stamp the sender session automatically.
    const senderRef = mcpInstanceToken(args.senderRef, extra as { sessionId?: string } | undefined);
    const res = await client.post<NotifyResponse>('/v1/agent/notify', { ...args, senderRef });
    return {
      // ORB-1727 - the message is durable now: it reaches the recipient's
      // inbox even when they are offline (delivery via the pending-mail
      // pointer on their next tool call).
      content: [{ type: 'text', text: `notified ${args.targetEmail} (message ${res.messageId} - delivered live if connected, waits in their inbox otherwise)` }],
      structuredContent: { ok: true, messageId: res.messageId },
    };
  };
}

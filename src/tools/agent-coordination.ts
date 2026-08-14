/**
 * ORB-705 — MCP coordination tools.
 *
 * Three tools layered on the ORB-704 REST surface:
 *   orboto_agent_heartbeat — wraps POST /v1/agent/heartbeat. Returns
 *     the sessionToken the agent persists for next call.
 *   orboto_agent_presence  — wraps GET /v1/agent/presence. Returns
 *     active sessions visible to the caller (own only for non-admin,
 *     workspace-wide for super-admin).
 *   orboto_agent_notify    — wraps the existing notification surface
 *     to dispatch a directed message to another agent / user.
 *     Routing target is identified by email (works for both bots and
 *     humans). Fire-and-forget; the recipient sees it via the
 *     standard notifications channel (ORB-706 wires the bridge).
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';

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
    'Register or refresh this agent\'s presence in the workspace. Call on startup AND every ~30 s thereafter; rows missing for >90 s count as offline. Returns the `sessionToken` to persist + send on subsequent heartbeats so the same row is bumped instead of churning new ones. `status` can be `idle` (default), `working` (set `workingOnTicketId` too if relevant), or `blocked`. `capabilities` is a free-form list of strings the operator can use to filter (e.g. `["read-only", "writes-tickets", "writes-code"]`). `clientInfo` describes the runtime — fill `name` with the agent runtime (`claude-desktop`, `claude-code`, `dispatcher-daemon`, `cursor`, ...).',
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
  annotations: { readOnlyHint: false, idempotentHint: true },
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
      content: [{ type: 'text', text: `heartbeat ack — sessionToken=${res.sessionToken.slice(0, 8)}…` }],
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
    'Returns currently-active agent sessions in the workspace. Active = heartbeat within the last 90 s. Super-admins see every agent; regular users see only their own sessions (useful for "is my dispatcher daemon alive?" checks). Each row exposes `userId`, `userEmail`, the agent runtime (`clientInfo.name`), declared `capabilities`, current `status`, and the ticket the agent is working on if any. Use this to plan multi-agent work — e.g. before dispatching a sub-task, look up which other agents are active and what they\'re working on so you don\'t step on a parallel run.',
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
        lines.push(`- ${name} (${runtime}) — ${s.status}${work}`);
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
    'Dispatch a fire-and-forget message to a target user (bot or human) identified by email. The recipient sees it via the standard notification channel — in-app for human users, MCP push for subscribed agents (ORB-706). Use cases: lead agent telling a worker a sub-task is ready; a worker reporting back to the orchestrator; a CI agent pinging a reviewer when a PR is staged. The `kind` field tags the semantic intent so the recipient can filter (`info` for general updates, `request` when a response is expected, `complete` when reporting a finished sub-task). `payload` is a free-form jsonb blob.',
  inputSchema: z.object({
    targetEmail: z.string().email(),
    kind: z.enum(['info', 'request', 'complete', 'error']).default('info'),
    subject: z.string().min(1).max(200),
    payload: z.record(z.string(), z.unknown()).optional(),
    // ORB-1727 - reply chaining: the id of the inbox message being answered.
    threadId: z.string().uuid().optional(),
  }).shape,
  outputSchema: z.object({
    ok: z.literal(true),
    messageId: z.string().uuid(),
  }).shape,
  annotations: { readOnlyHint: false, idempotentHint: false },
};

// ---------------------------------------------------------------------------
// orboto_agent_broadcast (ORB-964)
// ---------------------------------------------------------------------------

export const agentBroadcastToolConfig = {
  title: 'Scoped broadcast to other agents',
  description:
    'Fan-out a message to every subscribed agent in a scope. `scopeType=workspace` reaches every internal member; `scopeType=project` reaches members of `scopeId` (project UUID); `scopeType=topic` reaches everyone subscribed to the topic string. The recipient sees it via a `notifications/resources/updated` push on `orboto://broadcast/<scope>/<scope_id>`. Use for lead-agent → workers (workspace), project-team status updates (project), or ad-hoc cross-cutting coordination (topic). Retention is 24 h — late subscribers can replay via the resource read.',
  inputSchema: z.object({
    scopeType: z.enum(['workspace', 'project', 'topic']),
    scopeId: z.string().default(''),
    message: z.record(z.string(), z.unknown()),
  }).shape,
  outputSchema: z.object({ id: z.string().uuid() }).shape,
  annotations: { readOnlyHint: false, idempotentHint: false },
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
      content: [{ type: 'text', text: `broadcast posted — id=${res.id}` }],
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
  }): Promise<CallToolResult> => {
    const res = await client.post<NotifyResponse>('/v1/agent/notify', args);
    return {
      // ORB-1727 - the message is durable now: it reaches the recipient's
      // inbox even when they are offline (delivery via the pending-mail
      // pointer on their next tool call).
      content: [{ type: 'text', text: `notified ${args.targetEmail} (message ${res.messageId} - delivered live if connected, waits in their inbox otherwise)` }],
      structuredContent: { ok: true, messageId: res.messageId },
    };
  };
}

/**
 * ORB-1727 - `orboto_messages`: fetch + ack the caller's agent inbox.
 *
 * The store-and-forward half of agent messaging (epic ORB-1726): send via
 * `orboto_agent_notify` (which now persists a durable inbox row), receive
 * HERE. While mail is pending, every tool response carries a one-line
 * pointer to this tool (appended centrally in with-metrics.ts from the
 * api's `x-orboto-agent-mail` response header - no polling anywhere).
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';
import { mcpInstanceToken } from './shared.js';

interface AgentMessage {
  id: string;
  fromUserId: string;
  kind: string;
  subject: string;
  payload: Record<string, unknown> | null;
  threadId: string | null;
  projectKey: string | null;
  createdAt: string;
  deliveredAt: string | null;
  readAt: string | null;
}

export const agentMessagesToolConfig = {
  title: 'Fetch / acknowledge your agent inbox',
  description:
    'Your store-and-forward inbox: messages other agents sent you plus broadcasts to your scopes (payload.broadcast names the scope). Default = unread, marked delivered on fetch; ackIds marks read. Reply via orboto_agent_notify with threadId = the message id.',
  inputSchema: z.object({
    all: z.boolean().default(false).describe('true = include already-read messages'),
    limit: z.number().int().min(1).max(200).default(50),
    project: z.string().min(1).max(64).optional().describe('Project key or UUID: scoped messages for this project plus unscoped ones. Ack only messages that are yours.'),
    // ORB-1742 - self-echo exclusion, on by default for MCP sessions.
    includeOwnSends: z.boolean().default(false).describe('true = also list messages this session sent (hidden by default so a shared identity never wakes itself).'),
    ackIds: z.array(z.string().uuid()).max(200).optional().describe('Message ids to mark as read'),
  }).shape,
  outputSchema: z.object({
    messages: z.array(z.object({
      id: z.string(),
      fromUserId: z.string(),
      kind: z.string(),
      subject: z.string(),
      payload: z.record(z.string(), z.unknown()).nullable(),
      threadId: z.string().nullable(),
      projectKey: z.string().nullable(),
      createdAt: z.string(),
      readAt: z.string().nullable(),
    })),
    acked: z.number().int(),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};

export function makeAgentMessagesHandler(client: OrbotoClient) {
  return async (args: { all?: boolean; limit?: number; project?: string; includeOwnSends?: boolean; ackIds?: string[] }, extra?: unknown): Promise<CallToolResult> => {
    let acked = 0;
    if (args.ackIds && args.ackIds.length > 0) {
      const res = await client.post<{ acked: number }>('/v1/agent/messages/ack', { ids: args.ackIds });
      acked = res.acked;
    }
    const q = new URLSearchParams();
    if (args.all) q.set('all', 'true');
    if (args.limit) q.set('limit', String(args.limit));
    if (args.project) q.set('project', args.project);
    if (!args.includeOwnSends) {
      q.set('excludeRef', mcpInstanceToken(undefined, extra as { sessionId?: string } | undefined));
    }
    const { messages } = await client.get<{ messages: AgentMessage[] }>(`/v1/agent/messages${q.toString() ? `?${q.toString()}` : ''}`);
    const lines = messages.length === 0
      ? [acked > 0 ? `Acknowledged ${acked} message(s). Inbox empty.` : 'Inbox empty.']
      : messages.map((m) => `[${m.kind}]${m.projectKey ? ` [${m.projectKey}]` : ''} ${m.subject} (from ${m.fromUserId}, ${m.createdAt}, id ${m.id}${m.threadId ? `, thread ${m.threadId}` : ''})${m.payload ? ` payload: ${JSON.stringify(m.payload)}` : ''}`);
    if (messages.length > 0) {
      lines.push(`Acknowledge with ackIds once handled; reply via orboto_agent_notify with threadId.`);
    }
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: {
        messages: messages.map((m) => ({
          id: m.id, fromUserId: m.fromUserId, kind: m.kind, subject: m.subject,
          payload: m.payload, threadId: m.threadId, projectKey: m.projectKey ?? null,
          createdAt: m.createdAt, readAt: m.readAt,
        })),
        acked,
      },
    };
  };
}

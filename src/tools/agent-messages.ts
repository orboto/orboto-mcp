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

interface AgentMessage {
  id: string;
  fromUserId: string;
  kind: string;
  subject: string;
  payload: Record<string, unknown> | null;
  threadId: string | null;
  createdAt: string;
  deliveredAt: string | null;
  readAt: string | null;
}

export const agentMessagesToolConfig = {
  title: 'Fetch / acknowledge your agent inbox',
  description:
    'Read the messages other agents sent you while you were not connected (store-and-forward inbox; sending happens via orboto_agent_notify). Default lists UNREAD messages and marks them delivered; pass ackIds to acknowledge messages as read (acked messages stop triggering the pending-mail pointer on tool responses and prune after 30 days). Reply by calling orboto_agent_notify with threadId = the message id you are answering.',
  inputSchema: z.object({
    all: z.boolean().default(false).describe('true = include already-read messages'),
    limit: z.number().int().min(1).max(200).default(50),
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
      createdAt: z.string(),
      readAt: z.string().nullable(),
    })),
    acked: z.number().int(),
  }).shape,
  annotations: { readOnlyHint: false, idempotentHint: false },
};

export function makeAgentMessagesHandler(client: OrbotoClient) {
  return async (args: { all?: boolean; limit?: number; ackIds?: string[] }): Promise<CallToolResult> => {
    let acked = 0;
    if (args.ackIds && args.ackIds.length > 0) {
      const res = await client.post<{ acked: number }>('/v1/agent/messages/ack', { ids: args.ackIds });
      acked = res.acked;
    }
    const q = new URLSearchParams();
    if (args.all) q.set('all', 'true');
    if (args.limit) q.set('limit', String(args.limit));
    const { messages } = await client.get<{ messages: AgentMessage[] }>(`/v1/agent/messages${q.toString() ? `?${q.toString()}` : ''}`);
    const lines = messages.length === 0
      ? [acked > 0 ? `Acknowledged ${acked} message(s). Inbox empty.` : 'Inbox empty.']
      : messages.map((m) => `[${m.kind}] ${m.subject} (from ${m.fromUserId}, ${m.createdAt}, id ${m.id}${m.threadId ? `, thread ${m.threadId}` : ''})${m.payload ? ` payload: ${JSON.stringify(m.payload)}` : ''}`);
    if (messages.length > 0) {
      lines.push(`Acknowledge with ackIds once handled; reply via orboto_agent_notify with threadId.`);
    }
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: {
        messages: messages.map((m) => ({
          id: m.id, fromUserId: m.fromUserId, kind: m.kind, subject: m.subject,
          payload: m.payload, threadId: m.threadId, createdAt: m.createdAt, readAt: m.readAt,
        })),
        acked,
      },
    };
  };
}

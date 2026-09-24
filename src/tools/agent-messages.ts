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
import { makeAgentMessageWorkHandler } from './agent-message-work.js';
import { mcpInstanceToken } from './shared.js';

interface Party { userId: string; email: string; sessionId: string | null; role: string | null; label: string }
const PartySchema = z.object({ userId: z.string(), email: z.string(), sessionId: z.string().nullable(), role: z.string().nullable(), label: z.string() });

interface AgentMessage {
  id: string;
  fromUserId: string;
  toUserId: string;
  fromSessionId: string | null;
  toSessionId: string | null;
  from: Party;
  to: Party;
  kind: string;
  subject: string;
  payload: Record<string, unknown> | null;
  threadId: string | null;
  projectKey: string | null;
  createdAt: string;
  deliveredAt: string | null;
  readAt: string | null;
  dismissed: { reason: string; note: string | null; duplicateOf: string | null; createdAt: string } | null;
}

interface DismissInput { ids: string[]; reason: 'not_mine' | 'obsolete' | 'duplicate'; note?: string; duplicateOf?: string }

export const agentMessagesToolConfig = {
  title: 'Agent inbox and message work',
  description: 'Your inbox as THIS session sees it: mail to this session, account mail inside your declared scope, broadcasts; sibling-session mail and own sends stay out, all:true shows the whole account (ORB-2136). messageWork carries durable work ownership - claim before executing. ackIds acks: it completes an unclaimed request; claimed work with open steps is refused until messageWork completes or blocks it. dismiss is the third answer: not_mine hides it here and tells the sender, obsolete/duplicate close it for the account (note or duplicateOf required). Never leave mail you read and judged. Reply via orboto_agent_notify with threadId (toSessionRef = from.sessionId reaches that instance).',
  inputSchema: z.object({
    messageWork: z.record(z.unknown()).optional()
      .describe('Work envelope {messageId, mutation, cursor, limit, openOnly}; schema: orboto_api_search.'),
    all: z.boolean().default(false),
    limit: z.number().int().min(1).max(200).default(50),
    project: z.string().min(1).max(64).optional().describe('Project key/UUID; includes unscoped mail.'),
    includeOwnSends: z.boolean().default(false),
    ackIds: z.array(z.string().uuid()).max(200).optional().describe('Message ids to mark read.'),
    dismiss: z.object({
      ids: z.array(z.string().uuid()).min(1).max(200),
      reason: z.enum(['not_mine', 'obsolete', 'duplicate']),
      note: z.string().max(500).optional(),
      duplicateOf: z.string().uuid().optional(),
    }).optional().describe('Dismiss with a reason; obsolete/duplicate need note or duplicateOf.'),
  }).shape,
  outputSchema: z.object({
    work: z.record(z.unknown()).optional(),
    sessionId: z.string().nullable().optional(),
    messages: z.array(z.object({
      id: z.string(),
      fromUserId: z.string(),
      from: PartySchema,
      to: PartySchema,
      kind: z.string(),
      subject: z.string(),
      payload: z.record(z.string(), z.unknown()).nullable(),
      threadId: z.string().nullable(),
      projectKey: z.string().nullable(),
      createdAt: z.string(),
      readAt: z.string().nullable(),
      dismissed: z.object({
        reason: z.string(), note: z.string().nullable(), duplicateOf: z.string().nullable(), createdAt: z.string(),
      }).nullable(),
    })),
    acked: z.number().int(),
    dismissed: z.number().int().optional(),
    closed: z.number().int().optional(),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
};

export function makeAgentMessagesHandler(client: OrbotoClient) {
  return async (args: { all?: boolean; limit?: number; project?: string; includeOwnSends?: boolean; ackIds?: string[]; dismiss?: DismissInput; messageWork?: Parameters<ReturnType<typeof makeAgentMessageWorkHandler>>[0] }, extra?: unknown): Promise<CallToolResult> => {
    if (args.messageWork) {
      if (args.ackIds?.length) throw new Error('Use a separate explicit ACK call.');
      const result = await makeAgentMessageWorkHandler(client)(args.messageWork, extra as { sessionId?: string } | undefined);
      return { content: result.content, structuredContent: { messages: [], acked: 0, work: result.structuredContent } };
    }
    let dismissedCount = 0;
    let closedCount = 0;
    let feedbackSent = 0;
    if (args.dismiss) {
      const res = await client.post<{ dismissed: number; closed: number; feedbackSent: number }>('/v1/agent/messages/dismiss', {
        ...args.dismiss,
        instanceToken: mcpInstanceToken(undefined, extra as { sessionId?: string } | undefined),
      });
      dismissedCount = res.dismissed;
      closedCount = res.closed;
      feedbackSent = res.feedbackSent;
    }
    let acked = 0;
    if (args.ackIds && args.ackIds.length > 0) {
      const res = await client.post<{ acked: number }>('/v1/agent/messages/ack', { ids: args.ackIds, instanceToken: mcpInstanceToken(undefined, extra as { sessionId?: string } | undefined) });
      acked = res.acked;
    }
    const q = new URLSearchParams();
    if (args.all) q.set('all', 'true');
    if (args.limit) q.set('limit', String(args.limit));
    if (args.project) q.set('project', args.project);
    const instanceToken = mcpInstanceToken(undefined, extra as { sessionId?: string } | undefined);
    if (!args.includeOwnSends) q.set('excludeRef', instanceToken);
    const { messages, sessionId } = await client.get<{ messages: AgentMessage[]; sessionId?: string | null }>(`/v1/agent/messages${q.toString() ? `?${q.toString()}` : ''}`, { instanceToken });
    const lines = messages.length === 0
      ? [acked > 0 ? `Acknowledged ${acked} message(s). Inbox empty.` : 'Inbox empty.']
      : messages.map((m) => `[${m.kind}]${m.projectKey ? ` [${m.projectKey}]` : ''} ${m.subject} (from ${m.from?.label ?? m.fromUserId} to ${m.to?.label ?? m.toUserId}, ${m.createdAt}, id ${m.id}${m.threadId ? `, thread ${m.threadId}` : ''})${m.payload ? ` payload: ${JSON.stringify(m.payload)}` : ''}`);
    if (messages.length > 0) {
      lines.push(`Acknowledge with ackIds once handled; reply via orboto_agent_notify with threadId (toSessionRef = the sender's instance short id reaches that session only).`);
    }
    if (args.dismiss) {
      lines.unshift(`Dismissed ${dismissedCount} message(s) as ${args.dismiss.reason}${closedCount > 0 ? `, ${closedCount} closed for the account` : ''}${feedbackSent > 0 ? `, ${feedbackSent} sender(s) told about the misroute` : ''}.`);
    }
    if (sessionId) lines.push(`This session: ${sessionId.slice(0, 8)} (ref ${instanceToken}).`);
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: {
        sessionId: sessionId ?? null,
        messages: messages.map((m) => ({
          id: m.id, fromUserId: m.fromUserId, from: m.from, to: m.to, kind: m.kind, subject: m.subject,
          payload: m.payload, threadId: m.threadId, projectKey: m.projectKey ?? null,
          createdAt: m.createdAt, readAt: m.readAt, dismissed: m.dismissed ?? null,
        })),
        acked,
        dismissed: dismissedCount,
        closed: closedCount,
      },
    };
  };
}

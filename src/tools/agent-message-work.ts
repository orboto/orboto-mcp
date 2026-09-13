import { z } from 'zod';
import type { OrbotoClient } from '../orboto-client.js';
import { mcpInstanceToken } from './shared.js';

const MessageWorkStepSchema = z.object({
  id: z.string().uuid(), title: z.string().trim().min(1).max(500),
  state: z.enum(['open', 'in_work', 'blocked', 'completed']).default('open'),
  evidence: z.array(z.string().trim().min(1).max(4000)).max(20).default([]),
  ticketId: z.string().uuid().optional(), workSessionId: z.string().uuid().optional(), taskId: z.string().uuid().optional(),
});
const MessageWorkMutationSchema = z.object({
  action: z.enum(['claim', 'progress', 'complete', 'recover', 'handoff']),
  instanceToken: z.string().trim().min(1).max(128).optional(),
  revision: z.number().int().nonnegative().optional(),
  leaseSeconds: z.number().int().min(60).max(3600).default(900),
  steps: z.array(MessageWorkStepSchema).min(1).max(100).optional(),
  stepId: z.string().uuid().optional(), stepState: z.enum(['open', 'in_work', 'blocked', 'completed']).optional(),
  state: z.enum(['in_work', 'blocked']).optional(),
  summary: z.string().trim().min(1).max(4000),
  evidence: z.array(z.string().trim().min(1).max(4000)).max(20).default([]),
  targetInstanceToken: z.string().trim().min(1).max(128).optional(),
}).strict();

export const agentMessageWorkToolConfig = {
  title: 'Inspect or explicitly handle message work',
  description: 'List unfinished message work, inspect exact messages and history, or claim/progress/complete/recover/handoff with a revision and evidence. Claim before execution. ACK is separate and owner-only. Recovery requires a reason in summary and an expired lease. A completed linked ticket or model turn never completes a message.',
  inputSchema: z.object({ messageId: z.string().uuid().optional(), mutation: MessageWorkMutationSchema.omit({ instanceToken: true }).optional(),
    cursor: z.string().optional(), limit: z.number().int().min(1).max(100).default(25), openOnly: z.boolean().default(true) }).shape,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
};
export function makeAgentMessageWorkHandler(client: OrbotoClient) {
  return async (args: { messageId?: string; mutation?: z.infer<typeof MessageWorkMutationSchema>; cursor?: string; limit?: number; openOnly?: boolean }, extra?: { sessionId?: string }) => {
    if (args.mutation && !args.messageId) throw new Error('messageId is required for a mutation');
    const q = new URLSearchParams({ limit: String(args.limit ?? 25), openOnly: String(args.openOnly ?? true) });
    if (args.cursor) q.set('cursor', args.cursor);
    const result = args.mutation
      ? await client.post(`/v1/agent/messages/${args.messageId}/work`, { ...args.mutation, instanceToken: mcpInstanceToken(undefined, extra) })
      : await client.get(`${args.messageId ? `/v1/agent/messages/${args.messageId}` : '/v1/agent/message-work'}?${q}`, { instanceToken: mcpInstanceToken(undefined, extra) });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result as Record<string, unknown> };
  };
}

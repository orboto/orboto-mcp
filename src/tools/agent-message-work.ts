import { z } from 'zod';
import type { OrbotoClient } from '../orboto-client.js';
import { mcpInstanceToken } from './shared.js';

export const agentMessageWorkToolConfig = {
  title: 'Inspect or explicitly handle message work',
  description: 'List, inspect or mutate durable message work (mutation schema: orboto_api_search). Only request/error mail carries work; an ack completes it unless somebody claimed it.',
  inputSchema: z.object({ messageId: z.string().uuid().optional(), mutation: z.record(z.unknown()).optional(),
    cursor: z.string().optional(), limit: z.number().int().min(1).max(100).default(25), openOnly: z.boolean().default(true) }).shape,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
};
/** ORB-2190 - the resolved states, said once in the tool output rather than in the manifest. */
export const WORK_STATE_NOTE = 'carriesWork false = info/complete/digest mail, no work state. An open list holds requests and errors only, oldest first; '
  + 'presence unclaimed | active | stalled | expired, and completed once you finish it, an ack closes it, a dismissal closes it or its ticket resolves it.';

export function makeAgentMessageWorkHandler(client: OrbotoClient) {
  return async (args: { messageId?: string; mutation?: Record<string, unknown>; cursor?: string; limit?: number; openOnly?: boolean }, extra?: { sessionId?: string }) => {
    if (args.mutation && !args.messageId) throw new Error('messageId is required for a mutation');
    const q = new URLSearchParams({ limit: String(args.limit ?? 25), openOnly: String(args.openOnly ?? true) });
    if (args.cursor) q.set('cursor', args.cursor);
    const result = args.mutation
      ? await client.post(`/v1/agent/messages/${args.messageId}/work`, { ...args.mutation, instanceToken: mcpInstanceToken(undefined, extra) })
      : await client.get(`${args.messageId ? `/v1/agent/messages/${args.messageId}` : '/v1/agent/message-work'}?${q}`, { instanceToken: mcpInstanceToken(undefined, extra) });
    return { content: [{ type: 'text' as const, text: `${JSON.stringify(result)}\n${WORK_STATE_NOTE}` }], structuredContent: result as Record<string, unknown> };
  };
}

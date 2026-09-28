/**
 * ORB-2237 - `orboto_feedback_reply`: the operator's public reply to a
 * tenant report, one step (POST /tickets/:id/feedback-reply).
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';

export const feedbackReplyToolConfig = {
  title: 'Reply to feedback report',
  description: 'Post the operator\'s public reply on a feedback ticket. Synced to the tenant. Refuses secrets.',
  inputSchema: z.object({
    ticketKey: z.string().min(1).max(64),
    content: z.string().min(1).max(20_000),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};

export interface FeedbackReplyArgs {
  ticketKey: string;
  content: string;
}

export function makeFeedbackReplyHandler(client: OrbotoClient) {
  return async (args: FeedbackReplyArgs): Promise<CallToolResult> => {
    const res = await client.post<{ commentId: string; repliedAt: string }>(`/tickets/${encodeURIComponent(args.ticketKey)}/feedback-reply`, { content: args.content });
    return {
      content: [{ type: 'text', text: `Reply posted on ${args.ticketKey} (comment ${res.commentId}, ${res.repliedAt}).` }],
      structuredContent: res,
    };
  };
}

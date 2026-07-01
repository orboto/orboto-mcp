/**
 * ORB-1321 — `orboto_ai_usage`.
 *
 * Operator diagnostic for AI *consumption*: total calls / tokens in+out /
 * errors over a date range, plus per-user, per-operation, and per-day
 * breakdowns and the AI-Chat slice. Wraps GET /admin/ai/usage.
 *
 * Complements the other two AI diagnostics: `orboto_ai_status` says whether AI
 * is configured; `orboto_embedding_status` covers the embedding pipeline's
 * health; this one answers "how much are we spending / how many calls are
 * erroring". Aggregates only (no per-row error text). admin:ai:read gated
 * (403 for non-admin callers).
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';

interface AiUsageResponse {
  totals: { calls: number; tokensIn: number; tokensOut: number; errors: number };
  perUser: Array<{ userId: string | null; userName: string | null; calls: number; tokensIn: number; tokensOut: number }>;
  perOperation: Array<{ operation: string; calls: number }>;
  daily: Array<{ date: string; calls: number }>;
  chatConversations: number;
  topChatUsers: Array<{ userId: string | null; userName: string | null; calls: number; tokensIn: number; tokensOut: number }>;
}

export const aiUsageToolConfig = {
  title: 'AI usage (calls / tokens / errors)',
  description:
    'Operator diagnostic for AI consumption over a date range (defaults to the last 30 days). Returns totals (calls, tokens in / out, error count) plus per-user, per-operation and per-day breakdowns and the AI-Chat slice (conversation count + top chat users). Use this to see spend / call volume / which operations run most / how many calls are erroring. Aggregates only — not the per-row error messages. Pair with orboto_embedding_status (pipeline health) and orboto_ai_status (is AI configured). Requires admin:ai:read — 403 for non-admin callers.',
  inputSchema: z.object({
    start: z.string().optional().describe('Range start, YYYY-MM-DD (inclusive). Defaults to 30 days ago.'),
    end: z.string().optional().describe('Range end, YYYY-MM-DD (inclusive). Defaults to today.'),
  }).shape,
  outputSchema: z.object({
    calls: z.number(),
    tokensIn: z.number(),
    tokensOut: z.number(),
    errors: z.number(),
    chatConversations: z.number(),
    topOperations: z.array(z.object({ operation: z.string(), calls: z.number() })),
    topUsers: z.array(z.object({ userName: z.string().nullable(), calls: z.number(), tokensIn: z.number(), tokensOut: z.number() })),
  }).shape,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
  },
};

export function makeAiUsageHandler(client: OrbotoClient) {
  return async (args: { start?: string; end?: string }): Promise<CallToolResult> => {
    const qs = new URLSearchParams();
    if (args.start) qs.set('start', args.start);
    if (args.end) qs.set('end', args.end);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    const u = await client.get<AiUsageResponse>(`/admin/ai/usage${suffix}`);

    const topOps = u.perOperation.slice(0, 8);
    const topUsers = u.perUser.slice(0, 8);
    const lines: string[] = [];
    lines.push(`AI usage${args.start || args.end ? ` (${args.start ?? 'start'} → ${args.end ?? 'today'})` : ' (last 30 days)'}`);
    lines.push(`Totals: ${u.totals.calls} calls · ${u.totals.tokensIn} tokens in · ${u.totals.tokensOut} out · ${u.totals.errors} errors`);
    if (u.totals.errors > 0) {
      lines.push(`  ⚠ ${u.totals.errors} call(s) errored — check Admin → AI → Usage (or the ai_usage_log) for the messages; aggregates don't carry them.`);
    }
    if (topOps.length) lines.push(`Top operations: ${topOps.map((o) => `${o.operation} (${o.calls})`).join(', ')}`);
    if (topUsers.length) lines.push(`Top users: ${topUsers.map((x) => `${x.userName ?? 'unknown'} (${x.calls})`).join(', ')}`);
    lines.push(`AI Chat: ${u.chatConversations} conversation(s)`);

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: {
        calls: u.totals.calls,
        tokensIn: u.totals.tokensIn,
        tokensOut: u.totals.tokensOut,
        errors: u.totals.errors,
        chatConversations: u.chatConversations,
        topOperations: topOps,
        topUsers: topUsers.map((x) => ({ userName: x.userName, calls: x.calls, tokensIn: x.tokensIn, tokensOut: x.tokensOut })),
      },
    };
  };
}

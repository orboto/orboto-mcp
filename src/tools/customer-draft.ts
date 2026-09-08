/**
 * ORB-2000 - orboto_draft_customer_reply: a customer-facing DRAFT for a
 * ticket, built server-side from customer-safe facts only (ticket key,
 * title, status, due date, customer summary, non-internal comments, the
 * caller's ask) - never from the internal description or internal
 * comments. Returns the draft plus the facts-used list and what was left
 * out. It never posts: the agent shows the draft and posts it only with
 * orboto_comment after the user approved the text.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';
import { resolveTicketByKey } from './shared.js';

interface DraftResponse {
  draft: string;
  factsUsed: Array<{ source: string; text: string }>;
  excluded: { internalComments: number; internalDescription: boolean };
  trainingProposalId?: string;
}

export const draftCustomerReplyToolConfig = {
  title: 'Draft a customer-facing reply for a ticket',
  description:
    'Draft a reply or status update for a CUSTOMER / external reader about a ticket (by key), built server-side from customer-safe facts only (key, title, status, due date, customer summary, non-internal comments, your `ask`) - never from internal notes. Returns the draft, the facts used and what was excluded. Never posts: show it to the user, then `orboto_comment` only after approval. Use it for every customer-facing text.',
  inputSchema: z.object({
    ticketKey: z.string().describe('Ticket key like "ORB-42".'),
    ask: z.string().min(3).max(1000).describe('What the reply should do, in the user\'s words, e.g. "tell them the fix ships with the next release" or "ask for the browser version".'),
  }).shape,
  outputSchema: z.object({
    draft: z.string(),
    factsUsed: z.array(z.object({ source: z.string(), text: z.string() })),
    excluded: z.object({ internalComments: z.number(), internalDescription: z.boolean() }),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: false },
};

export function makeDraftCustomerReplyHandler(client: OrbotoClient) {
  return async ({ ticketKey, ask }: { ticketKey: string; ask: string }): Promise<CallToolResult> => {
    const ticket = await resolveTicketByKey(client, ticketKey);
    const res = await client.post<DraftResponse>('/ai/draft-customer-reply', { ticketId: ticket.id, ask });
    const lines = [`Draft for ${ticketKey} (not posted - show it to the user first):`, '', res.draft.trim(), '', 'Facts used:'];
    for (const f of res.factsUsed) lines.push(`  - ${f.source}: ${f.text.length > 160 ? f.text.slice(0, 160) + '...' : f.text}`);
    if (res.excluded.internalComments > 0 || res.excluded.internalDescription) {
      lines.push('', `Left out on purpose: ${res.excluded.internalComments} internal comment(s)${res.excluded.internalDescription ? ' and the internal description' : ''}.`);
    }
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { draft: res.draft, factsUsed: res.factsUsed, excluded: res.excluded },
    };
  };
}

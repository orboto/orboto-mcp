/**
 * ORB-244 Phase B — `orboto_my_tickets`.
 *
 * The caller's own assignments. Maps to
 * `GET /users/me/assigned-tickets`, which already does the
 * right thing visibility-wise (only tickets the user can see,
 * scoped to their project memberships).
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';
import { agentTicketListRow, type TicketRow } from './shared.js';

// ORB-1699 - rows come from the enriched list pipeline; use the shared
// TicketRow so the shared row builder types cleanly.
type MyTicketRow = TicketRow;

export const myTicketsToolConfig = {
  title: 'My assigned tickets',
  description:
    'List tickets assigned to the authenticated user, optionally filtered to a status category. Useful when the user says "what am I working on?"',
  inputSchema: z.object({
    statusCategory: z
      .enum(['todo', 'in_progress', 'in_review', 'done', 'wont_fix'])
      .optional()
      .describe('Filter to one workflow category. Omit for all non-done.'),
    limit: z.number().int().min(1).max(50).default(25),
    verbose: z.boolean().default(false).describe('true = full rows; default is the decision fields only.'),
  }).shape,
  annotations: { readOnlyHint: true },
};

// The API route's `statuses` param is the uppercase LEGACY status
// enum (TODO/IN_PROGRESS/IN_REVIEW/DONE/WONT_FIX). The MCP tool
// accepts the lower-case category enum the rest of the surface uses;
// map here.
const CATEGORY_TO_LEGACY: Record<string, string> = {
  todo: 'TODO',
  in_progress: 'IN_PROGRESS',
  in_review: 'IN_REVIEW',
  done: 'DONE',
  wont_fix: 'WONT_FIX',
};

export function makeMyTicketsHandler(client: OrbotoClient) {
  return async (input: {
    statusCategory?: 'todo' | 'in_progress' | 'in_review' | 'done' | 'wont_fix';
    limit?: number;
    verbose?: boolean;
  }): Promise<CallToolResult> => {
    const qs = new URLSearchParams();
    qs.set('limit', String(input.limit ?? 25));
    if (input.statusCategory) {
      qs.set('statuses', CATEGORY_TO_LEGACY[input.statusCategory]);
    } else {
      // Default: exclude done + wont_fix so "what am I working on?"
      // returns open work rather than a lifetime history.
      qs.set('statuses', 'TODO,IN_PROGRESS,IN_REVIEW');
    }

    const page = await client.get<{ items: MyTicketRow[]; nextCursor: string | null }>(
      `/users/me/assigned-tickets?${qs}`,
    );

    const text = page.items.length === 0
      ? 'No tickets assigned to you matching that filter.'
      : page.items.map((t) => {
        const key = t.ticketKey ?? t.id.slice(0, 8);
        const due = t.dueDate ? ` (due ${t.dueDate})` : '';
        return `- [${key}] ${t.title} — ${t.status}, ${t.priority}${due}`;
      }).join('\n');

    return {
      content: [{ type: 'text', text }],
      structuredContent: {
        count: page.items.length,
        hasMore: !!page.nextCursor,
        // ORB-1699 - shared lean row; verbose restores uuid/labels/minutes.
        tickets: page.items.map((t) => agentTicketListRow(t, input.verbose ?? false)),
      },
    };
  };
}

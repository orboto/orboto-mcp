/**
 * ORB-244 Phase B - `orboto_get_checklists`.
 *
 * Dedicated read tool for a ticket's checklists. Two callers want
 * this without paying for the full ticket payload:
 *
 *   1. Models asking "what's still unchecked on ACME-42?" - don't
 *      need description + comments + git activity for that.
 *   2. Phase-C write tools (`orboto_check` / `orboto_uncheck`) - the
 *      user usually wants to confirm the item exists before
 *      toggling it, and this tool is the cheap round-trip.
 *
 * ORB-234 detail exposed here: when a checklist item links to
 * another ticket, `effectiveCompleted` mirrors that ticket's status
 * category. We surface the linked ticket so the model can explain
 * "item is done because [ORB-99] shipped" rather than just "done".
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';
import { resolveTicketByKey } from './shared.js';

interface ChecklistItemRow {
  id: string;
  content: string;
  storedCompleted: boolean;
  effectiveCompleted: boolean;
  linkedTicketId: string | null;
  linkedTicketKey: string | null;
  linkedTicketTitle: string | null;
  linkedTicketStatusCategory: string | null;
  sortOrder: number;
}
interface ChecklistRow {
  id: string;
  title: string;
  triggersDone: boolean;
  progress: { done: number; total: number };
  items: ChecklistItemRow[];
}

export const getChecklistsToolConfig = {
  title: 'Get ticket checklists',
  description:
    'Return all checklists on a ticket with per-item completion state. Items that link to another ticket carry that ticket\'s key + status so the model can explain why an item is (not) done.',
  inputSchema: z.object({
    ticketKey: z.string().min(3).describe('Ticket key like "ACME-42".'),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeGetChecklistsHandler(client: OrbotoClient) {
  return async ({ ticketKey }: { ticketKey: string }): Promise<CallToolResult> => {
    const ticket = await resolveTicketByKey(client, ticketKey);
    const checklists = await client.get<ChecklistRow[]>(`/tickets/${ticket.id}/checklists`);

    if (checklists.length === 0) {
      return {
        content: [{ type: 'text', text: `[${ticket.ticketKey}] has no checklists.` }],
        structuredContent: { ticketKey: ticket.ticketKey, checklists: [] },
      };
    }

    const lines: string[] = [];
    for (const cl of checklists) {
      lines.push(
        `### ${cl.title} (${cl.progress.done}/${cl.progress.total})${cl.triggersDone ? ' · triggers ticket done' : ''}`,
      );
      for (const i of cl.items) {
        const linkSuffix = i.linkedTicketKey
          ? ` ↪ [${i.linkedTicketKey}] ${i.linkedTicketTitle ?? ''} (${i.linkedTicketStatusCategory ?? 'unknown'})`
          : '';
        lines.push(`- [${i.effectiveCompleted ? 'x' : ' '}] ${i.content}${linkSuffix}`);
      }
      lines.push('');
    }

    return {
      content: [{ type: 'text', text: lines.join('\n').trimEnd() }],
      structuredContent: {
        ticketKey: ticket.ticketKey,
        checklists: checklists.map((cl) => ({
          id: cl.id,
          title: cl.title,
          triggersDone: cl.triggersDone,
          progress: cl.progress,
          items: cl.items.map((i) => ({
            id: i.id,
            content: i.content,
            done: i.effectiveCompleted,
            linkedTicket: i.linkedTicketKey ? {
              key: i.linkedTicketKey,
              title: i.linkedTicketTitle,
              statusCategory: i.linkedTicketStatusCategory,
            } : null,
          })),
        })),
      },
    };
  };
}

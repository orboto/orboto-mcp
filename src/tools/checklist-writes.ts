/**
 * ORB-244 Phase C Group 3 — checklist write tools (ORB-234).
 *
 * Four tools:
 *   - orboto_check / orboto_uncheck — toggle a single item's `isCompleted`
 *   - orboto_add_check — append a new item to a list (default: first list
 *                       on the ticket)
 *   - orboto_new_checklist — create a fresh list with optional triggers-done
 *
 * Item identifier: agents prefer 1-based indexes ("check item 3 on
 * ACME-42") because UUIDs are ergonomic disasters in a chat. The
 * helper resolves either form by reading the ticket's checklists
 * once. UUID input is honoured directly so callers that already have
 * the ID can skip the lookup.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OrbitApiError, type OrbitClient } from '../orbit-client.js';
import { resolveTicketByKey } from './shared.js';

interface ChecklistItem {
  id: string;
  content: string;
  storedCompleted: boolean;
  effectiveCompleted: boolean;
  linkedTicketId: string | null;
  linkedTicketKey: string | null;
  sortOrder: number;
}

interface Checklist {
  id: string;
  title: string;
  triggersDone: boolean;
  progress: { done: number; total: number };
  items: ChecklistItem[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve an item identifier (1-based index OR UUID) to its UUID.
 * Index is global across all checklists on the ticket — same model
 * the wrapper's `check ORB-X 3` uses, so the agent's mental model
 * is stable across the two surfaces.
 */
async function resolveItemId(
  client: OrbitClient,
  ticketId: string,
  identifier: number | string,
): Promise<{ itemId: string; checklists: Checklist[] }> {
  const checklists = await client.get<Checklist[]>(`/tickets/${ticketId}/checklists`);

  if (typeof identifier === 'string' && UUID_RE.test(identifier)) {
    return { itemId: identifier, checklists };
  }

  const idx = typeof identifier === 'number' ? identifier : parseInt(identifier, 10);
  if (!Number.isFinite(idx) || idx < 1) {
    throw new Error(`Invalid item identifier "${identifier}" — must be a 1-based index or a UUID.`);
  }
  const flat = checklists.flatMap((cl) => cl.items);
  const target = flat[idx - 1];
  if (!target) {
    throw new Error(`Item index ${idx} is out of range — ticket has ${flat.length} items.`);
  }
  return { itemId: target.id, checklists };
}

// ---------------------------------------------------------------------------
// orboto_check / orboto_uncheck
// ---------------------------------------------------------------------------

function makeToggleHandler(client: OrbitClient, completed: boolean) {
  return async ({ ticketKey, item }: {
    ticketKey: string; item: number | string;
  }): Promise<CallToolResult> => {
    const ticket = await resolveTicketByKey(client, ticketKey);
    const { itemId, checklists } = await resolveItemId(client, ticket.id, item);
    const before = checklists.flatMap((c) => c.items).find((i) => i.id === itemId);

    await client.patch(`/checklist-items/${itemId}`, { isCompleted: completed });
    return {
      content: [{
        type: 'text',
        text: `${completed ? 'Checked' : 'Unchecked'} on [${ticket.ticketKey}]: ${before?.content ?? '(item)'}`,
      }],
      structuredContent: {
        ticketKey: ticket.ticketKey,
        itemId,
        completed,
        content: before?.content ?? null,
      },
    };
  };
}

const toggleInputSchema = z.object({
  ticketKey: z.string().min(3),
  item: z.union([
    z.number().int().min(1).describe('1-based index, global across all checklists on this ticket'),
    z.string().describe('Item UUID — for callers that already have it'),
  ]),
}).shape;

export const checkToolConfig = {
  title: 'Check a checklist item',
  description:
    'Mark a checklist item as completed. `item` is either a 1-based index (count across all checklists on the ticket, top to bottom) or the item\'s UUID. Linked-ticket items are checked automatically when the linked ticket transitions to `done` — checking those manually is ignored.',
  inputSchema: toggleInputSchema,
};

export const uncheckToolConfig = {
  title: 'Uncheck a checklist item',
  description:
    'Mark a checklist item as not-completed. Same `item` semantics as orboto_check.',
  inputSchema: toggleInputSchema,
};

export const makeCheckHandler = (client: OrbitClient) => makeToggleHandler(client, true);
export const makeUncheckHandler = (client: OrbitClient) => makeToggleHandler(client, false);

// ---------------------------------------------------------------------------
// orboto_add_check
// ---------------------------------------------------------------------------

export const addCheckToolConfig = {
  title: 'Add a checklist item',
  description:
    'Append an item to a checklist on a ticket. By default appends to the FIRST checklist on the ticket; pass `listTitle` to target a specific one. Pass `linkedTicketKey` to make the item track another ticket\'s status (the new item\'s `effectiveCompleted` mirrors that ticket\'s done-status from then on).',
  inputSchema: z.object({
    ticketKey: z.string().min(3),
    content: z.string().min(1).max(2000),
    listTitle: z.string().optional().describe('Target checklist title. Default: first checklist on the ticket.'),
    linkedTicketKey: z.string().optional().describe('Make this item track another ticket\'s done-status (e.g. "ACME-99").'),
  }).shape,
};

export function makeAddCheckHandler(client: OrbitClient) {
  return async ({ ticketKey, content, listTitle, linkedTicketKey }: {
    ticketKey: string; content: string; listTitle?: string; linkedTicketKey?: string;
  }): Promise<CallToolResult> => {
    const ticket = await resolveTicketByKey(client, ticketKey);
    const checklists = await client.get<Checklist[]>(`/tickets/${ticket.id}/checklists`);
    if (checklists.length === 0) {
      throw new Error(
        `[${ticket.ticketKey}] has no checklists yet. Create one with orboto_new_checklist first.`,
      );
    }

    const target = listTitle
      ? checklists.find((c) => c.title === listTitle)
      : checklists[0];
    if (!target) {
      throw new Error(
        `Checklist "${listTitle}" not found on [${ticket.ticketKey}]. Lists on this ticket: ${
          checklists.map((c) => `"${c.title}"`).join(', ')
        }`,
      );
    }

    const body: Record<string, unknown> = { content };
    if (linkedTicketKey) {
      const linked = await resolveTicketByKey(client, linkedTicketKey);
      body.linkedTicketId = linked.id;
    }

    const item = await client.post<ChecklistItem>(
      `/tickets/${ticket.id}/checklists/${target.id}/items`, body,
    );

    return {
      content: [{
        type: 'text',
        text: `Added to "${target.title}" on [${ticket.ticketKey}]: ${content}${linkedTicketKey ? ` ↪ [${linkedTicketKey}]` : ''}`,
      }],
      structuredContent: {
        ticketKey: ticket.ticketKey,
        listTitle: target.title,
        itemId: item.id,
        content: item.content,
        linkedTicketKey: linkedTicketKey ?? null,
      },
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_new_checklist
// ---------------------------------------------------------------------------

export const newChecklistToolConfig = {
  title: 'Create a new checklist on a ticket',
  description:
    'Create a fresh checklist on a ticket. `triggersDone=true` gates the ticket\'s auto-done transition on this list (the ticket can\'t move to done until every item here is checked). Optional `items` seed the list with content in one call — saves a round-trip per item.',
  inputSchema: z.object({
    ticketKey: z.string().min(3),
    title: z.string().min(1).max(300),
    triggersDone: z.boolean().optional().describe('Default: false. Set true to gate the ticket\'s done-transition on this list.'),
    items: z.array(z.string().min(1).max(2000)).max(100).optional().describe('Seed items in one call.'),
  }).shape,
};

export function makeNewChecklistHandler(client: OrbitClient) {
  return async ({ ticketKey, title, triggersDone, items }: {
    ticketKey: string; title: string; triggersDone?: boolean; items?: string[];
  }): Promise<CallToolResult> => {
    const ticket = await resolveTicketByKey(client, ticketKey);
    const body: Record<string, unknown> = { title };
    if (triggersDone) body.triggersDone = true;
    if (items && items.length > 0) body.items = items.map((content) => ({ content }));

    let list: Checklist;
    try {
      list = await client.post<Checklist>(`/tickets/${ticket.id}/checklists`, body);
    } catch (err) {
      if (err instanceof OrbitApiError && err.status === 403) {
        throw new Error(`Forbidden — you need ticket:edit on [${ticket.ticketKey}]'s project to add checklists.`);
      }
      throw err;
    }
    return {
      content: [{
        type: 'text',
        text: `Created checklist "${title}" on [${ticket.ticketKey}]${triggersDone ? ' (triggers done)' : ''} with ${list.items.length} item(s).`,
      }],
      structuredContent: {
        ticketKey: ticket.ticketKey,
        checklistId: list.id,
        title: list.title,
        triggersDone: list.triggersDone,
        itemCount: list.items.length,
      },
    };
  };
}

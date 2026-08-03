/**
 * ORB-799 (gap-cluster 8) — re-parent existing tickets.
 *
 * `orboto_update_ticket` accepts most ticket fields but NOT
 * `parentTicketId` / `parentTicketKey`, mirroring an API choice made
 * during ORB-309: parent assignment was treated as a creation-time
 * decision (set via `orboto_create_ticket`'s `parentTicketKey`) and the
 * patch surface was deliberately narrowed.
 *
 * In practice that left a gap: re-parenting an existing ticket under a
 * new epic (e.g. discovering during cluster-formation that ORB-600
 * belongs under ORB-800 as a sub-ticket) had no MCP-side path and
 * required falling back to the Bash wrapper's raw `patch /projects/...`
 * route — documented in `feedback_mcp_reparent_limitation.md`.
 *
 * Design choice: separate `orboto_set_parent` tool rather than
 * extending `orboto_update_ticket`'s patch shape. Symmetric to
 * `orboto_set_milestone` which exists for the same reason — a
 * dedicated tool with clearer semantics, easier permission gating
 * thinking, and a natural `parentTicketKey: null` path for detaching.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OrbotoApiError, type OrbotoClient } from '../orboto-client.js';
import { resolveTicketByKey, type TicketRow } from './shared.js';

export const setParentToolConfig = {
  title: 'Set or clear a ticket\'s parent',
  description:
    'Re-parent an existing ticket. Pass `parentTicketKey` to make this ticket a sub-ticket of another, or pass `parentTicketKey: null` to detach from any parent (back to top-level). Both tickets must live in the same project. Cycle detection + self-parenting are rejected by the API. Symmetric to `orboto_set_milestone` — use this rather than `orboto_update_ticket` for parent moves.',
  inputSchema: z.object({
    ticketKey: z.string().min(3),
    parentTicketKey: z.string().nullable().describe('New parent ticket key (e.g. "ACME-10"), or null to detach.'),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
};

export function makeSetParentHandler(client: OrbotoClient) {
  return async ({ ticketKey, parentTicketKey }: {
    ticketKey: string; parentTicketKey: string | null;
  }): Promise<CallToolResult> => {
    const ticket = await resolveTicketByKey(client, ticketKey);
    let parentTicketId: string | null = null;
    let parentKey: string | null = null;
    if (parentTicketKey !== null && parentTicketKey !== undefined) {
      const parent = await resolveTicketByKey(client, parentTicketKey);
      if (parent.projectId !== ticket.projectId) {
        throw new Error(
          `Cross-project parenting is not allowed: ${ticket.ticketKey} is in a different project than ${parent.ticketKey}.`,
        );
      }
      if (parent.id === ticket.id) {
        throw new Error(`A ticket cannot be its own parent (${ticket.ticketKey}).`);
      }
      parentTicketId = parent.id;
      parentKey = parent.ticketKey;
    }
    let updated: TicketRow;
    try {
      updated = await client.patch<TicketRow>(
        `/projects/${ticket.projectId}/tickets/${ticket.id}`,
        { parentTicketId },
      );
    } catch (err) {
      // Surface the API's own cycle-detection error verbatim if it
      // catches a deeper cycle we couldn't see from one hop above.
      if (err instanceof OrbotoApiError && err.status === 400) {
        throw new Error(`Re-parent rejected by the API: ${err.body || 'cycle or constraint violation'}.`);
      }
      throw err;
    }
    return {
      content: [{
        type: 'text',
        text: parentTicketId
          ? `Re-parented [${updated.ticketKey}] under [${parentKey}].`
          : `Detached [${updated.ticketKey}] from its parent (now top-level).`,
      }],
      structuredContent: {
        ticketKey: updated.ticketKey,
        parentTicketKey: parentKey,
        parentTicketId,
      },
    };
  };
}

/** ORB-2819 - an operator's explicit request for one more review of a ticket's current delivery by a review lane. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';
import { resolveTicketByKey } from './shared.js';

interface ReviewTask { id: string; ticketKey: string; state: string; reviewRound?: number; deliveryKey?: string | null }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const laneRereviewToolConfig = {
  title: 'Request another lane review',
  description: 'Ask a review lane to review the current delivery of a ticket once more; a lane reviews each delivery once. Returns an open review instead of a second one. Operators and lane coordinators only; a coordinator without admin:agent_lanes:read passes the lane UUID, the name lookup needs that permission.',
  inputSchema: z.object({
    lane: z.string().min(1).max(120).describe('Lane name or UUID; a coordinator without admin:agent_lanes:read passes the UUID.'),
    ticketKey: z.string().min(3).max(40),
    reason: z.string().trim().min(1).max(2000),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};

export function makeLaneRereviewHandler(client: OrbotoClient) {
  return async (input: { lane: string; ticketKey: string; reason: string }): Promise<CallToolResult> => {
    let laneId = input.lane.trim();
    if (!UUID.test(laneId)) {
      const lanes = await client.get<{ items: Array<{ id: string; name: string }> }>('/admin/agent-lanes');
      const found = lanes.items.find((l) => l.name === laneId);
      if (!found) throw new Error(`No agent lane named "${laneId}".`);
      laneId = found.id;
    }
    const ticket = await resolveTicketByKey(client, input.ticketKey.trim());
    const task = await client.post<ReviewTask>(`/agent-lanes/${laneId}/tasks/rereview`, { ticketId: ticket.id, reason: input.reason.trim(), idempotencyKey: randomUUID() });
    return {
      content: [{ type: 'text', text: `Review task ${task.id} for ${task.ticketKey}: ${task.state}, round ${task.reviewRound ?? 0}.` }],
      structuredContent: task as unknown as Record<string, unknown>,
    };
  };
}

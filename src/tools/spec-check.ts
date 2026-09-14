import { z } from 'zod';
import type { OrbotoClient } from '../orboto-client.js';
import { resolveTicketByKey } from './shared.js';

export const specCheckToolConfig = {
  title: 'Check build order',
  description: 'Validate a build order. Reports missing headings, criteria and open questions, and returns the template. Release permission is checked separately.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: z.object({ ticketKey: z.string().min(1) }),
};

export function makeSpecCheckHandler(client: OrbotoClient) {
  return async (input: { ticketKey: string }) => {
    const ticket = await resolveTicketByKey(client, input.ticketKey);
    const result = await client.get<Record<string, unknown>>(`/projects/${ticket.projectId}/tickets/${ticket.id}/spec-check`);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
  };
}

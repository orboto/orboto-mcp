/**
 * ORB-625 - `orboto_free_busy`. Read a batch of users' near-term capacity
 * (planned + booked + external-busy vs contractual capacity) so an agent can
 * pick an available assignee. Wraps GET /users/free-busy, which is gated by
 * the workspace `free_busy_team_visibility` toggle (disabled → 403 for
 * non-admins) and the per-user opt-out (→ status 'unknown').
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OrbotoApiError, type OrbotoClient } from '../orboto-client.js';

export const freeBusyToolConfig = {
  title: 'User free/busy',
  description:
    "Look up near-term capacity (free/busy) for one or more users so you can pick an available assignee. Returns, per user, a `status` (available | busy | overcapacity | absent | unknown) and per-bucket entries with plannedMinutes (plan-blocks), bookedMinutes (logged time), capacityMinutes (contractual), onAbsence, and externalBusyMinutes. `unknown` means the user opted out or the workspace hides their data from you. Requires the workspace free/busy toggle to be enabled (or admin rights); otherwise you get a not-permitted result. `userIds` is a list of user UUIDs (get them from orboto_list_users). Optional `from`/`to` (YYYY-MM-DD, default the next 2 weeks) and `granularity` (day | week, default day).",
  inputSchema: z.object({
    userIds: z.array(z.string().uuid()).min(1).max(200).describe('User UUIDs to look up.'),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Range start (YYYY-MM-DD). Default: today.'),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Range end inclusive (YYYY-MM-DD). Default: today + 13 days.'),
    granularity: z.enum(['day', 'week']).optional().describe('Bucket size. Default: day.'),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeFreeBusyHandler(client: OrbotoClient) {
  return async (input: { userIds: string[]; from?: string; to?: string; granularity?: 'day' | 'week' }): Promise<CallToolResult> => {
    const qs = new URLSearchParams();
    qs.set('userIds', input.userIds.join(','));
    if (input.from) qs.set('from', input.from);
    if (input.to) qs.set('to', input.to);
    if (input.granularity) qs.set('granularity', input.granularity);

    let data: unknown;
    try {
      data = await client.get<unknown>(`/users/free-busy?${qs.toString()}`);
    } catch (err) {
      if (err instanceof OrbotoApiError && err.status === 403) {
        return {
          content: [{ type: 'text', text: 'Not permitted: free/busy visibility is disabled for this workspace (admins only).' }],
          structuredContent: { error: 'forbidden' },
        };
      }
      throw err;
    }

    return {
      content: [{ type: 'text', text: `Free/busy:\n${JSON.stringify(data, null, 2)}` }],
      structuredContent: data as Record<string, unknown>,
    };
  };
}

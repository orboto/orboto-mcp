/**
 * ORB-543 / ORB-1344 — agent-drift admin MCP tools.
 *
 *  - `orboto_admin_agent_drift_list` — paginated drift log with filters
 *    (user, drift type, date range, resolved status) + aggregate metrics.
 *  - `orboto_admin_agent_drift_resolve` — mark one drift event handled.
 *
 * Both wrap `/admin/agent-drift*` and require `admin:agent_drift:read` /
 * `admin:agent_drift:write` (super-admin holds both).
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';

interface DriftEvent {
  id: string;
  userId: string;
  userName: string | null;
  userEmail: string | null;
  userIsBot: boolean;
  projectId: string;
  projectKey: string | null;
  driftType: 'untracked_commit' | 'transition_without_summary';
  commitSha: string | null;
  repoUrl: string | null;
  commitMessage: string | null;
  pushId: string | null;
  ticketId: string | null;
  ticketKey: string | null;
  detectedAt: string;
  resolvedAt: string | null;
  retroTicketId: string | null;
  retroTicketKey: string | null;
}

interface DriftListResponse {
  items: DriftEvent[];
  nextCursor: string | null;
  metrics: {
    total: number;
    byType: Record<string, number>;
    byUser: Array<{ userId: string; userName: string | null; userEmail: string | null; count: number }>;
  };
  enabled: boolean;
}

export const listAgentDriftToolConfig = {
  title: 'List agent drift events',
  description:
    'List agent drift events (commits with no ticket key + no timer, or ticket transitions without a summary comment), newest first, with aggregate metrics. Filter by `userId`, `driftType` (untracked_commit | transition_without_summary), `from`/`to` ISO dates, and `resolved`. The response `enabled` flag is false when the operator has not turned drift detection on. Requires `admin:agent_drift:read`.',
  inputSchema: z.object({
    userId: z.string().uuid().optional().describe('Filter to one user.'),
    driftType: z.enum(['untracked_commit', 'transition_without_summary']).optional(),
    from: z.string().optional().describe('ISO timestamp lower bound (detected_at).'),
    to: z.string().optional().describe('ISO timestamp upper bound (detected_at).'),
    resolved: z.boolean().optional().describe('true = only resolved, false = only open.'),
    limit: z.number().int().min(1).max(200).optional().describe('Default: 50.'),
    cursor: z.string().optional().describe('Opaque cursor from a previous response.'),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeListAgentDriftHandler(client: OrbotoClient) {
  return async (args: {
    userId?: string;
    driftType?: 'untracked_commit' | 'transition_without_summary';
    from?: string;
    to?: string;
    resolved?: boolean;
    limit?: number;
    cursor?: string;
  }): Promise<CallToolResult> => {
    const qs = new URLSearchParams();
    if (args.userId) qs.set('userId', args.userId);
    if (args.driftType) qs.set('driftType', args.driftType);
    if (args.from) qs.set('from', args.from);
    if (args.to) qs.set('to', args.to);
    if (args.resolved !== undefined) qs.set('resolved', String(args.resolved));
    if (args.limit) qs.set('limit', String(args.limit));
    if (args.cursor) qs.set('cursor', args.cursor);
    const path = `/admin/agent-drift${qs.toString() ? `?${qs.toString()}` : ''}`;
    const res = await client.get<DriftListResponse>(path);
    const header = res.enabled ? '' : '(drift detection is currently DISABLED — showing historical rows only)\n';
    const lines = res.items.length === 0
      ? '(no drift events)'
      : res.items.map((e) => {
        const who = e.userName ?? e.userEmail ?? e.userId.slice(0, 8);
        const where = e.driftType === 'untracked_commit'
          ? `${e.commitSha?.slice(0, 8) ?? '?'} on ${e.repoUrl ?? '?'}`
          : `transition on ${e.ticketKey ?? e.ticketId?.slice(0, 8) ?? '?'}`;
        const state = e.resolvedAt ? 'resolved' : (e.retroTicketKey ? `retro ${e.retroTicketKey}` : 'open');
        return `- [${e.id.slice(0, 8)}] ${e.driftType} — ${who} — ${where} (${state}, ${e.detectedAt})`;
      }).join('\n');
    const metrics = `\n\nTotals: ${res.metrics.total} | ${Object.entries(res.metrics.byType).map(([k, v]) => `${k}=${v}`).join(', ')}`;
    return {
      content: [{ type: 'text', text: header + lines + metrics + (res.nextCursor ? `\n\n(next cursor: ${res.nextCursor})` : '') }],
      structuredContent: res as unknown as Record<string, unknown>,
    };
  };
}

export const resolveAgentDriftToolConfig = {
  title: 'Resolve an agent drift event',
  description:
    'Mark one agent drift event handled (stamps resolved_at). Idempotent. 404 if the id is unknown. Requires `admin:agent_drift:write`.',
  inputSchema: z.object({
    id: z.string().uuid().describe('UUID of the drift event to resolve.'),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
};

export function makeResolveAgentDriftHandler(client: OrbotoClient) {
  return async ({ id }: { id: string }): Promise<CallToolResult> => {
    const res = await client.post<{ id: string; resolvedAt: string | null }>(`/admin/agent-drift/${id}/resolve`, {});
    return {
      content: [{ type: 'text', text: `Resolved drift event ${id} at ${res.resolvedAt}.` }],
      structuredContent: res,
    };
  };
}

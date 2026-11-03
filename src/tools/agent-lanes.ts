/**
 * ORB-2818 - pause, resume and stop an agent lane: the pause holds the work session at the next turn boundary, the stop interrupts the running turn now.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OrbotoApiError, type OrbotoClient } from '../orboto-client.js';

type LaneControlAction = 'pause' | 'resume' | 'stop';

interface LaneRow {
  id: string;
  name: string;
  status: 'idle' | 'working';
  online: boolean;
  paused: boolean;
  stopRequestedAt: string | null;
  currentTicketKey: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LANE_PARAM = 'Lane name (any case) or UUID.';
const REASON_PARAM = 'Why (audited, max 500).';
const LIST_LANES_LIMIT = 20;

export const laneControlToolConfig = {
  title: 'Pause or resume an agent lane',
  description:
    'Pause an agent lane at its next turn boundary (the running turn finishes, the work session is held) or resume it (the held task continues in the same session); orboto_lane_stop interrupts the running turn instead. A pause records the turn\'s usage and starts no new turn or task until resume; resume also clears a pending stop. Needs admin:agent_lanes:write, audited as agent_lane.paused or agent_lane.resumed.',
  inputSchema: z.object({
    lane: z.string().trim().min(1).max(64).describe(LANE_PARAM),
    action: z.enum(['pause', 'resume']),
    reason: z.string().trim().max(500).optional().describe(REASON_PARAM),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

export const laneStopToolConfig = {
  title: 'Stop an agent lane now',
  description:
    'Stop an agent lane now: its runner interrupts the running turn at its next heartbeat (the poll interval of the runner), releases the work session and records the task as interrupted; the lane stays paused until resume. The next run of that task is a new attempt that first inspects the saved effects; orboto_lane_pause waits for the turn boundary instead. Needs admin:agent_lanes:write, audited as agent_lane.stopped.',
  inputSchema: z.object({
    lane: z.string().trim().min(1).max(64).describe(LANE_PARAM),
    reason: z.string().trim().max(500).optional().describe(REASON_PARAM),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
};

async function resolveLaneId(client: OrbotoClient, ref: string): Promise<string> {
  if (UUID_RE.test(ref)) return ref;
  const list = await client.get<{ items: LaneRow[] }>('/admin/agent-lanes').catch((err: unknown) => {
    if (err instanceof OrbotoApiError && err.status === 403) {
      throw new Error('Resolving a lane name needs admin:agent_lanes:read; pass the lane UUID or ask an admin for the permission.');
    }
    throw err as Error;
  });
  const exact = list.items.filter((l) => l.name === ref);
  const matches = exact.length > 0 ? exact : list.items.filter((l) => l.name.toLowerCase() === ref.toLowerCase());
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length > 1) {
    throw new Error(`Lane name "${ref}" is ambiguous (${matches.map((l) => `"${l.name}"`).join(', ')}); pass the exact name or the UUID.`);
  }
  const names = list.items.map((l) => `"${l.name}"`).sort();
  const shown = names.slice(0, LIST_LANES_LIMIT).join(', ') || '(none)';
  throw new Error(`No agent lane named "${ref}". Existing lanes: ${shown}${names.length > LIST_LANES_LIMIT ? `, and ${names.length - LIST_LANES_LIMIT} more` : ''}.`);
}

function sentence(action: LaneControlAction, lane: LaneRow): string {
  const label = `Lane "${lane.name}"`;
  if (action === 'resume') {
    return `${label} resumed: a held task continues in the same work session, with no new attempt.`;
  }
  if (action === 'pause') {
    if (lane.stopRequestedAt) {
      return `${label} paused, but a stop now is still pending; resume clears it (orboto_lane_pause with action resume).`;
    }
    const running = lane.status === 'working'
      ? `: the running turn${lane.currentTicketKey ? ` on ${lane.currentTicketKey}` : ''} finishes and the work session is held`
      : '';
    return `${label} paused at the next turn boundary${running}. No new turn or task starts until orboto_lane_pause with action resume.`;
  }
  return `${label} stopped now: the runner interrupts the running turn at its next heartbeat (the runner's poll interval), releases the work session and records the task as interrupted. The lane stays paused until orboto_lane_pause with action resume; the next run of that task is a new attempt.`;
}

async function control(
  client: OrbotoClient,
  action: LaneControlAction,
  args: { lane: string; reason?: string },
): Promise<CallToolResult> {
  const ref = args.lane.trim();
  const id = await resolveLaneId(client, ref);
  const reason = args.reason?.trim();
  const lane = await client.post<LaneRow>(
    `/admin/agent-lanes/${id}/${action}`,
    reason ? { reason } : {},
  ).catch((err: unknown) => {
    if (err instanceof OrbotoApiError && err.status === 403) {
      throw new Error(`Lane ${action} requires the admin:agent_lanes:write permission on this workspace.`);
    }
    if (err instanceof OrbotoApiError && err.status === 404) {
      throw new Error(`No agent lane with id ${id}.`);
    }
    throw err as Error;
  });
  return {
    content: [{ type: 'text', text: sentence(action, lane) }],
    structuredContent: {
      action,
      lane: {
        id: lane.id,
        name: lane.name,
        status: lane.status,
        online: lane.online,
        paused: lane.paused,
        stopRequestedAt: lane.stopRequestedAt ?? null,
        currentTicketKey: lane.currentTicketKey ?? null,
      },
    },
  };
}

export function makeLaneControlHandler(client: OrbotoClient) {
  return (args: { lane: string; action: 'pause' | 'resume'; reason?: string }): Promise<CallToolResult> =>
    control(client, args.action, args);
}

export function makeLaneStopHandler(client: OrbotoClient) {
  return (args: { lane: string; reason?: string }): Promise<CallToolResult> => control(client, 'stop', args);
}

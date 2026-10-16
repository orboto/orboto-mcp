/** ORB-2264 - the live directory: who a sender can address before sending. */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';
import { AgentSessionRoleSchema } from './agent-session-scope.js';
import { ownerLine, type OwnerMatch } from './responsibilities.js';
import { originText, type SessionOrigin } from './agent-coordination.js';

interface WhoEntry {
  sessionId: string;
  shortId: string;
  email: string;
  role: string | null;
  projectKeys: string[];
  addresses: string[];
  lastSeenAt: string;
  channel: { announced: string | null; online: boolean };
  currentTicket: { key: string | null; title: string } | null;
  status: string;
  host?: string | null;
  origin?: SessionOrigin;
  state?: string;
  sharedAddresses?: string[];
}

export const agentWhoToolConfig = {
  title: 'Who receives agent mail',
  description: 'Live agent sessions and the role addresses (integrator@KEY) they answer to. Each row names account, role, declared projects, last seen, wake channel and current ticket; address a role from here, never a session id copied from a log. `for` (free text) names the topic owner and keeps its sessions; `state` keeps one state (orphaned: only another process touches it).',
  inputSchema: z.object({
    project: z.string().min(1).max(64).optional(),
    role: AgentSessionRoleSchema.optional(),
    for: z.string().min(2).max(2000).optional(),
    state: z.enum(['live', 'quiet', 'orphaned', 'unknown_origin']).optional(),
  }).shape,
  outputSchema: z.object({ sessions: z.array(z.unknown()), owner: z.unknown().optional() }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

/** One directory row as a line: address, account, session, projects, channel, ticket. */
export function whoLine(s: WhoEntry): string {
  const address = s.addresses.join(', ') || (s.role ? `${s.role} (no project)` : 'no scope');
  const channel = s.channel.announced ? `${s.channel.announced}${s.channel.online ? ' online' : ' offline'}` : 'no channel';
  const ticket = s.currentTicket ? `; on ${s.currentTicket.key ?? s.currentTicket.title}` : '';
  const host = s.origin ? originText(s) : s.host ? `, host ${s.host}` : '';
  const shared = s.sharedAddresses?.length ? `; also held by another live session: ${s.sharedAddresses.join(', ')}` : '';
  return `- ${address} - ${s.email} session ${s.shortId}${host}, ${s.status}, ${channel}, last seen ${s.lastSeenAt}${ticket}${shared}`;
}

export function makeAgentWhoHandler(client: OrbotoClient) {
  return async (args: { project?: string; role?: string; for?: string; state?: string } = {}): Promise<CallToolResult> => {
    const qs = new URLSearchParams();
    if (args.state) qs.set('state', args.state);
    if (args.project) qs.set('project', args.project);
    if (args.role) qs.set('role', args.role);
    if (args.for) qs.set('for', args.for);
    const res = await client.get<{ sessions: WhoEntry[]; owner?: OwnerMatch | null }>(`/v1/agent/who${qs.size ? `?${qs.toString()}` : ''}`);
    const ownerLines = args.for
      ? [res.owner ? `Owner:\n${ownerLine(res.owner)}` : `No entry in the responsibility map matches "${args.for}".`]
      : [];
    const lines = res.sessions.length
      ? [...ownerLines, `${res.sessions.length} live session(s):`, ...res.sessions.map(whoLine)]
      : [...ownerLines, res.owner ? `No live session answers to ${res.owner.entry.ownerAddress} - send with queue: true and project ${res.owner.entry.ownerAddress.split('@')[1]} to keep it until one declares it.` : 'No live session matches - a request sent now answers no_recipient unless it is queued.'];
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { sessions: res.sessions as unknown as Array<Record<string, unknown>>, ...(args.for ? { owner: (res.owner ?? null) as Record<string, unknown> | null } : {}) },
    };
  };
}

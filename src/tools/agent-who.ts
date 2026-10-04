/** ORB-2264 - the live directory: who a sender can address before sending. */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';
import { AgentSessionRoleSchema } from './agent-session-scope.js';

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
}

export const agentWhoToolConfig = {
  title: 'Who can receive agent mail',
  description: 'Live agent sessions and the role addresses (integrator@KEY) they answer to. Each row names account, role, declared projects, last seen, wake channel and current ticket; address a role from here, never a session id copied from a log.',
  inputSchema: z.object({
    project: z.string().min(1).max(64).optional(),
    role: AgentSessionRoleSchema.optional(),
  }).shape,
  outputSchema: z.object({ sessions: z.array(z.record(z.string(), z.unknown())) }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

/** One directory row as a line: address, account, session, projects, channel, ticket. */
export function whoLine(s: WhoEntry): string {
  const address = s.addresses.join(', ') || (s.role ? `${s.role} (no project)` : 'no scope');
  const channel = s.channel.announced ? `${s.channel.announced}${s.channel.online ? ' online' : ' offline'}` : 'no channel';
  const ticket = s.currentTicket ? `; on ${s.currentTicket.key ?? s.currentTicket.title}` : '';
  const host = s.host ? `, host ${s.host}` : '';
  return `- ${address} - ${s.email} session ${s.shortId}${host}, ${s.status}, ${channel}, last seen ${s.lastSeenAt}${ticket}`;
}

export function makeAgentWhoHandler(client: OrbotoClient) {
  return async (args: { project?: string; role?: string } = {}): Promise<CallToolResult> => {
    const qs = new URLSearchParams();
    if (args.project) qs.set('project', args.project);
    if (args.role) qs.set('role', args.role);
    const res = await client.get<{ sessions: WhoEntry[] }>(`/v1/agent/who${qs.size ? `?${qs.toString()}` : ''}`);
    const lines = res.sessions.length
      ? [`${res.sessions.length} live session(s):`, ...res.sessions.map(whoLine)]
      : ['No live session matches - a request sent now answers no_recipient unless it is queued.'];
    return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: { sessions: res.sessions as unknown as Array<Record<string, unknown>> } };
  };
}

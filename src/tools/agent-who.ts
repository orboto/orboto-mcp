/** ORB-2264 - the live directory: who a sender can address before sending. */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';
import { ownerLine, type OwnerMatch } from './responsibilities.js';
import { nextPageLine, originText, PresenceFilterShape, presenceQuery, readPresence, unknownProjectText, type PresenceFilters, type SessionOrigin } from './agent-coordination.js';
import { AGENT_WAKE_LABELS, type AgentSessionWake } from './agent-presence-schema.js';

interface WhoEntry {
  sessionId: string;
  shortId: string;
  email: string;
  role: string | null;
  projectKeys: string[];
  addresses: string[];
  lastSeenAt: string;
  channel: { announced: string | null; online: boolean };
  wake?: AgentSessionWake;
  currentTicket: { key: string | null; title: string } | null;
  status: string;
  host?: string | null;
  origin?: SessionOrigin;
  state?: string;
  sharedAddresses?: string[];
}

/** ORB-2553 - one account's refused heartbeats in the last 24 hours. */
export interface PresenceRefusalEntry {
  email: string; count: number; scopeRequired: number; sessionExists: number; lastAt: string; lastReason: string;
  lastHost: string | null; lastRepo: string | null; lastHarness: string | null;
}

export function refusalLines(refusals: PresenceRefusalEntry[] | undefined): string[] {
  if (!refusals?.length) return [];
  return ['Refused heartbeats in the last 24 hours (no role address, not listed):', ...refusals.map((r) => {
    const where = [r.lastHost, r.lastRepo].filter(Boolean).join('/') || 'unknown origin';
    return `- ${r.email}: ${r.count} (no scope ${r.scopeRequired}, second start ${r.sessionExists}), last ${r.lastAt} from ${where}${r.lastHarness ? ` (${r.lastHarness})` : ''}`;
  })];
}

export const agentWhoToolConfig = {
  title: 'Who receives agent mail',
  description: 'Live agent sessions and the role addresses (integrator@KEY) they answer to. GET /v1/agent/who; each row names account, role, declared projects, last seen, wake channel and current ticket; address a role from here, never a session id copied from a log. A session without a declared scope is not listed; the refused heartbeats of the last 24 hours follow per account (refusals). `for` (free text) names the topic owner and keeps its sessions; `state` keeps one state (orphaned: only another process touches it); email, sessionId (id or 8+ character prefix), kind and wake narrow on the server; 4 rows a page, nextCursor continues (cursor); a project that is unknown or not visible to you answers so in one line.',
  inputSchema: z.object({
    project: z.string().min(1).max(64).optional(),
    for: z.string().min(2).max(2000).optional(),
    ...PresenceFilterShape,
  }).shape,
  outputSchema: z.object({ sessions: z.array(z.unknown()), owner: z.unknown().optional(), nextCursor: z.string().nullable(), refusals: z.array(z.unknown()).optional() }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

/** One directory row as a line: address, account, session, projects, channel, ticket. */
export function whoLine(s: WhoEntry): string {
  const address = s.addresses.join(', ') || (s.role ? `${s.role} (no project)` : 'no scope');
  const announced = s.channel.announced ? `${s.channel.announced}${s.channel.online ? ' online' : ' offline'}` : 'no channel';
  const channel = s.wake === 'channel' || !s.wake ? announced : AGENT_WAKE_LABELS[s.wake];
  const ticket = s.currentTicket ? `; on ${s.currentTicket.key ?? s.currentTicket.title}` : '';
  const host = s.origin ? originText(s) : s.host ? `, host ${s.host}` : '';
  const shared = s.sharedAddresses?.length ? `; also held by another live session: ${s.sharedAddresses.join(', ')}` : '';
  return `- ${address} - ${s.email} session ${s.shortId}${host}, ${s.status}, ${channel}, last seen ${s.lastSeenAt}${ticket}${shared}`;
}

export function makeAgentWhoHandler(client: OrbotoClient) {
  return async (args: PresenceFilters = {}): Promise<CallToolResult> => {
    const res = await readPresence<{ sessions: WhoEntry[]; owner?: OwnerMatch | null; nextCursor?: string | null; refusals?: PresenceRefusalEntry[] }>(client, `/v1/agent/who?${presenceQuery(args)}`, args.project);
    if (!res) return { content: [{ type: 'text', text: unknownProjectText(args.project!) }], structuredContent: { sessions: [], nextCursor: null } };
    const ownerLines = args.for
      ? [res.owner ? `Owner:\n${ownerLine(res.owner)}` : `No entry in the responsibility map matches "${args.for}".`]
      : [];
    const lines = res.sessions.length
      ? [...ownerLines, `${res.sessions.length} live session(s)${res.nextCursor ? ' on this page' : ''}:`, ...res.sessions.map(whoLine), ...nextPageLine(res.nextCursor)]
      : [...ownerLines, res.owner ? `No live session answers to ${res.owner.entry.ownerAddress} - send with queue: true and project ${res.owner.entry.ownerAddress.split('@')[1]} to keep it until one declares it.` : 'No live session matches - a request sent now answers no_recipient unless it is queued.'];
    lines.push(...refusalLines(res.refusals));
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { sessions: res.sessions as unknown as Array<Record<string, unknown>>, ...(args.for ? { owner: (res.owner ?? null) as Record<string, unknown> | null } : {}), nextCursor: res.nextCursor ?? null, ...(res.refusals?.length ? { refusals: res.refusals as unknown as Array<Record<string, unknown>> } : {}) },
    };
  };
}

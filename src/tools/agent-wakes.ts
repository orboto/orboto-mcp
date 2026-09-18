/**
 * ORB-2149 - the wake ledger: what woke this session, by which rule, what it
 * did with it and what it cost.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';

interface WakeRow {
  id: string;
  messageId: string;
  subject: string;
  kind: string;
  sessionId: string;
  senderLabel: string;
  projectKey: string | null;
  transport: string;
  rule: string;
  outcome: string;
  wokenAt: string;
  latencyMs: number | null;
  contextTokens: number | null;
}

interface StatsEntry {
  sessionId: string | null;
  label: string;
  wakes: number;
  handled: number;
  notMine: number;
  precision: number | null;
  medianLatencyMs: number | null;
  wrongWakeContextTokens: number;
  topRule: string | null;
}

export const agentWakesToolConfig = {
  title: 'Wake ledger',
  description:
    'Who woke this account\'s sessions, which visibility rule delivered the message (addressed | scope_project | scope_ticket | broadcast | unscoped_session | account_view), what the woken session did with it (handled | not_mine | obsolete | duplicate | expired | pending) and what the wake cost in context tokens. `stats: true` returns delivery precision per woken session and per sender over `hours` (operator read, needs admin:agents:read); without it the ledger rows of your own account, newest first. Use it to prove a misrouting sender instead of describing it in prose.',
  inputSchema: z.object({
    stats: z.boolean().default(false).describe('Precision per session and per sender instead of rows.'),
    hours: z.number().int().min(1).max(720).optional().describe('Stats window, default 24.'),
    sessionId: z.string().uuid().optional().describe('Narrow to one woken session.'),
    project: z.string().min(1).max(64).optional().describe('Project key or UUID.'),
    outcome: z.enum(['pending', 'handled', 'not_mine', 'obsolete', 'duplicate', 'expired']).optional(),
    limit: z.number().int().min(1).max(200).optional().describe('Default: 50.'),
    cursor: z.string().optional().describe('Opaque cursor from a previous response.'),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

function statsLine(e: StatsEntry): string {
  const precision = e.precision === null ? 'unjudged' : `${Math.round(e.precision * 100)}%`;
  const tokens = e.wrongWakeContextTokens > 0 ? `, wrong wakes cost ${e.wrongWakeContextTokens} tokens` : '';
  return `- ${e.label}: ${e.wakes} wakes, precision ${precision}, median ${e.medianLatencyMs ?? '?'} ms, top rule ${e.topRule ?? '-'}${tokens}`;
}

export function makeAgentWakesHandler(client: OrbotoClient) {
  return async (args: {
    stats?: boolean; hours?: number; sessionId?: string; project?: string;
    outcome?: string; limit?: number; cursor?: string;
  }): Promise<CallToolResult> => {
    const qs = new URLSearchParams();
    if (args.sessionId) qs.set('sessionId', args.sessionId);
    if (args.stats) {
      if (args.hours) qs.set('hours', String(args.hours));
      const res = await client.get<{ hours: number; sessions: StatsEntry[]; senders: StatsEntry[] }>(
        `/admin/agents/wake-stats${qs.toString() ? `?${qs.toString()}` : ''}`,
      );
      const text = [
        `Last ${res.hours} h - woken sessions:`,
        ...(res.sessions.length ? res.sessions.map(statsLine) : ['- (no wakes)']),
        'Senders:',
        ...(res.senders.length ? res.senders.map(statsLine) : ['- (none)']),
      ].join('\n');
      return { content: [{ type: 'text', text }], structuredContent: res as unknown as Record<string, unknown> };
    }
    if (args.project) qs.set('project', args.project);
    if (args.outcome) qs.set('outcome', args.outcome);
    if (args.limit) qs.set('limit', String(args.limit));
    if (args.cursor) qs.set('cursor', args.cursor);
    const res = await client.get<{ rows: WakeRow[]; nextCursor: string | null }>(
      `/v1/agent/wakes${qs.toString() ? `?${qs.toString()}` : ''}`,
    );
    const lines = res.rows.length === 0
      ? '(no wakes recorded)'
      : res.rows.map((r) => `- ${r.wokenAt} ${r.subject} - from ${r.senderLabel} via ${r.rule}/${r.transport} -> ${r.outcome}`
        + `${r.latencyMs === null ? '' : ` (${r.latencyMs} ms`}${r.contextTokens === null ? r.latencyMs === null ? '' : ')' : `, ${r.contextTokens} ctx tokens)`}`).join('\n');
    return {
      content: [{ type: 'text', text: lines + (res.nextCursor ? `\n\n(next cursor: ${res.nextCursor})` : '') }],
      structuredContent: res as unknown as Record<string, unknown>,
    };
  };
}

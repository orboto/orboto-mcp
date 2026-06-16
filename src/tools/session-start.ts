/**
 * ORB-1093 — `orboto_session_start`: a re-orientation digest for the
 * start of a session AND right after a context compaction, the points
 * where coding agents lose the thread. Composes the workspace
 * working-rules + the caller's in-progress work + timer into one
 * briefing so the agent re-anchors on how to work and what it was
 * doing. Read-only.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';

export const sessionStartToolConfig = {
  title: 'Re-orient: workspace rules + your in-progress work',
  description:
    'Run at the START of a session and immediately AFTER any context compaction. Returns the workspace working-rules to follow, your in-progress tickets, and your running timer — the briefing that keeps you from losing the thread. Read-only; no side effects.',
  inputSchema: z.object({ projectId: z.string().uuid().optional().describe('Include this project\'s rules too (workspace + project + your personal).') }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

interface Me { email?: string; fullName?: string; locale?: string; workspaceLocale?: string }
interface Ticket { ticketKey: string; title: string; status?: string; statusName?: string }
interface Timer { ticketId?: string | null; ticketKey?: string; startedAt?: string }

export function makeSessionStartHandler(client: OrbotoClient) {
  return async (input: { projectId?: string } = {}): Promise<CallToolResult> => {
    const rulesPath = input.projectId ? `/agent-instructions?projectId=${input.projectId}` : '/agent-instructions';
    const [me, rules, assigned, timer] = await Promise.all([
      client.get<Me>('/users/me').catch(() => null),
      client.get<{ instructions: string }>(rulesPath).catch(() => ({ instructions: '' })),
      client.get<{ items?: Ticket[] } | Ticket[]>('/users/me/assigned-tickets?limit=10').catch(() => ({ items: [] })),
      client.get<Timer>('/time/timer').catch(() => null),
    ]);
    const tickets: Ticket[] = Array.isArray(assigned) ? assigned : (assigned?.items ?? []);
    const lines: string[] = ['# orboto session start'];
    if (me) lines.push(`You are ${me.fullName ?? me.email}${me.email ? ` (${me.email})` : ''}.`);
    if (me?.workspaceLocale || me?.locale) lines.push(`Write tickets / comments / docs in: ${me.workspaceLocale ?? me.locale}.`);
    lines.push('', '## Working rules — follow these', rules?.instructions?.trim() || '(no workspace rules configured)');
    lines.push('', '## Your in-progress work');
    if (tickets.length === 0) lines.push('No tickets currently assigned to you — claim or create one before you start coding.');
    else for (const t of tickets) lines.push(`- ${t.ticketKey} [${t.statusName ?? t.status}] ${t.title}`);
    lines.push('', '## Timer');
    lines.push(timer?.ticketId ? `Running on ${timer.ticketKey ?? timer.ticketId} since ${timer.startedAt ?? 'earlier'}.` : 'No timer running.');
    lines.push('', 'Re-run this after any context compaction to re-sync.');
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: {
        rules: rules?.instructions ?? '',
        inProgress: tickets.map((t) => ({ ticketKey: t.ticketKey, title: t.title, status: t.statusName ?? t.status ?? null })),
        timer: timer?.ticketId ? { ticketKey: timer.ticketKey ?? null, startedAt: timer.startedAt ?? null } : null,
      },
    };
  };
}

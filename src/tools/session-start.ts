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
  title: 'Load the rules you must follow + re-orient',
  description:
    'THE canonical way to LOAD the binding workspace rules you must follow as an agent. Run it as your FIRST action in a session and immediately AFTER any context compaction. Returns the complete assembled working-rules, your in-progress tickets, and your running timer. (Do NOT use orboto_list_agent_instructions to read the rules — that tool MANAGES/edits rule blocks for admins; this one is what you read to know how to work.) Read-only; no side effects.',
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
      // ORB-1330 — a re-orientation briefing must only list OPEN work.
      // Filter to in_progress + in_review so DONE tickets can't pose as
      // "what you're working on" at the moment the agent has the least
      // context and would otherwise re-claim / re-report finished work.
      // Cap 20.
      client.get<{ items?: Ticket[] } | Ticket[]>('/users/me/assigned-tickets?statuses=IN_PROGRESS,IN_REVIEW&limit=20').catch(() => ({ items: [] })),
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

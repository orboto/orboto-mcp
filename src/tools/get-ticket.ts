/**
 * ORB-244 Phase B — `orbit_get_ticket`.
 *
 * Returns a ticket's full context — description, comments, assignees,
 * labels, checklists, git activity — in a shape the model can
 * reason about without follow-up calls. Comments and checklists are
 * fetched in parallel with the ticket payload; git activity is
 * skipped when the ticket's `gitActivityCount` is 0 so we don't waste
 * a round-trip on the common case.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OrbitApiError, type OrbitClient } from '../orbit-client.js';
import { resolveTicketByKey, type TicketRow } from './shared.js';

interface CommentRow {
  id: string;
  body: string;
  isInternal: boolean;
  createdAt: string;
  authorName: string | null;
  authorEmail: string | null;
}
interface ChecklistRow {
  id: string;
  title: string;
  triggersDone: boolean;
  items: Array<{ id: string; content: string; done: boolean }>;
}
interface GitActivityRow {
  type: string;
  externalId: string;
  title: string;
  authorName: string | null;
  state: string | null;
  createdAt: string;
  url: string | null;
}

export const getTicketToolConfig = {
  title: 'Get ticket details',
  description:
    'Return a ticket including description, comments, assignees, labels, checklists, and git activity. Input is the ticket key like "ACME-42".',
  inputSchema: z.object({
    ticketKey: z.string().min(3).describe('Ticket key like "ACME-42".'),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeGetTicketHandler(client: OrbitClient) {
  return async ({ ticketKey }: { ticketKey: string }): Promise<CallToolResult> => {
    const ticket = await resolveTicketByKey(client, ticketKey);

    // Parallel fan-out for the three sub-resources. Git activity is a
    // conditional fourth call — skipped when the ticket has no linked
    // commits/PRs because that's the common case.
    const needGit = (ticket as unknown as { gitActivityCount?: number }).gitActivityCount
      ? ((ticket as unknown as { gitActivityCount: number }).gitActivityCount > 0)
      : false;
    const [comments, checklists, gitActivity] = await Promise.all([
      client.get<CommentRow[]>(`/tickets/${ticket.id}/comments`).catch(swallow404([])),
      client.get<ChecklistRow[]>(`/tickets/${ticket.id}/checklists`).catch(swallow404([])),
      needGit
        ? client.get<GitActivityRow[]>(`/tickets/${ticket.id}/git-activity`).catch(swallow404([]))
        : Promise.resolve([]),
    ]);

    return {
      content: [{ type: 'text', text: formatTicket(ticket, comments, checklists, gitActivity) }],
      structuredContent: {
        key: ticket.ticketKey,
        title: ticket.title,
        status: ticket.statusName ?? ticket.status,
        statusCategory: ticket.statusCategory ?? null,
        priority: ticket.priority,
        type: ticket.type,
        dueDate: ticket.dueDate,
        startDate: ticket.startDate,
        isPrivate: ticket.isPrivate,
        estimatedTimeMinutes: ticket.estimatedTimeMinutes,
        loggedMinutes: ticket.loggedMinutes ?? 0,
        description: ticket.description ?? null,
        assignees: ticket.assignees ?? [],
        labels: (ticket.labels ?? []).map((l) => l.name),
        comments: comments.map((c) => ({
          author: c.authorName ?? c.authorEmail,
          body: c.body,
          createdAt: c.createdAt,
          isInternal: c.isInternal,
        })),
        checklists: checklists.map((cl) => ({
          title: cl.title,
          triggersDone: cl.triggersDone,
          items: cl.items.map((i) => ({ content: i.content, done: i.done })),
        })),
        gitActivity: gitActivity.map((g) => ({
          type: g.type,
          state: g.state,
          title: g.title,
          url: g.url,
          author: g.authorName,
          createdAt: g.createdAt,
        })),
      },
    };
  };
}

function swallow404<T>(fallback: T): (err: unknown) => T {
  return (err) => {
    if (err instanceof OrbitApiError && err.status === 404) return fallback;
    throw err;
  };
}

function formatTicket(
  ticket: TicketRow,
  comments: CommentRow[],
  checklists: ChecklistRow[],
  gitActivity: GitActivityRow[],
): string {
  const header = [
    `[${ticket.ticketKey}] ${ticket.title}`,
    `Status: ${ticket.statusName ?? ticket.status}  Priority: ${ticket.priority}  Type: ${ticket.type}`,
    ticket.dueDate ? `Due: ${ticket.dueDate}` : null,
    ticket.assignees && ticket.assignees.length > 0
      ? `Assignees: ${ticket.assignees.map((a) => a.fullName || a.email).join(', ')}`
      : 'Assignees: (unassigned)',
    ticket.labels && ticket.labels.length > 0
      ? `Labels: ${ticket.labels.map((l) => l.name).join(', ')}`
      : null,
  ].filter((s): s is string => s !== null);

  const description = ticket.description
    ? ['', '## Description', ticket.description]
    : [];

  const checklistLines: string[] = [];
  if (checklists.length > 0) {
    checklistLines.push('', '## Checklists');
    for (const cl of checklists) {
      checklistLines.push(
        `### ${cl.title}${cl.triggersDone ? ' (triggers done)' : ''}`,
        ...cl.items.map((i) => `- [${i.done ? 'x' : ' '}] ${i.content}`),
      );
    }
  }

  const commentLines: string[] = [];
  if (comments.length > 0) {
    commentLines.push('', `## Comments (${comments.length})`);
    for (const c of comments) {
      commentLines.push(
        `**${c.authorName ?? c.authorEmail ?? '(unknown)'}** — ${c.createdAt}${c.isInternal ? ' [internal]' : ''}`,
        c.body,
        '',
      );
    }
  }

  const gitLines: string[] = [];
  if (gitActivity.length > 0) {
    gitLines.push('', `## Git activity (${gitActivity.length})`);
    for (const g of gitActivity) {
      gitLines.push(`- ${g.type} ${g.state ? `[${g.state}]` : ''} ${g.title}${g.url ? ` — ${g.url}` : ''}`);
    }
  }

  return [...header, ...description, ...checklistLines, ...commentLines, ...gitLines].join('\n');
}

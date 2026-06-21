/**
 * ORB-244 Phase B — `orboto_get_ticket`.
 *
 * Returns a ticket's full context — description, comments, assignees,
 * labels, checklists, git activity — in a shape the model can
 * reason about without follow-up calls. Comments and checklists are
 * fetched in parallel with the ticket payload; git activity is
 * skipped when the ticket's `gitActivityCount` is 0 so we don't waste
 * a round-trip on the common case.
 *
 * ORB-272: `/tickets/:id/comments` is cursor-paginated. We pull the
 * first page (50 by default) — if the ticket has more, a footer line
 * nudges the user to open it in the UI. AI agents asking "give me
 * the full history" beyond 50 is a rare enough case not to fan out.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OrbotoApiError, type OrbotoClient } from '../orboto-client.js';
import { resolveTicketByKey, type TicketRow } from './shared.js';

interface TicketSummaryRow {
  id: string;
  ticketKey: string | null;
  title: string;
  status: string;
  statusName?: string;
  statusCategory?: string;
}

/** Matches `CommentSchema` in @orboto/shared-schema. */
interface CommentRow {
  id: string;
  ticketId: string;
  userId: string;
  content: string;
  isInternal: boolean;
  createdAt: string;
  editedAt?: string | null;
  userName?: string | null;
}
/** ORB-234 — checklist items can link to another ticket; when they do,
 *  `effectiveCompleted` tracks the linked ticket's status category
 *  automatically ('done' → item checked). `storedCompleted` is the
 *  raw bit on this item's own row. The model wants the effective
 *  value because that's what renders in the UI. */
interface ChecklistItemRow {
  id: string;
  content: string;
  storedCompleted: boolean;
  effectiveCompleted: boolean;
  linkedTicketId: string | null;
  linkedTicketKey: string | null;
  linkedTicketTitle: string | null;
  linkedTicketStatusCategory: string | null;
}
interface ChecklistRow {
  id: string;
  title: string;
  triggersDone: boolean;
  progress: { done: number; total: number };
  items: ChecklistItemRow[];
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
interface CursorPage<T> { items: T[]; nextCursor: string | null }

const COMMENT_PAGE_SIZE = 50;

export const getTicketToolConfig = {
  title: 'Get ticket details',
  description:
    'Return a ticket including description, comments, assignees, labels, checklists, git activity, parent ticket (if any), and sub-tickets. Input is the ticket key like "ACME-42".',
  inputSchema: z.object({
    ticketKey: z.string().min(3).describe('Ticket key like "ACME-42".'),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeGetTicketHandler(client: OrbotoClient) {
  return async ({ ticketKey }: { ticketKey: string }): Promise<CallToolResult> => {
    const ticket = await resolveTicketByKey(client, ticketKey);

    const gitCount = (ticket as unknown as { gitActivityCount?: number }).gitActivityCount ?? 0;
    const parentId = ticket.parentTicketId ?? null;

    const [commentsPage, checklists, gitActivity, parent, childrenPage, enriched] = await Promise.all([
      client.get<CursorPage<CommentRow>>(
        `/tickets/${ticket.id}/comments?limit=${COMMENT_PAGE_SIZE}`,
      ).catch(swallow404<CursorPage<CommentRow>>({ items: [], nextCursor: null })),
      client.get<ChecklistRow[]>(`/tickets/${ticket.id}/checklists`).catch(swallow404<ChecklistRow[]>([])),
      gitCount > 0
        ? client.get<GitActivityRow[]>(`/tickets/${ticket.id}/git-activity`).catch(swallow404<GitActivityRow[]>([]))
        : Promise.resolve([]),
      // Parent ticket — only fetched when set. Lets the model say
      // "this is sub-ticket of [ACME-10]" without a second tool call.
      parentId
        ? client.get<TicketSummaryRow>(`/projects/${ticket.projectId}/tickets/${parentId}`).catch(swallow404<TicketSummaryRow | null>(null))
        : Promise.resolve(null),
      // Children via the new parentTicketId filter (API-side, O(children)).
      // Cap at 50; anything bigger should use `orboto_list_tickets
      // --parentTicketKey` and paginate explicitly.
      client.get<CursorPage<TicketSummaryRow>>(
        `/projects/${ticket.projectId}/tickets?parentTicketId=${ticket.id}&limit=50`,
      ).catch(swallow404<CursorPage<TicketSummaryRow>>({ items: [], nextCursor: null })),
      // ORB-1023 — `resolveTicketByKey` hits the by-key endpoint, which
      // returns a BARE ticket row (no statusCategory, assignees, labels,
      // milestoneName). Re-fetch the enriched by-id shape so the response
      // carries the full context. Kept LAST so existing call-order in tests
      // (comments, checklists, git, parent, children) is unaffected. Falls
      // back to the bare row on a 404.
      client.get<TicketRow>(`/projects/${ticket.projectId}/tickets/${ticket.id}`).catch(swallow404<TicketRow | null>(null)),
    ]);

    const comments = commentsPage.items;
    const hasMoreComments = !!commentsPage.nextCursor;
    const children = childrenPage.items;
    // ORB-1023 — prefer the enriched by-id row (statusCategory, assignees,
    // labels, milestoneName); fall back to the bare resolver row.
    const full = enriched ?? ticket;

    return {
      content: [{ type: 'text', text: formatTicket(full, comments, hasMoreComments, checklists, gitActivity, parent, children) }],
      structuredContent: {
        // ORB-1179 — surface the uuid alongside the key.
        id: full.id,
        key: full.ticketKey,
        title: full.title,
        status: full.statusName ?? full.status,
        statusCategory: full.statusCategory ?? null,
        milestone: full.milestoneId
          ? { id: full.milestoneId, name: full.milestoneName ?? null }
          : null,
        priority: full.priority,
        type: full.type,
        dueDate: full.dueDate,
        startDate: full.startDate,
        isPrivate: full.isPrivate,
        estimatedTimeMinutes: full.estimatedTimeMinutes,
        loggedMinutes: full.loggedMinutes ?? 0,
        description: full.description ?? null,
        // Hierarchy — null when no parent, array of summary rows for
        // children (empty array when none). Sub-ticket consumers can
        // decide to call orboto_get_ticket on each for the full detail.
        parentTicket: parent ? {
          key: parent.ticketKey,
          title: parent.title,
          status: parent.statusName ?? parent.status,
          statusCategory: parent.statusCategory ?? null,
        } : null,
        children: children.map((c) => ({
          key: c.ticketKey,
          title: c.title,
          status: c.statusName ?? c.status,
          statusCategory: c.statusCategory ?? null,
        })),
        assignees: full.assignees ?? [],
        // ORB-1034 — RACI roster (R/A/C/I); empty array when the project
        // has RACI disabled (everyone is implicitly Responsible).
        raci: (full.raci ?? []).map((r) => ({ userId: r.userId, fullName: r.fullName, role: r.role })),
        labels: (full.labels ?? []).map((l) => l.name),
        comments: comments.map((c) => ({
          author: c.userName ?? null,
          body: c.content,
          createdAt: c.createdAt,
          editedAt: c.editedAt ?? null,
          isInternal: c.isInternal,
        })),
        commentsHasMore: hasMoreComments,
        checklists: checklists.map((cl) => ({
          title: cl.title,
          triggersDone: cl.triggersDone,
          progress: cl.progress,
          items: cl.items.map((i) => ({
            content: i.content,
            done: i.effectiveCompleted,
            // When the item links to another ticket, `effectiveCompleted`
            // mirrors that ticket's status-category instead of this item's
            // own checkbox. Surface the link so the model can explain
            // why the item is/isn't done.
            linkedTicket: i.linkedTicketKey ? {
              key: i.linkedTicketKey,
              title: i.linkedTicketTitle,
              statusCategory: i.linkedTicketStatusCategory,
            } : null,
          })),
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
    if (err instanceof OrbotoApiError && err.status === 404) return fallback;
    throw err;
  };
}

function formatTicket(
  ticket: TicketRow,
  comments: CommentRow[],
  hasMoreComments: boolean,
  checklists: ChecklistRow[],
  gitActivity: GitActivityRow[],
  parent: TicketSummaryRow | null,
  children: TicketSummaryRow[],
): string {
  const header = [
    `[${ticket.ticketKey}] ${ticket.title}`,
    `Status: ${ticket.statusName ?? ticket.status}  Priority: ${ticket.priority}  Type: ${ticket.type}`,
    // ORB-1023 — show the milestone name (not the UUID) when set.
    ticket.milestoneId ? `Milestone: ${ticket.milestoneName ?? '(unnamed)'}` : null,
    ticket.dueDate ? `Due: ${ticket.dueDate}` : null,
    parent ? `Parent: [${parent.ticketKey}] ${parent.title} (${parent.statusName ?? parent.status})` : null,
    children.length > 0
      ? `Sub-tickets: ${children.length} (${children.filter((c) => c.statusCategory !== 'done' && c.statusCategory !== 'wont_fix').length} open)`
      : null,
    ticket.assignees && ticket.assignees.length > 0
      ? `Assignees: ${ticket.assignees.map((a) => a.fullName || a.email).join(', ')}`
      : 'Assignees: (unassigned)',
    // ORB-1034 — RACI summary, shown only when the project uses RACI and
    // someone holds a non-Responsible role (Accountable / Consulted / Informed).
    ticket.raci && ticket.raci.some((r) => r.role !== 'R')
      ? `RACI: ${(['A', 'R', 'C', 'I'] as const)
          .map((role) => {
            const people = ticket.raci!.filter((r) => r.role === role);
            return people.length ? `${role}: ${people.map((p) => p.fullName || p.email).join(', ')}` : null;
          })
          .filter(Boolean)
          .join(' · ')}`
      : null,
    ticket.labels && ticket.labels.length > 0
      ? `Labels: ${ticket.labels.map((l) => l.name).join(', ')}`
      : null,
  ].filter((s): s is string => s !== null);

  if (children.length > 0) {
    header.push('', 'Children:');
    for (const c of children) {
      header.push(`  - [${c.ticketKey}] ${c.title} (${c.statusName ?? c.status})`);
    }
  }

  const description = ticket.description
    ? ['', '## Description', ticket.description]
    : [];

  const checklistLines: string[] = [];
  if (checklists.length > 0) {
    checklistLines.push('', '## Checklists');
    for (const cl of checklists) {
      const progressLabel = `${cl.progress.done}/${cl.progress.total}`;
      checklistLines.push(
        `### ${cl.title} (${progressLabel})${cl.triggersDone ? ' · triggers done' : ''}`,
      );
      for (const i of cl.items) {
        // Linked-ticket suffix on items that track another ticket —
        // lets the model say "item X is done because [ACME-42] shipped".
        const link = i.linkedTicketKey
          ? ` ↪ [${i.linkedTicketKey}] ${i.linkedTicketTitle ?? ''} (${i.linkedTicketStatusCategory ?? 'unknown'})`
          : '';
        checklistLines.push(`- [${i.effectiveCompleted ? 'x' : ' '}] ${i.content}${link}`);
      }
    }
  }

  const commentLines: string[] = [];
  if (comments.length > 0) {
    const headerLine = hasMoreComments
      ? `## Comments (${comments.length} shown, more in the UI)`
      : `## Comments (${comments.length})`;
    commentLines.push('', headerLine);
    for (const c of comments) {
      commentLines.push(
        `**${c.userName ?? '(unknown author)'}** — ${c.createdAt}${c.isInternal ? ' [internal]' : ''}`,
        c.content,
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

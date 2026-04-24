/**
 * ORB-244 Phase B — `orbit_list_tickets`.
 *
 * Lists tickets in a project with optional filters. The API endpoint
 * (`GET /projects/:id/tickets`) supports cursor pagination; this
 * tool returns the first page (50 by default) because an MCP tool
 * call wants to fit inside a single model response — a power user
 * who wants more paginates via more-specific filters instead.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbitClient } from '../orbit-client.js';
import { resolveProjectByKey, ticketLine, type TicketRow } from './shared.js';

interface TicketPage {
  items: TicketRow[];
  nextCursor: string | null;
}

export const listTicketsToolConfig = {
  title: 'List tickets',
  description:
    'List tickets in a project, optionally filtered by status category, milestone name, or assignee email. Returns up to 50 tickets per call.',
  inputSchema: z.object({
    projectKey: z.string().min(1).describe('Project key (e.g. "ACME").'),
    statusCategory: z
      .enum(['todo', 'in_progress', 'in_review', 'done', 'wont_fix'])
      .optional()
      .describe('Filter to one workflow category. Omit for all.'),
    milestone: z
      .string()
      .optional()
      .describe('Milestone name (case-sensitive). Omit for all milestones including backlog.'),
    assigneeEmail: z
      .string()
      .optional()
      .describe('Email of a project member. Omit for all assignees including unassigned.'),
    limit: z.number().int().min(1).max(50).default(25).describe('Max rows to return.'),
  }).shape,
  annotations: { readOnlyHint: true },
};

export function makeListTicketsHandler(client: OrbitClient) {
  return async (input: {
    projectKey: string;
    statusCategory?: 'todo' | 'in_progress' | 'in_review' | 'done' | 'wont_fix';
    milestone?: string;
    assigneeEmail?: string;
    limit?: number;
  }): Promise<CallToolResult> => {
    const project = await resolveProjectByKey(client, input.projectKey);

    const qs = new URLSearchParams();
    qs.set('limit', String(input.limit ?? 25));
    if (input.statusCategory) qs.set('statusCategory', input.statusCategory);
    // Milestone + assignee need a UUID on the API; resolve them here
    // from the project payload instead of forcing the caller to paste
    // a UUID.
    if (input.milestone) {
      const milestones = await client.get<Array<{ id: string; name: string }>>(`/projects/${project.id}/milestones`);
      const m = milestones.find((x) => x.name === input.milestone);
      if (!m) throw new Error(`Milestone "${input.milestone}" not found in project ${project.key}.`);
      qs.set('milestoneId', m.id);
    }
    if (input.assigneeEmail) {
      // Members endpoint returns `{userId, user: {email, ...}, role: {...}}`;
      // we need to peek inside `user` to match by email.
      const members = await client.get<Array<{ userId: string; user: { email: string } }>>(
        `/projects/${project.id}/members`,
      );
      const member = members.find(
        (x) => x.user.email.toLowerCase() === input.assigneeEmail!.toLowerCase(),
      );
      if (!member) throw new Error(`No project member with email "${input.assigneeEmail}".`);
      qs.set('assigneeId', member.userId);
    }

    const page = await client.get<TicketPage>(`/projects/${project.id}/tickets?${qs}`);

    const text = page.items.length === 0
      ? `No tickets in project ${project.key} matching the filters.`
      : page.items.map((t) => `- ${ticketLine(t)}`).join('\n');

    const moreHint = page.nextCursor
      ? `\n\n(${page.items.length} shown; more exist — narrow the filters to see them.)`
      : '';

    return {
      content: [{ type: 'text', text: text + moreHint }],
      structuredContent: {
        project: { key: project.key },
        count: page.items.length,
        hasMore: !!page.nextCursor,
        tickets: page.items.map((t) => ({
          key: t.ticketKey,
          title: t.title,
          status: t.statusName ?? t.status,
          statusCategory: t.statusCategory ?? null,
          priority: t.priority,
          type: t.type,
          dueDate: t.dueDate,
          assignees: t.assignees?.map((a) => a.email) ?? [],
          labels: t.labels?.map((l) => l.name) ?? [],
          estimatedTimeMinutes: t.estimatedTimeMinutes,
          loggedMinutes: t.loggedMinutes ?? 0,
        })),
      },
    };
  };
}

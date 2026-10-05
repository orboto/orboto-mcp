import { TicketSpecStateSchema, type TicketSpecState } from './spec-schemas.js';
/**
 * ORB-244 Phase B - `orboto_list_tickets`.
 *
 * Lists tickets in a project with optional filters. The API endpoint
 * (`GET /projects/:id/tickets`) supports cursor pagination; this
 * tool returns the first page (50 by default) because an MCP tool
 * call wants to fit inside a single model response - a power user
 * who wants more paginates via more-specific filters instead.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';
import { resolveProjectByKey, resolveTicketByKey, ticketLine, agentTicketListRow, type TicketRow } from './shared.js';
import { resolveMilestoneByNameOrId } from './milestones.js';

interface TicketPage {
  items: TicketRow[];
  nextCursor: string | null;
}

export const listTicketsToolConfig = {
  title: 'List tickets',
  description:
    'List tickets in a project, filtered by status category, milestone or assignee email. unscheduled=true = the backlog (no milestone yet). Up to 50 per call.',
  inputSchema: z.object({
    projectKey: z.string().min(1).describe('Project key (e.g. "ACME").'),
    specState: TicketSpecStateSchema.optional(),
    statusCategory: z
      .enum(['todo', 'in_progress', 'in_review', 'done', 'wont_fix'])
      .optional()
      .describe('One workflow category. Omit for all.'),
    open: z
      .boolean()
      .optional()
      .describe('true = only todo, in_progress, in_review. Not with statusCategory.'),
    milestone: z
      .string()
      .optional()
      .describe('Key (ORB-M3), name or UUID.'),
    unscheduled: z
      .boolean()
      .optional()
      .describe('true = only tickets with no milestone. Not with `milestone`.'),
    assigneeEmail: z
      .string()
      .optional()
      .describe('Project-member email.'),
    parentTicketKey: z
      .string()
      .optional()
      .describe('Only children of this ticket - walks an epic.'),
    limit: z.number().int().min(1).max(50).default(25).describe('Max rows to return.'),
    verbose: z.boolean().default(false).describe('true = full rows.'),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeListTicketsHandler(client: OrbotoClient) {
  return async (input: {
    projectKey: string;
    specState?: TicketSpecState;
    statusCategory?: 'todo' | 'in_progress' | 'in_review' | 'done' | 'wont_fix';
    milestone?: string;
    unscheduled?: boolean;
    open?: boolean;
    assigneeEmail?: string;
    parentTicketKey?: string;
    limit?: number;
    verbose?: boolean;
  }): Promise<CallToolResult> => {
    const project = await resolveProjectByKey(client, input.projectKey);

    const qs = new URLSearchParams();
    qs.set('limit', String(input.limit ?? 25));
    if (input.specState) qs.set('specState', input.specState);
    if (input.statusCategory) qs.set('statusCategory', input.statusCategory);
    if (input.open && input.statusCategory) {
      throw new Error('Pass either `open` or `statusCategory`, not both.');
    }
    if (input.open) qs.set('open', 'true');
    if (input.unscheduled && input.milestone) {
      throw new Error('Pass either `milestone` or `unscheduled: true`, not both.');
    }
    if (input.unscheduled) qs.set('unscheduled', 'true');
    if (input.milestone) {
      const m = await resolveMilestoneByNameOrId(client, project.id, input.milestone);
      qs.set('milestoneId', m.id);
    }
    if (input.assigneeEmail) {
      const members = await client.get<Array<{ userId: string; user: { email: string } }>>(
        `/projects/${project.id}/members`,
      );
      const member = members.find(
        (x) => x.user.email.toLowerCase() === input.assigneeEmail!.toLowerCase(),
      );
      if (!member) throw new Error(`No project member with email "${input.assigneeEmail}".`);
      qs.set('assigneeId', member.userId);
    }
    if (input.parentTicketKey) {
      const parent = await resolveTicketByKey(client, input.parentTicketKey);
      qs.set('parentTicketId', parent.id);
    }

    const page = await client.get<TicketPage>(`/projects/${project.id}/tickets?${qs}`);

    const text = page.items.length === 0
      ? `No tickets in project ${project.key} matching the filters.`
      : page.items.map((t) => `- ${ticketLine(t)}`).join('\n');

    const moreHint = page.nextCursor
      ? `\n\n(${page.items.length} shown; more exist - narrow the filters to see them.)`
      : '';

    return {
      content: [{ type: 'text', text: text + moreHint }],
      structuredContent: {
        project: { key: project.key },
        count: page.items.length,
        hasMore: !!page.nextCursor,
        tickets: page.items.map((t) => agentTicketListRow(t, input.verbose ?? false)),
      },
    };
  };
}

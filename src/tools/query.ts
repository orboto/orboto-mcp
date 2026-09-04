/**
 * ORB-273 Phase F - `orboto_query`.
 *
 * Lets the model reach for the OQL DSL when the per-entity list
 * tools (`orboto_list_tickets`, `orboto_my_tickets`) get too narrow:
 * combined `assignee + dueDate + label + statusCategory` filters
 * with explicit ORDER BY are awkward to express through tool
 * arguments but trivial in OQL. Falls back to JQL syntax via
 * `syntax: 'jql'` for migrants who copy-pasted a Jira query.
 *
 * The endpoint is `POST /query` (ORB-531) which honours PBAC,
 * cursor-paginates, and rate-limits at 60/min. We expose the
 * underlying envelope unchanged so a future "give me the next page"
 * tool can plumb the cursor through.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';
import { ticketLine, type TicketRow, agentTicketListRow } from './shared.js';

interface QueryResponse {
  items: TicketRow[];
  nextCursor: string | null;
}

export const queryToolConfig = {
  title: 'Run an OQL / JQL query',
  description:
    'Run a typed OQL (or Jira-shaped JQL) query against the workspace and return matching tickets. '
    + 'OQL grammar: `field operator value [AND|OR ...] [ORDER BY ...] [LIMIT n]`. '
    + 'Supported fields: key, status, statusName, statusCategory, priority, type, assignee, reporter, reporterType, assigneeType, labels, milestone, version, project, isPrivate, dueDate, startDate, createdAt, updatedAt, closedAt, estimatedTimeMinutes, loggedMinutes, parentKey. '
    + 'reporterType / assigneeType are guest|internal - use `reporterType = guest OR assigneeType = guest` to pull up everything reported by or assigned to guests without listing each guest email. '
    + 'Operators: = != < <= > >= ~ !~ IN IS [NOT] NULL IS [NOT] EMPTY. '
    + 'Functions: currentUser(), now(), startOfWeek(), endOfWeek(), startOfMonth(), endOfMonth(), daysAgo(n). '
    + 'Examples: '
    + '`project = ORB AND assignee = currentUser() AND statusCategory != done`; '
    + '`priority IN (blocker, high) AND dueDate <= now() ORDER BY dueDate ASC LIMIT 25`; '
    + '`labels = "bug" AND createdAt >= daysAgo(7)`. '
    + 'Reach for this tool when per-entity tools (orboto_list_tickets / orboto_my_tickets) cannot express the combined filter.',
  inputSchema: z.object({
    oql: z.string().min(1).max(8000).describe('The query string.'),
    syntax: z.enum(['oql', 'jql']).default('oql').describe('"jql" accepts Jira-flavoured syntax.'),
    cursor: z.string().optional().describe('Cursor from a previous response.'),
    limit: z.number().int().min(1).max(100).default(25).describe('Max rows. Default 25.'),
    verbose: z.boolean().default(false).describe('true = full rows; default is the decision fields only.'),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeQueryHandler(client: OrbotoClient) {
  return async (input: {
    oql: string;
    syntax?: 'oql' | 'jql';
    cursor?: string;
    limit?: number;
    verbose?: boolean;
  }): Promise<CallToolResult> => {
    const body = {
      oql: input.oql,
      syntax: input.syntax ?? 'oql',
      cursor: input.cursor,
      limit: input.limit ?? 25,
    };
    const page = await client.post<QueryResponse>('/query', body);

    const text = page.items.length === 0
      ? 'No tickets matched.'
      : page.items.map((t) => `- ${ticketLine(t)}`).join('\n');

    const moreHint = page.nextCursor
      ? `\n\n(${page.items.length} shown; pass cursor="${page.nextCursor}" to fetch the next page.)`
      : '';

    return {
      content: [{ type: 'text', text: text + moreHint }],
      structuredContent: {
        count: page.items.length,
        nextCursor: page.nextCursor,
        // ORB-1699 - shared lean row; verbose restores uuid/labels/minutes.
        tickets: page.items.map((t) => agentTicketListRow(t, input.verbose ?? false)),
      },
    };
  };
}

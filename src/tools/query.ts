/**
 * ORB-273 Phase F - `orboto_query`.
 *
 * @see ORB-531, ORB-2581
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OrbotoApiError, type OrbotoClient } from '../orboto-client.js';
import { ticketLine, type TicketRow, agentTicketListRow } from './shared.js';

interface QueryResponse {
  items: TicketRow[];
  nextCursor: string | null;
}

export const queryToolConfig = {
  title: 'Run an OQL / JQL query',
  description:
    'Run a typed OQL (or Jira-shaped JQL) query and return matching tickets. '
    + 'OQL grammar: `[FIND tickets WHERE] field operator value [AND|OR ...] [ORDER BY ...] [LIMIT n]` (the frame is an optional alias). '
    + 'Supported fields: key, status, statusName, statusCategory, priority, type, assignee, reporter, reporterType, assigneeType, labels, milestone, version, project, isPrivate, dueDate, startDate, createdAt, updatedAt, closedAt, estimatedTimeMinutes, loggedMinutes, parentKey. '
    + 'reporterType / assigneeType are guest|internal (`reporterType = guest OR assigneeType = guest` finds all guest tickets). '
    + 'Operators: = != < <= > >= ~ !~ IN IS [NOT] NULL IS [NOT] EMPTY. '
    + 'Functions: currentUser(), now(), startOfWeek(), endOfWeek(), startOfMonth(), endOfMonth(), daysAgo(n). '
    + 'Examples: '
    + '`project = ORB AND assignee = currentUser() AND statusCategory != done`; '
    + '`priority IN (blocker, high) AND dueDate <= now() ORDER BY dueDate ASC LIMIT 25`; '
    + '`labels = "bug" AND createdAt >= daysAgo(7)`. '
    + 'Use it when orboto_list_tickets / orboto_my_tickets cannot express the filter. '
    + 'A 429 is retried at most twice, then returned with structuredContent rateLimited, retryAfterSeconds, limitPerMinute.',
  inputSchema: z.object({
    oql: z.string().min(1).max(8000).describe('The query string.'),
    syntax: z.enum(['oql', 'jql']).default('oql').describe('"jql" accepts Jira-flavoured syntax.'),
    cursor: z.string().optional().describe('Cursor from a previous response.'),
    limit: z.number().int().min(1).max(100).default(25).describe('Max rows. Default 25.'),
    verbose: z.boolean().default(false).describe('true = full rows; default is the decision fields only.'),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

/** ORB-2581 - `orboto_query` waits out at most two 429s of up to 20 seconds each, then answers with the retry hint. */
export const QUERY_RETRY = { maxRetries: 2, maxWaitSeconds: 20 } as const;

type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function rateLimitDetails(err: OrbotoApiError): { retryAfterSeconds: number; limitPerMinute: number | null } {
  let params: { retryAfterSeconds?: unknown; limitPerMinute?: unknown } = {};
  try { params = (JSON.parse(err.body) as { errorParams?: typeof params }).errorParams ?? {}; } catch { params = {}; }
  const fromBody = typeof params.retryAfterSeconds === 'number' ? params.retryAfterSeconds : null;
  return {
    retryAfterSeconds: Math.max(0, err.retryAfterSeconds ?? fromBody ?? 1),
    limitPerMinute: typeof params.limitPerMinute === 'number' ? params.limitPerMinute : null,
  };
}

function rateLimitedResult(details: { retryAfterSeconds: number; limitPerMinute: number | null }, attempts: number): CallToolResult {
  const limit = details.limitPerMinute !== null ? ` (${details.limitPerMinute} per minute)` : '';
  return {
    isError: true,
    content: [{
      type: 'text',
      text: `Rate limited: this account's OQL query limit${limit} is used up. Retry after ${details.retryAfterSeconds} seconds (tried ${attempts} times).`,
    }],
    structuredContent: { rateLimited: true, retryAfterSeconds: details.retryAfterSeconds, limitPerMinute: details.limitPerMinute, attempts },
  };
}

export function makeQueryHandler(client: OrbotoClient, sleep: Sleep = realSleep) {
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
    let page: QueryResponse | undefined;
    for (let attempt = 1; page === undefined; attempt += 1) {
      try {
        page = await client.post<QueryResponse>('/query', body);
      } catch (err) {
        if (!(err instanceof OrbotoApiError) || err.status !== 429) throw err;
        const details = rateLimitDetails(err);
        if (attempt > QUERY_RETRY.maxRetries || details.retryAfterSeconds > QUERY_RETRY.maxWaitSeconds) return rateLimitedResult(details, attempt);
        await sleep(details.retryAfterSeconds * 1000);
      }
    }

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
        tickets: page.items.map((t) => agentTicketListRow(t, input.verbose ?? false)),
      },
    };
  };
}

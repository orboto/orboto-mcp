/**
 * ORB-244 Phase D — MCP prompts.
 *
 * Prompts are reusable instruction templates an MCP-aware client
 * (Claude Desktop, Cursor) surfaces in its UI as a one-click action.
 * Each handler returns `messages[]` that become the start of the
 * conversation; the user's model then drives the work, typically
 * by calling orboto MCP tools.
 *
 * Five v1 templates — each a thin wrapper that hands the model a
 * focused goal + a tool sequence to execute:
 *   - plan-sprint(projectKey)     — draft a sprint plan from open work
 *   - triage-my-tickets()         — sort caller's open assignments
 *   - summarize-project(projectKey) — quick project briefing
 *   - estimate-ticket(ticketKey)  — rough effort guess via similar work
 *   - find-duplicates(ticketKey)  — search for overlapping tickets
 *
 * No backend AI calls — the prompts steer the model, the model
 * uses tools. Keeps the surface stateless and the AI provider
 * irrelevant (works with any MCP client).
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerOrbotoPrompts(server: McpServer): void {
  // -------------------------------------------------------------------------
  // plan-sprint
  // -------------------------------------------------------------------------
  server.registerPrompt(
    'plan-sprint',
    {
      title: 'Draft a sprint plan',
      description: 'Build a 2-week sprint plan from a project\'s open backlog and the team\'s recent velocity.',
      argsSchema: { projectKey: z.string().min(1).describe('Project key, e.g. "ACME".') },
    },
    ({ projectKey }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: [
            `Plan a 2-week sprint for project ${projectKey}.`,
            '',
            'Steps:',
            `1. Use \`orboto_get_project\` on "${projectKey}" to see milestones, members, and overall status.`,
            `2. Use \`orboto_list_tickets\` with statusCategory="todo" to fetch the open backlog.`,
            `3. Use \`orboto_list_milestones\` and pick the next not-yet-completed milestone as the sprint target.`,
            '4. Sort the backlog by priority (blocker > high > normal > low > trivial), then by ticket age (older first), and propose 8-12 tickets that:',
            '   - Together fit roughly the team\'s capacity (estimate via past closed tickets if visible)',
            '   - Cover all the blockers and high-priority items',
            '   - Have at most 1-2 epics so the sprint stays achievable',
            '5. For each picked ticket, name the recommended assignee from the project members and a 1-line "why this person".',
            '6. Output the plan as a Markdown table: ticket key, title, assignee, rough days. Then a 2-3 sentence summary on what this sprint aims to deliver.',
            '',
            'If a step blocks (e.g. no milestones, empty backlog), say so plainly and stop instead of inventing data.',
          ].join('\n'),
        },
      }],
    }),
  );

  // -------------------------------------------------------------------------
  // triage-my-tickets
  // -------------------------------------------------------------------------
  server.registerPrompt(
    'triage-my-tickets',
    {
      title: 'Triage my open tickets',
      description: 'Sort the caller\'s open assignments and recommend the next 3 to focus on.',
      argsSchema: {},
    },
    () => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: [
            'Triage my open tickets.',
            '',
            'Steps:',
            '1. Use `orboto_my_tickets` (no statusCategory filter — defaults to open work) to fetch what I\'m assigned to.',
            '2. For each ticket, fetch full context with `orboto_get_ticket` to see description, latest comment, blocking sub-tickets, and linked git activity.',
            '3. Rank by:',
            '   - Priority (blocker > high > normal > low)',
            '   - Due date (overdue + soon-due first)',
            '   - Whether something/someone is waiting (open PR comment, assignee comment asking a question)',
            '4. Pick the top 3 and explain — for each — what the next concrete action is (write code? respond to a comment? close as won\'t fix?).',
            '5. Surface anything that should be DELEGATED (assigned to someone else) or DROPPED (closed as won\'t fix), if anything fits.',
            '',
            'Be terse. One paragraph per ticket. The point is to start working, not to read a thesis.',
          ].join('\n'),
        },
      }],
    }),
  );

  // -------------------------------------------------------------------------
  // summarize-project
  // -------------------------------------------------------------------------
  server.registerPrompt(
    'summarize-project',
    {
      title: 'Summarise a project',
      description: 'A 3-sentence briefing on a project — what it is, where it stands, what\'s next.',
      argsSchema: { projectKey: z.string().min(1).describe('Project key, e.g. "ACME".') },
    },
    ({ projectKey }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: [
            `Give me a 3-sentence summary of project ${projectKey}.`,
            '',
            'Steps:',
            `1. Use \`orboto_get_project\` on "${projectKey}" to see metadata, milestones, members.`,
            `2. Use \`orboto_list_tickets\` with statusCategory="in_progress" to see what\'s actively being worked.`,
            `3. Use \`orboto_list_milestones\` to see what\'s nearest the deadline.`,
            '',
            'Then write exactly 3 sentences: (a) what the project is, (b) where it currently stands, (c) what\'s next on the milestone path.',
            'No bullet lists, no headings. Just the three sentences.',
          ].join('\n'),
        },
      }],
    }),
  );

  // -------------------------------------------------------------------------
  // estimate-ticket
  // -------------------------------------------------------------------------
  server.registerPrompt(
    'estimate-ticket',
    {
      title: 'Estimate a ticket\'s effort',
      description: 'Rough effort guess for a ticket based on its description and similar past work.',
      argsSchema: { ticketKey: z.string().min(3).describe('Ticket key, e.g. "ACME-42".') },
    },
    ({ ticketKey }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: [
            `Estimate the effort needed for ${ticketKey}.`,
            '',
            'Steps:',
            `1. Use \`orboto_get_ticket\` on "${ticketKey}" to read the description, type, priority, and any sub-tickets.`,
            `2. Use \`orboto_search\` with the ticket\'s title and description to find 3-5 similar past tickets, ideally already closed.`,
            '3. For each similar ticket found, use `orboto_get_ticket` to look up its loggedMinutes and check if the work seems comparable.',
            '4. Compute a median + range from the comparable past efforts.',
            '5. Output: estimated minutes, a confidence rating (low/medium/high), and one line per comparable ticket with its actual logged time.',
            '',
            'If you can\'t find comparable past work, say so — don\'t guess from thin air.',
          ].join('\n'),
        },
      }],
    }),
  );

  // -------------------------------------------------------------------------
  // find-duplicates
  // -------------------------------------------------------------------------
  server.registerPrompt(
    'find-duplicates',
    {
      title: 'Find duplicate tickets',
      description: 'Look for tickets that overlap with the given one — likely duplicates or competing work.',
      argsSchema: { ticketKey: z.string().min(3).describe('Ticket key, e.g. "ACME-42".') },
    },
    ({ ticketKey }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: [
            `Find tickets that might overlap with ${ticketKey}.`,
            '',
            'Steps:',
            `1. Use \`orboto_get_ticket\` on "${ticketKey}" to read its title and description.`,
            '2. Pull 3-5 keyword phrases from the description.',
            `3. Use \`orboto_search\` with each phrase to find candidate matches (limit each search to 5).`,
            '4. Use `orboto_get_ticket` on the top 3 candidates to verify the actual overlap.',
            '5. Output:',
            '   - Likely duplicates (same intent, same scope) — list these first',
            '   - Related but distinct (overlapping topic, different scope) — list these second',
            '   - "Probably nothing" — only mention if all candidates were unrelated',
            '',
            'Be honest: if the original ticket has too little detail to compare, say so and stop. False positives waste more time than they save.',
          ].join('\n'),
        },
      }],
    }),
  );

  // -------------------------------------------------------------------------
  // ORB-855 — wiki-ingest: guided URL ingest flow.
  // -------------------------------------------------------------------------
  server.registerPrompt(
    'wiki-ingest',
    {
      title: 'Ingest a URL into the wiki',
      description: 'Guided flow: import a URL into an LLM-Wiki space and confirm what the curation produced.',
      argsSchema: { spaceId: z.string().min(1).describe('Target wiki space id.'), url: z.string().min(1).describe('Public URL to import.') },
    },
    ({ spaceId, url }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: [
            `Ingest ${url} into wiki space ${spaceId}.`,
            '',
            'Steps:',
            `1. Call \`orboto_wiki_ingest_url\` with spaceId="${spaceId}" and url="${url}".`,
            '2. If the space runs review-gate, the curation lands as a pending plan — tell the operator to review it in the space (sidebar). If auto-apply, the pages were written directly.',
            '3. Read `orboto://wiki/' + spaceId + '/log` to confirm what changed and summarise the new / updated pages in 2-3 sentences.',
            '',
            'If ingest fails (bad URL, space not wiki-enabled), report the error plainly and stop.',
          ].join('\n'),
        },
      }],
    }),
  );

  // -------------------------------------------------------------------------
  // ORB-855 — wiki-maintain: guided lint + fix flow.
  // -------------------------------------------------------------------------
  server.registerPrompt(
    'wiki-maintain',
    {
      title: 'Maintain a wiki (lint + fix)',
      description: 'Run the lint pass on an LLM-Wiki space and propose fixes for the open issues.',
      argsSchema: { spaceId: z.string().min(1).describe('Wiki space id to maintain.') },
    },
    ({ spaceId }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: [
            `Maintain wiki space ${spaceId}.`,
            '',
            'Steps:',
            `1. Call \`orboto_wiki_lint\` with spaceId="${spaceId}" to get the open issues.`,
            '2. Group them by kind (orphans, missing cross-references, stale, contradictions, undocumented, unprocessed sources).',
            '3. For each issue with a clear fix, propose the concrete change. For a fix the operator approves, use `orboto_wiki_plan_update` to draft it and `orboto_wiki_apply_plan` to commit — never apply destructive rewrites without confirmation.',
            '4. Summarise what you fixed and what still needs a human decision.',
            '',
            'If there are no open issues, say the wiki is clean and stop.',
          ].join('\n'),
        },
      }],
    }),
  );
}

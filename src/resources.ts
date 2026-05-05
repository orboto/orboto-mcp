/**
 * ORB-244 Phase D — MCP resources.
 *
 * Resources let MCP-aware clients (Claude Desktop, Cursor) read
 * Orboto content as static blobs without explicitly invoking a tool.
 * Where tools are RPCs ("do this thing"), resources are URIs ("here
 * is content at this address").
 *
 * Four URI templates exposed:
 *   orbit://ticket/{ticketKey}     — rendered Markdown of the ticket
 *   orbit://doc/{docId}            — doc body (Markdown)
 *   orbit://project/{projectKey}   — project summary
 *   orbit://search/{query}         — search results as Markdown
 *
 * No `list` callback for tickets/docs because the candidate set is
 * unbounded (every ticket, every doc) — the URI templates are
 * sufficient. Clients discover content via tools first, then read a
 * specific resource. The required `list: undefined` pattern keeps
 * the SDK happy.
 *
 * Implementation note: each resource handler delegates to the same
 * REST endpoints the tools use; the only difference is response
 * shape (Markdown text vs. structured tool result). Sharing logic
 * with tools/*.ts would couple the two surfaces too tightly — for
 * now the resources are independent thin renderers.
 */
import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { OrbitApiError, type OrbitClient } from './orbit-client.js';
import { resolveProjectByKey, resolveTicketByKey, type TicketRow } from './tools/shared.js';

interface CommentPage {
  items: Array<{ content: string; userName: string | null; createdAt: string; isInternal: boolean }>;
  nextCursor: string | null;
}
interface ProjectSummary {
  id: string; key: string; name: string; description: string | null; status: string;
}
interface MilestoneRow {
  id: string; name: string; status: string; startDate: string | null; endDate: string | null;
}
interface MemberRow {
  user: { email: string; fullName: string | null };
  role: { name: string };
}
interface DocRow {
  id: string; title: string; content: string;
  visibility: string; updatedAt: string;
}
interface SearchResponse {
  items: Array<{ type: string; ticketKey?: string | null; title: string; excerpt: string; url: string; projectName: string | null }>;
  total: number;
}

export function registerOrbitResources(server: McpServer, client: OrbitClient): void {
  // -------------------------------------------------------------------------
  // orbit://ticket/{ticketKey}
  // -------------------------------------------------------------------------
  server.registerResource(
    'ticket',
    new ResourceTemplate('orbit://ticket/{ticketKey}', { list: undefined }),
    {
      title: 'Orboto ticket',
      description: 'A single ticket with description, assignees, comments, and labels — rendered as Markdown.',
      mimeType: 'text/markdown',
    },
    async (uri, vars) => {
      const ticketKey = String(vars.ticketKey);
      const ticket = await resolveTicketByKey(client, ticketKey);
      const commentsPage = await client.get<CommentPage>(
        `/tickets/${ticket.id}/comments?limit=50`,
      ).catch((err) => {
        if (err instanceof OrbitApiError && err.status === 404) {
          return { items: [], nextCursor: null };
        }
        throw err;
      });
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'text/markdown',
          text: renderTicketMarkdown(ticket, commentsPage.items),
        }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // orbit://doc/{docId}
  // -------------------------------------------------------------------------
  server.registerResource(
    'doc',
    new ResourceTemplate('orbit://doc/{docId}', { list: undefined }),
    {
      title: 'Orboto doc',
      description: 'A wiki page from a doc space — Markdown body.',
      mimeType: 'text/markdown',
    },
    async (uri, vars) => {
      const docId = String(vars.docId);
      const doc = await client.get<DocRow>(`/docs/${docId}`);
      const lines = [
        `# ${doc.title}`,
        `_Visibility: ${doc.visibility} · Updated: ${doc.updatedAt}_`,
        '',
        doc.content || '_(empty)_',
      ];
      return {
        contents: [{ uri: uri.href, mimeType: 'text/markdown', text: lines.join('\n') }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // orbit://project/{projectKey}
  // -------------------------------------------------------------------------
  server.registerResource(
    'project',
    new ResourceTemplate('orbit://project/{projectKey}', { list: undefined }),
    {
      title: 'Orboto project',
      description: 'Project metadata, milestones, members.',
      mimeType: 'text/markdown',
    },
    async (uri, vars) => {
      const projectKey = String(vars.projectKey);
      const project = await resolveProjectByKey(client, projectKey);
      const [milestones, members] = await Promise.all([
        client.get<MilestoneRow[]>(`/projects/${project.id}/milestones`),
        client.get<MemberRow[]>(`/projects/${project.id}/members`),
      ]);
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'text/markdown',
          text: renderProjectMarkdown(project, milestones, members),
        }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // orbit://search/{query}
  //
  // Note: clients URL-encode `query` automatically. Special chars in
  // a natural-language query are fine; the URI template handles
  // unescaping.
  // -------------------------------------------------------------------------
  server.registerResource(
    'search',
    new ResourceTemplate('orbit://search/{query}', { list: undefined }),
    {
      title: 'Orboto search',
      description: 'Full-text search across tickets, comments, docs — visibility-filtered.',
      mimeType: 'text/markdown',
    },
    async (uri, vars) => {
      const query = String(vars.query);
      const qs = new URLSearchParams({ q: query, limit: '15' });
      const res = await client.get<SearchResponse>(`/search?${qs}`);
      const lines = res.items.length === 0
        ? [`# Search: ${query}`, '', '_No hits._']
        : [
          `# Search: ${query}`,
          `_${res.total} total hit(s) — top ${res.items.length} shown._`,
          '',
          ...res.items.map((h) => {
            const tag = h.type.toUpperCase();
            const ident = h.ticketKey ?? h.url;
            const project = h.projectName ? ` (${h.projectName})` : '';
            return `- **${tag} ${ident}**${project}: ${h.title}\n  ${h.excerpt}`;
          }),
        ];
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'text/markdown',
          text: lines.join('\n'),
        }],
      };
    },
  );
}

function renderTicketMarkdown(
  ticket: TicketRow,
  comments: Array<{ content: string; userName: string | null; createdAt: string; isInternal: boolean }>,
): string {
  const lines: string[] = [];
  lines.push(`# [${ticket.ticketKey}] ${ticket.title}`);
  lines.push(`_Status: ${ticket.statusName ?? ticket.status} · Priority: ${ticket.priority} · Type: ${ticket.type}_`);
  if (ticket.dueDate) lines.push(`_Due: ${ticket.dueDate}_`);
  if (ticket.assignees && ticket.assignees.length > 0) {
    lines.push(`_Assignees: ${ticket.assignees.map((a) => a.fullName || a.email).join(', ')}_`);
  }
  if (ticket.labels && ticket.labels.length > 0) {
    lines.push(`_Labels: ${ticket.labels.map((l) => l.name).join(', ')}_`);
  }
  if (ticket.description) {
    lines.push('', '## Description', ticket.description);
  }
  if (comments.length > 0) {
    lines.push('', `## Comments (${comments.length})`);
    for (const c of comments) {
      lines.push('', `**${c.userName ?? '(unknown)'}** — ${c.createdAt}${c.isInternal ? ' [internal]' : ''}`);
      lines.push(c.content);
    }
  }
  return lines.join('\n');
}

function renderProjectMarkdown(
  project: ProjectSummary,
  milestones: MilestoneRow[],
  members: MemberRow[],
): string {
  const lines = [
    `# ${project.key} — ${project.name}`,
    `_Status: ${project.status}_`,
  ];
  if (project.description) lines.push('', project.description);
  if (milestones.length > 0) {
    lines.push('', '## Milestones');
    for (const m of milestones) {
      const range = [m.startDate, m.endDate].filter(Boolean).join(' → ') || 'no dates';
      lines.push(`- **${m.name}** [${m.status}] (${range})`);
    }
  }
  if (members.length > 0) {
    lines.push('', '## Members');
    for (const m of members) {
      const name = m.user.fullName || m.user.email;
      lines.push(`- ${name} <${m.user.email}> — ${m.role.name}`);
    }
  }
  return lines.join('\n');
}

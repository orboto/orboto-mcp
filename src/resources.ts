/**
 * ORB-244 Phase D — MCP resources.
 *
 * Resources let MCP-aware clients (Claude Desktop, Cursor) read
 * orboto content as static blobs without explicitly invoking a tool.
 * Where tools are RPCs ("do this thing"), resources are URIs ("here
 * is content at this address").
 *
 * Four URI templates exposed:
 *   orboto://ticket/{ticketKey}     — rendered Markdown of the ticket
 *   orboto://doc/{docId}            — doc body (Markdown)
 *   orboto://project/{projectKey}   — project summary
 *   orboto://search/{query}         — search results as Markdown
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
import { OrbotoApiError, type OrbotoClient } from './orboto-client.js';
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
interface NotificationRow {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}
interface NotificationsPage {
  items: NotificationRow[];
  nextCursor: string | null;
  unreadCount: number;
}

export function registerOrbotoResources(server: McpServer, client: OrbotoClient): void {
  // -------------------------------------------------------------------------
  // orboto://rules
  //
  // ORB-1177 — the COMPLETE assembled binding rules, cap-independent. The
  // MCP `instructions` block is budgeted + may be truncated by the client
  // (ORB-1168); this resource is never truncated, so a client can fetch
  // the full rule set on demand. Same source orboto_session_start reads.
  // -------------------------------------------------------------------------
  server.registerResource(
    'rules',
    new ResourceTemplate('orboto://rules', { list: undefined }),
    {
      title: 'Workspace agent rules (complete)',
      description: 'The complete, assembled binding rules you must follow as an agent in this workspace - cap-independent (the MCP instructions block may be truncated; this resource is not). orboto_session_start returns the same rules plus your in-progress work.',
      mimeType: 'text/markdown',
    },
    async (uri) => {
      const res = await client.get<{ instructions: string }>('/agent-instructions').catch(() => ({ instructions: '' }));
      const rules = res?.instructions?.trim() || '(no workspace rules configured)';
      return {
        contents: [{ uri: uri.href, mimeType: 'text/markdown', text: `# orboto workspace agent rules\n\n${rules}` }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // orboto://ticket/{ticketKey}
  // -------------------------------------------------------------------------
  server.registerResource(
    'ticket',
    new ResourceTemplate('orboto://ticket/{ticketKey}', { list: undefined }),
    {
      title: 'orboto ticket',
      description: 'A single ticket with description, assignees, comments, and labels — rendered as Markdown.',
      mimeType: 'text/markdown',
    },
    async (uri, vars) => {
      const ticketKey = String(vars.ticketKey);
      const ticket = await resolveTicketByKey(client, ticketKey);
      const commentsPage = await client.get<CommentPage>(
        `/tickets/${ticket.id}/comments?limit=50`,
      ).catch((err) => {
        if (err instanceof OrbotoApiError && err.status === 404) {
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
  // orboto://doc/{docId}
  // -------------------------------------------------------------------------
  server.registerResource(
    'doc',
    new ResourceTemplate('orboto://doc/{docId}', { list: undefined }),
    {
      title: 'orboto doc',
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
  // orboto://project/{projectKey}
  // -------------------------------------------------------------------------
  server.registerResource(
    'project',
    new ResourceTemplate('orboto://project/{projectKey}', { list: undefined }),
    {
      title: 'orboto project',
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
  // orboto://search/{query}
  //
  // Note: clients URL-encode `query` automatically. Special chars in
  // a natural-language query are fine; the URI template handles
  // unescaping.
  // -------------------------------------------------------------------------
  server.registerResource(
    'search',
    new ResourceTemplate('orboto://search/{query}', { list: undefined }),
    {
      title: 'orboto search',
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

  // -------------------------------------------------------------------------
  // orboto://user/me/notifications
  //
  // ORB-706 — read the calling user's recent notifications.
  // Subscribable: every `notification:new` event for this user
  // fires a `resources/updated` push. Used by agents that want to
  // react to mentions / agent_message / status-change pings in
  // real time.
  // -------------------------------------------------------------------------
  server.registerResource(
    'user-notifications',
    new ResourceTemplate('orboto://user/me/notifications', { list: undefined }),
    {
      title: 'My notifications',
      description: 'Calling user\'s recent notifications. Subscribable — every new notification fires resources/updated. Use this to react to mentions, agent_message (ORB-705), and status-change pings in real time.',
      mimeType: 'text/markdown',
    },
    async (uri) => {
      const page = await client.get<NotificationsPage>('/notifications?limit=20');
      const lines: string[] = [];
      lines.push(`# My notifications`);
      lines.push(`_${page.unreadCount} unread of ${page.items.length} shown._`);
      lines.push('');
      if (page.items.length === 0) {
        lines.push('_No notifications._');
      } else {
        for (const n of page.items) {
          const unread = n.readAt ? '' : ' **unread**';
          const subject = typeof n.payload.subject === 'string'
            ? n.payload.subject
            : typeof n.payload.message === 'string' ? n.payload.message : n.type;
          lines.push(`- [${n.type}]${unread} — ${subject} _(${n.createdAt})_`);
        }
      }
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'text/markdown',
          text: lines.join('\n'),
        }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // ORB-855 — LLM-Wiki resources. The index + log are the space's singleton
  // kind='index'/'log' docs; a page is any doc by id (namespaced under the
  // space). A `page/` discriminator keeps the page template from colliding
  // with the static index/log segments.
  // -------------------------------------------------------------------------
  const layerDoc = async (spaceId: string, kind: 'index' | 'log'): Promise<DocRow | null> => {
    const list = await client.get<Array<DocRow & { kind?: string }>>(`/spaces/${spaceId}/docs`);
    return list.find((d) => d.kind === kind) ?? null;
  };

  server.registerResource(
    'wiki-index',
    new ResourceTemplate('orboto://wiki/{spaceId}/index', { list: undefined }),
    { title: 'LLM-Wiki index', description: 'The auto-maintained navigation index of an LLM-Wiki space.', mimeType: 'text/markdown' },
    async (uri, vars) => {
      const doc = await layerDoc(String(vars.spaceId), 'index');
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: doc?.content || '_(no index)_' }] };
    },
  );
  server.registerResource(
    'wiki-log',
    new ResourceTemplate('orboto://wiki/{spaceId}/log', { list: undefined }),
    { title: 'LLM-Wiki activity log', description: 'The append-only activity log of an LLM-Wiki space.', mimeType: 'text/markdown' },
    async (uri, vars) => {
      const doc = await layerDoc(String(vars.spaceId), 'log');
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: doc?.content || '_(no log)_' }] };
    },
  );
  server.registerResource(
    'wiki-page',
    new ResourceTemplate('orboto://wiki/{spaceId}/page/{docId}', { list: undefined }),
    { title: 'LLM-Wiki page', description: 'A single wiki page by id within an LLM-Wiki space.', mimeType: 'text/markdown' },
    async (uri, vars) => {
      const doc = await client.get<DocRow>(`/docs/${String(vars.docId)}`);
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: `# ${doc.title}\n\n${doc.content || '_(empty)_'}` }] };
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

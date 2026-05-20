/**
 * ORB-632 / ORB-945 — Cross-Project Linking MCP tools.
 *
 *   - orboto_list_cross_project_links — GET /tickets/:id/cross-project-links
 *   - orboto_add_cross_project_link   — POST /tickets/:id/cross-project-links
 *   - orboto_update_cross_project_link — PATCH /tickets/:id/cross-project-links/:linkId
 *   - orboto_remove_cross_project_link — DELETE /tickets/:id/cross-project-links/:linkId
 *
 * Business-tier feature (`.ee.*`). The API records the EE soft-warn
 * event on mutating calls; the tool surface here is identical to
 * every other MCP tool and reads the existing license-state via the
 * Authorization-header path.
 *
 * Accepts BOTH a UUID and a ticket-key (`OCP-42`, case-insensitive) on
 * every input — the API resolves either form.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';

const RELATION_TYPES = ['counterpart', 'depends_on', 'blocks', 'related'] as const;
type RelationType = (typeof RELATION_TYPES)[number];

interface LinkRow {
  id: string;
  sourceTicketId: string;
  targetTicketId: string;
  relationType: RelationType;
  statusSyncEnabled: boolean;
  createdBy: string | null;
  createdAt: string;
}

interface LinkView {
  direction: 'outgoing' | 'incoming';
  link: LinkRow;
  otherEnd: {
    ticketId: string;
    ticketKey: string | null;
    title: string;
    statusName: string | null;
    statusColor: string | null;
    statusCategory: string | null;
    projectId: string;
    projectKey: string;
    projectName: string;
  };
}

// ---------------------------------------------------------------------------
// orboto_list_cross_project_links
// ---------------------------------------------------------------------------

export const listCrossProjectLinksToolConfig = {
  title: 'List cross-project links on a ticket',
  description:
    'Return every cross-project link touching the ticket — both outgoing (this → other) and incoming (other → this). Each row carries the other end\'s project key, ticket key, title, and current status, so the model can see the linked work\'s state without a follow-up tool call. ACL-filtered: rows whose other-end project the caller cannot read are dropped silently.',
  inputSchema: z.object({
    ticketKey: z.string().min(3).describe('Ticket key (e.g. "ORB-42") or UUID.'),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeListCrossProjectLinksHandler(client: OrbotoClient) {
  return async ({ ticketKey }: { ticketKey: string }): Promise<CallToolResult> => {
    const rows = await client.get<LinkView[]>(`/tickets/${encodeURIComponent(ticketKey)}/cross-project-links`);
    if (rows.length === 0) {
      return {
        content: [{ type: 'text', text: `No cross-project links on ${ticketKey}.` }],
        structuredContent: { links: [] },
      };
    }
    const lines = rows.map((r) => {
      const arrow = r.direction === 'outgoing' ? '→' : '←';
      const key = r.otherEnd.ticketKey ?? r.otherEnd.ticketId.slice(0, 8);
      const status = r.otherEnd.statusName ? ` [${r.otherEnd.statusName}]` : '';
      const sync = r.link.statusSyncEnabled ? ' (sync)' : '';
      return `  ${arrow} ${r.link.relationType}${sync}: [${key}] ${r.otherEnd.title}${status}`;
    });
    return {
      content: [{ type: 'text', text: `Cross-project links on ${ticketKey}:\n${lines.join('\n')}` }],
      structuredContent: { links: rows },
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_add_cross_project_link
// ---------------------------------------------------------------------------

export const addCrossProjectLinkToolConfig = {
  title: 'Add a cross-project link between two tickets',
  description:
    'Create a formal relation between two tickets in different projects. Caller must be a member of BOTH the source and target projects. Relation types: counterpart (parallel work in two repos — bidirectional), depends_on (this ticket waits for the other), blocks (the other waits for this), related (loose association). Pass statusSyncEnabled=true to opt into auto-close: when a counterpart-linked ticket moves to done, the other auto-closes too. Off by default.',
  inputSchema: z.object({
    sourceTicketKey: z.string().min(3),
    targetTicketKey: z.string().min(3),
    relationType: z.enum(RELATION_TYPES),
    statusSyncEnabled: z.boolean().optional().default(false),
  }).shape,
};

export function makeAddCrossProjectLinkHandler(client: OrbotoClient) {
  return async ({ sourceTicketKey, targetTicketKey, relationType, statusSyncEnabled }: {
    sourceTicketKey: string; targetTicketKey: string; relationType: RelationType; statusSyncEnabled?: boolean;
  }): Promise<CallToolResult> => {
    const row = await client.post<LinkRow>(
      `/tickets/${encodeURIComponent(sourceTicketKey)}/cross-project-links`,
      { targetTicketKey, relationType, statusSyncEnabled: statusSyncEnabled ?? false },
    );
    return {
      content: [{
        type: 'text',
        text: `Linked ${sourceTicketKey} → ${targetTicketKey} (${relationType}${row.statusSyncEnabled ? ', sync enabled' : ''}).`,
      }],
      structuredContent: { id: row.id, sourceTicketId: row.sourceTicketId, targetTicketId: row.targetTicketId, relationType: row.relationType, statusSyncEnabled: row.statusSyncEnabled },
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_update_cross_project_link
// ---------------------------------------------------------------------------

export const updateCrossProjectLinkToolConfig = {
  title: 'Toggle status-sync on a cross-project link',
  description:
    'Flip the statusSyncEnabled flag on an existing cross-project link. When enabled on a counterpart-typed link, the other end auto-closes when this one moves to done (and vice versa). Other relation types ignore the flag at runtime, so toggling it on them is a no-op as far as status-sync goes.',
  inputSchema: z.object({
    sourceTicketKey: z.string().min(3),
    linkId: z.string().uuid(),
    statusSyncEnabled: z.boolean(),
  }).shape,
};

export function makeUpdateCrossProjectLinkHandler(client: OrbotoClient) {
  return async ({ sourceTicketKey, linkId, statusSyncEnabled }: {
    sourceTicketKey: string; linkId: string; statusSyncEnabled: boolean;
  }): Promise<CallToolResult> => {
    const row = await client.patch<LinkRow>(
      `/tickets/${encodeURIComponent(sourceTicketKey)}/cross-project-links/${linkId}`,
      { statusSyncEnabled },
    );
    return {
      content: [{
        type: 'text',
        text: `Link ${linkId} status-sync ${row.statusSyncEnabled ? 'enabled' : 'disabled'}.`,
      }],
      structuredContent: { id: row.id, statusSyncEnabled: row.statusSyncEnabled },
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_remove_cross_project_link
// ---------------------------------------------------------------------------

export const removeCrossProjectLinkToolConfig = {
  title: 'Remove a cross-project link',
  description:
    'DESTRUCTIVE — drops the cross-project link between two tickets. Caller must be a member of both source and target projects (or super-admin). The underlying tickets are unaffected; only the relation row is deleted.',
  inputSchema: z.object({
    sourceTicketKey: z.string().min(3),
    linkId: z.string().uuid(),
  }).shape,
};

export function makeRemoveCrossProjectLinkHandler(client: OrbotoClient) {
  return async ({ sourceTicketKey, linkId }: { sourceTicketKey: string; linkId: string }): Promise<CallToolResult> => {
    await client.delete(`/tickets/${encodeURIComponent(sourceTicketKey)}/cross-project-links/${linkId}`);
    return {
      content: [{ type: 'text', text: `Removed cross-project link ${linkId} from ${sourceTicketKey}.` }],
      structuredContent: { sourceTicketKey, linkId, deleted: true },
    };
  };
}

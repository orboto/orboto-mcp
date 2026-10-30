/**
 * ORB-2719 - `orboto_connector`: what an agent needs from an add-on link (is a
 * ticket mirrored and which fields the source owns, the links, their health, a
 * reconcile). Linking, settings, the delivery log, retry, webhooks and unlink
 * are operator tail endpoints reached through orboto_api_call.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';
import { resolveProjectByKey, resolveTicketByKey } from './shared.js';

const ACTIONS = ['source_link', 'list', 'health', 'sync'] as const;
type Action = (typeof ACTIONS)[number];

export const connectorToolConfig = {
  title: 'Add-on connector',
  description: 'Connector links: source_link (ticketKey, what the source owns), list, health, sync (linkId). Setup: orboto_api_search "connectors".',
  inputSchema: z.object({
    action: z.enum(ACTIONS),
    projectKey: z.string(),
    linkId: z.string().uuid().optional(),
    ticketKey: z.string().optional(),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
};

type Args = { action: Action; projectKey: string; linkId?: string; ticketKey?: string };

interface Link { id: string; projectId: string; provider: string; siteUrl: string; externalProjectKey: string; scopeFilter: string; authKind: string; state: string; enabled: boolean; webhookMode: string; lastWebhookAt: string | null; lastPollAt: string | null; lastError: string | null; consecutiveFailures: number }

function line(l: Link): string {
  return `- ${l.id} ${l.provider} ${l.siteUrl} ${l.externalProjectKey} state=${l.state}${l.enabled ? '' : ' paused'} auth=${l.authKind} webhooks=${l.webhookMode} scope=${l.scopeFilter || '(whole project)'} last webhook=${l.lastWebhookAt ?? 'never'} last poll=${l.lastPollAt ?? 'never'}${l.lastError ? ` error=${l.lastError}` : ''}`;
}

function text(result: Record<string, unknown>, summary: string): CallToolResult {
  return { content: [{ type: 'text', text: summary }], structuredContent: result };
}

export function makeConnectorHandler(client: OrbotoClient) {
  return async (args: Args): Promise<CallToolResult> => {
    const need = (field: keyof Args) => { if (args[field] === undefined || args[field] === null || args[field] === '') throw new Error(`${args.action} needs ${String(field)}.`); };
    need('projectKey');
    const project = await resolveProjectByKey(client, args.projectKey);
    if (args.action === 'source_link') {
      need('ticketKey');
      const ticket = await resolveTicketByKey(client, args.ticketKey!);
      const out = await client.get<{ sourceLink: { provider: string; externalKey: string; externalUrl: string; state: string; sourceOwnedFields: string[] } | null }>(`/projects/${project.id}/tickets/${ticket.id}/source-link`);
      const s = out.sourceLink;
      return text(out, s ? `${args.ticketKey} mirrors ${s.provider} ${s.externalKey} (${s.state}) ${s.externalUrl}; owned there: ${s.sourceOwnedFields.join(', ') || 'nothing'}` : `${args.ticketKey} mirrors no source issue.`);
    }
    if (args.action === 'list') {
      const rows = await client.get<Link[]>(`/projects/${project.id}/connectors`);
      return text({ links: rows }, rows.length ? rows.map(line).join('\n') : `${project.key} is linked to no external project.`);
    }
    need('linkId');
    if (args.action === 'health') {
      const h = await client.get<Record<string, unknown> & { healthy: boolean; reasons: string[]; state: string; linkedIssues: number; outbox: { pending: number; failed: number; dead: number } }>(`/projects/${project.id}/connectors/${args.linkId}/health`);
      return text(h, `${h.healthy ? 'healthy' : `needs attention: ${h.reasons.join(', ')}`} - state=${h.state} mirrored=${h.linkedIssues} outbox pending=${h.outbox.pending} failed=${h.outbox.failed} dead=${h.outbox.dead}`);
    }
    const out = await client.post<{ reconciled: number; imported: number; unlinked: number }>(`/projects/${project.id}/connectors/${args.linkId}/sync`, {});
    return text(out, `Reconciled ${out.reconciled}, imported ${out.imported}, unlinked ${out.unlinked}.`);
  };
}

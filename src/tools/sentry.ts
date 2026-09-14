/**
 * ORB-2123 - `orboto_sentry`: the Sentry connector in one tool. Mapping
 * CRUD, health, secret rotation, the triage-lane binding and the lane's
 * verdict write share an `action` so the full manifest stays under its
 * shrink-only ceiling.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';
import { mcpInstanceToken, resolveProjectByKey, resolveTicketByKey } from './shared.js';

const ACTIONS = ['list', 'health', 'connect', 'update', 'rotate_secret', 'disconnect', 'triage_lane', 'verdict'] as const;
type Action = (typeof ACTIONS)[number];

export const sentryToolConfig = {
  title: 'Sentry connector',
  description:
    'Sentry connector (ORB-2123): list, health, connect (orgSlug, projectSlug, clientSecret), update (triageMode comment|fix_branch), rotate_secret, disconnect, triage_lane (laneId, empty unbinds), verdict (ticketKey, verdict known_fixed|regression|new, summary). Secrets never come back; docs/sentry-intake.md.',
  inputSchema: z.object({
    action: z.enum(ACTIONS),
    projectKey: z.string().min(1),
    connectionId: z.string().uuid().optional(),
    orgSlug: z.string().optional(),
    projectSlug: z.string().optional(),
    clientSecret: z.string().optional(),
    triageMode: z.enum(['comment', 'fix_branch']).optional(),
    laneId: z.string().optional(),
    ticketKey: z.string().optional(),
    verdict: z.enum(['known_fixed', 'regression', 'new']).optional(),
    summary: z.string().optional(),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
};

type Args = {
  action: Action; projectKey: string; connectionId?: string; orgSlug?: string; projectSlug?: string; clientSecret?: string;
  triageMode?: 'comment' | 'fix_branch'; laneId?: string; ticketKey?: string; verdict?: 'known_fixed' | 'regression' | 'new'; summary?: string;
};

interface Connection { id: string; orgSlug: string; projectSlug: string; enabled: boolean; triageMode: string; hasAuthToken: boolean; webhookUrl: string; lastWebhookAt: string | null; lastSignatureOk: boolean | null; lastError: string | null; webhookCount: number; triageLaneId: string | null; dailyTriageLimit: number | null; escalationUserId: string | null }

function line(c: Connection): string {
  return `- ${c.id} ${c.orgSlug}/${c.projectSlug} mode=${c.triageMode} ${c.enabled ? 'enabled' : 'paused'} token=${c.hasAuthToken ? 'yes' : 'no'} deliveries=${c.webhookCount} last=${c.lastWebhookAt ?? 'never'}${c.lastError ? ` error=${c.lastError}` : ''}\n  webhook ${c.webhookUrl}`;
}

function text(result: Record<string, unknown>, summary: string): CallToolResult {
  return { content: [{ type: 'text', text: summary }], structuredContent: result };
}

export function makeSentryHandler(client: OrbotoClient) {
  return async (args: Args): Promise<CallToolResult> => {
    const project = await resolveProjectByKey(client, args.projectKey);
    const need = (field: keyof Args) => { if (args[field] === undefined || args[field] === null || args[field] === '') throw new Error(`${args.action} needs ${String(field)}.`); };
    if (args.action === 'list') {
      const rows = await client.get<Connection[]>(`/projects/${project.id}/sentry-connections`);
      return text({ connections: rows }, rows.length ? rows.map(line).join('\n') : `No Sentry connection on ${project.key}.`);
    }
    if (args.action === 'connect') {
      need('orgSlug'); need('projectSlug'); need('clientSecret');
      const created = await client.post<Connection & { webhookUrlWarning: { message: string } | null }>(`/projects/${project.id}/sentry-connections`, {
        orgSlug: args.orgSlug, projectSlug: args.projectSlug, clientSecret: args.clientSecret,
        ...(args.triageMode ? { triageMode: args.triageMode } : {}),
      });
      const { webhookUrlWarning, ...connection } = created;
      return text({ connection }, `Connected ${created.orgSlug}/${created.projectSlug} to ${project.key} (${created.id}).\n${line(created)}${webhookUrlWarning ? `\nWarning: ${webhookUrlWarning.message}` : ''}`);
    }
    need('connectionId');
    if (args.action === 'health') {
      const health = await client.get<Record<string, unknown> & { healthy: boolean; lastWebhookAt: string | null; lastError: string | null; linkedIssues: number; openLinkedIssues: number; webhookCount: number }>(`/projects/${project.id}/sentry-connections/${args.connectionId}/health`);
      return text(health, `${health.healthy ? 'healthy' : 'needs attention'} - deliveries=${health.webhookCount} last=${health.lastWebhookAt ?? 'never'} linked=${health.linkedIssues} open=${health.openLinkedIssues}${health.lastError ? ` error=${health.lastError}` : ''}`);
    }
    if (args.action === 'update') {
      need('triageMode');
      const row = await client.patch<Connection>(`/projects/${project.id}/sentry-connections/${args.connectionId}`, { triageMode: args.triageMode });
      return text({ connection: row }, `Triage mode is now ${row.triageMode}.\n${line(row)}`);
    }
    if (args.action === 'rotate_secret') {
      need('clientSecret');
      const row = await client.post<Connection>(`/projects/${project.id}/sentry-connections/${args.connectionId}/rotate-secret`, { clientSecret: args.clientSecret });
      return text({ connection: row }, `Client secret replaced on ${row.id}; deliveries signed with the old secret are rejected from now on.`);
    }
    if (args.action === 'disconnect') {
      await client.delete(`/projects/${project.id}/sentry-connections/${args.connectionId}`);
      return text({ deleted: true, connectionId: args.connectionId }, `Disconnected ${args.connectionId} from ${project.key}.`);
    }
    if (args.action === 'triage_lane') {
      const out = await client.put<{ connection: Connection; lane: { id: string; name: string; assignmentVersion: number } | null }>(`/projects/${project.id}/sentry-connections/${args.connectionId}/triage-lane`, { laneId: args.laneId || null });
      return text(out, out.lane ? `Lane ${out.lane.name} bound (assignment v${out.lane.assignmentVersion}); mandate follows mode ${out.connection.triageMode}.` : 'Triage lane unbound; the mandate was withdrawn.');
    }
    need('ticketKey'); need('verdict'); need('summary');
    const ticket = await resolveTicketByKey(client, args.ticketKey!);
    const body = { verdict: args.verdict, summary: args.summary, agentSessionToken: mcpInstanceToken() };
    const result = await client.post<{ ticketKey: string | null; verdict: string; mode: string; closed: boolean; escalated: boolean; branchName: string | null; workSessionId: string | null; nextStep: string; priority: string | null }>(`/projects/${project.id}/sentry-connections/${args.connectionId}/triage/${ticket.id}/verdict`, body);
    return text(result, `${result.ticketKey ?? ticket.id}: ${result.verdict} (${result.mode}) priority=${result.priority ?? '-'}${result.closed ? ' closed' : ''}${result.escalated ? ' escalated' : ''}${result.branchName ? ` branch=${result.branchName} session=${result.workSessionId}` : ''} next=${result.nextStep}`);
  };
}

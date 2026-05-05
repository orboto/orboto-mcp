/**
 * ORB-244 Phase C Group 4 — admin-only tools.
 *
 * These three are listed under "write tools" in the ticket because
 * they're privileged surfaces, but two of them (`list_users`,
 * `get_audit_log`) are read-only — the gating is what makes them
 * "writes" from a permission perspective. `trigger_backup` is the
 * only true mutation.
 *
 * Gating: the API enforces super-admin via the `admin:*` permission
 * slugs. A non-admin's request lands a 403 from the API, which
 * surfaces as OrbotoApiError on the MCP side. The tools themselves
 * don't double-check — that would race against the API anyway. We
 * just rewrite 403 into a clear message.
 *
 * Tools:
 *   - orboto_list_users — admin user directory with cursor pagination
 *   - orboto_get_audit_log — recent admin / mutation events
 *   - orboto_trigger_backup — run a configured backup job by name
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OrbotoApiError, type OrbotoClient } from '../orboto-client.js';

interface UserRow {
  id: string;
  email: string;
  fullName: string;
  isActive: boolean;
  isExternal: boolean;
  isBot: boolean;
  createdAt: string;
  lastSeenAt?: string | null;
}

interface AuditEntry {
  id: string;
  actorId: string | null;
  actorEmail: string | null;
  actorName: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

interface BackupJob {
  id: string;
  name: string;
  scope: string;
  schedule: string | null;
  isActive: boolean;
}

interface BackupRun {
  id: string;
  jobId: string | null;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  storagePath: string | null;
  error: string | null;
}

function rewrite403(action: string): (err: unknown) => never {
  return (err) => {
    if (err instanceof OrbotoApiError && err.status === 403) {
      throw new Error(`${action} requires super-admin permissions on this workspace.`);
    }
    throw err as Error;
  };
}

// ---------------------------------------------------------------------------
// orboto_list_users
// ---------------------------------------------------------------------------

export const listUsersToolConfig = {
  title: 'List workspace users (admin)',
  description:
    'Return the workspace user directory. Super-admin only. Useful for AI agents that need to look up an email beyond their visible project members (e.g. to assign someone who isn\'t on the current project yet). Imported placeholder users (`*@imported.ghost`) are hidden by default; set `showGhosts=true` to include them.',
  inputSchema: z.object({
    search: z.string().optional().describe('Substring match against fullName + email.'),
    limit: z.number().int().min(1).max(100).default(50),
    showGhosts: z.boolean().optional().describe('Include `*@imported.ghost` placeholder users created during project imports. Off by default.'),
  }).shape,
};

export function makeListUsersHandler(client: OrbotoClient) {
  return async ({ search, limit, showGhosts }: {
    search?: string; limit?: number; showGhosts?: boolean;
  }): Promise<CallToolResult> => {
    const qs = new URLSearchParams();
    qs.set('limit', String(limit ?? 50));
    if (search) qs.set('search', search);
    if (showGhosts) qs.set('hideGhosts', 'false');
    const page = await client.get<{ items: UserRow[]; nextCursor: string | null }>(
      `/admin/users?${qs}`,
    ).catch(rewrite403('list_users'));

    const text = page.items.length === 0
      ? 'No users matched.'
      : page.items.map((u) => {
        const tags: string[] = [];
        if (u.isBot) tags.push('bot');
        if (u.isExternal) tags.push('external');
        if (!u.isActive) tags.push('disabled');
        return `- ${u.fullName} <${u.email}>${tags.length ? ` [${tags.join(', ')}]` : ''}`;
      }).join('\n');

    return {
      content: [{ type: 'text', text }],
      structuredContent: {
        count: page.items.length,
        hasMore: !!page.nextCursor,
        users: page.items.map((u) => ({
          email: u.email,
          fullName: u.fullName,
          isActive: u.isActive,
          isExternal: u.isExternal,
          isBot: u.isBot,
          lastSeenAt: u.lastSeenAt ?? null,
        })),
      },
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_get_audit_log
// ---------------------------------------------------------------------------

export const getAuditLogToolConfig = {
  title: 'Read the workspace audit log (admin)',
  description:
    'Recent audit events — admin actions, role changes, ticket deletions, federation handshakes, etc. Super-admin only. Filter by actor or entity to narrow the window.',
  inputSchema: z.object({
    actorEmail: z.string().email().optional().describe('Filter to one actor.'),
    entityType: z.string().optional().describe('e.g. "user", "project", "ticket", "federation_link".'),
    limit: z.number().int().min(1).max(100).default(50),
  }).shape,
};

export function makeGetAuditLogHandler(client: OrbotoClient) {
  return async ({ actorEmail, entityType, limit }: {
    actorEmail?: string; entityType?: string; limit?: number;
  }): Promise<CallToolResult> => {
    const qs = new URLSearchParams();
    qs.set('limit', String(limit ?? 50));
    if (entityType) qs.set('entityType', entityType);
    if (actorEmail) {
      // Resolve actor email → userId via the admin users list.
      const userPage = await client.get<{ items: UserRow[] }>(
        `/admin/users?search=${encodeURIComponent(actorEmail)}&limit=10`,
      ).catch(rewrite403('audit log lookup'));
      const actor = userPage.items.find((u) => u.email.toLowerCase() === actorEmail.toLowerCase());
      if (!actor) throw new Error(`No workspace user with email "${actorEmail}".`);
      qs.set('actorId', actor.id);
    }

    const page = await client.get<{ items: AuditEntry[]; nextCursor: string | null }>(
      `/admin/audit-log?${qs}`,
    ).catch(rewrite403('audit log'));

    const text = page.items.length === 0
      ? 'No matching audit entries.'
      : page.items.map((e) => {
        const who = e.actorName ?? e.actorEmail ?? '(system)';
        const what = e.entityType
          ? ` ${e.entityType}${e.entityId ? `:${e.entityId.slice(0, 8)}` : ''}`
          : '';
        return `- ${e.createdAt} · ${who} → ${e.action}${what}`;
      }).join('\n');

    return {
      content: [{ type: 'text', text }],
      structuredContent: {
        count: page.items.length,
        hasMore: !!page.nextCursor,
        entries: page.items.map((e) => ({
          actorEmail: e.actorEmail,
          action: e.action,
          entityType: e.entityType,
          entityId: e.entityId,
          createdAt: e.createdAt,
        })),
      },
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_trigger_backup
// ---------------------------------------------------------------------------

export const triggerBackupToolConfig = {
  title: 'Run a configured backup job now (admin)',
  description:
    'Manually trigger a backup job by name. Resolves to the job\'s UUID via /admin/backup/jobs and POSTs to the run endpoint. Super-admin only.',
  inputSchema: z.object({
    jobName: z.string().min(1).describe('Name of an existing backup job (configured at /admin/backup).'),
  }).shape,
};

export function makeTriggerBackupHandler(client: OrbotoClient) {
  return async ({ jobName }: { jobName: string }): Promise<CallToolResult> => {
    const jobs = await client.get<BackupJob[]>('/admin/backup/jobs')
      .catch(rewrite403('list_backup_jobs'));
    const job = jobs.find((j) => j.name === jobName);
    if (!job) {
      throw new Error(
        `No backup job named "${jobName}". Existing jobs: ${
          jobs.map((j) => `"${j.name}"`).join(', ') || '(none)'
        }`,
      );
    }
    if (!job.isActive) {
      throw new Error(`Backup job "${jobName}" is currently disabled — enable it in /admin/backup first.`);
    }

    const run = await client.post<BackupRun>(`/admin/backup/jobs/${job.id}/run`, {})
      .catch(rewrite403('trigger_backup'));

    return {
      content: [{
        type: 'text',
        text: `Started backup job "${jobName}" (run id ${run.id.slice(0, 8)}, status: ${run.status}).`,
      }],
      structuredContent: {
        jobName,
        runId: run.id,
        status: run.status,
        startedAt: run.startedAt,
      },
    };
  };
}

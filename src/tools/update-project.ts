import { ProjectReadinessSchema, type ProjectReadiness } from './project-readiness-schema.js';
import { ProjectSpecSettingsSchema, type ProjectSpecSettings } from './spec-schemas.js';
/**
 * ORB-885 - `orboto_update_project`.
 * ORB-830 - `orboto_create_project` + `orboto_archive_project`.
 *
 * @see ORB-244
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';
import { resolveProjectByKey, type ProjectRow } from './shared.js';

const PROJECT_KEY_RE = /^[A-Z0-9]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCALE_CODES = ['en', 'de', 'fr', 'es', 'it', 'nl', 'pt', 'ru', 'pl', 'tr', 'cs', 'da', 'sv', 'no', 'fi', 'ja', 'zh', 'ko'] as const;
type LocaleCode = (typeof LOCALE_CODES)[number];

export const updateProjectToolConfig = {
  title: 'Update a project',
  description:
    'Patch a project; set at least one field. `status` archived or closed leaves rotation. `language` null inherits. `noLaneReason`: no headless lane needed (bots work interactively); null clears. A new `key` goes alone in the patch and is a dry run that answers what would change; to apply it, send the current key, typed by the user, as `confirmProjectKey` and set `rewriteExistingTickets` (true moves every ticket, doc, milestone and space key, old ticket keys stay as aliases).',
  inputSchema: z.object({
    projectKey: z.string().min(1).describe('Current project key.'),
    confirmProjectKey: z.string().min(1).optional()
      .describe('Key change only: the CURRENT key as the user typed it; without it the key change is a dry run.'),
    rewriteExistingTickets: z.boolean().optional()
      .describe('Key change only: required with confirmProjectKey; true rewrites existing ticket, doc, milestone and space keys.'),
    patch: z.object({
      spec: ProjectSpecSettingsSchema.optional(),
      name: z.string().min(1).max(255).optional(),
      description: z.string().nullable().optional().describe('Null clears.'),
      key: z.string().min(2).max(10).regex(PROJECT_KEY_RE).optional()
        .describe('New key; alone in the patch, dry run unless confirmProjectKey is set.'),
      status: z.enum(['draft', 'active', 'archived', 'closed']).optional(),
      branchTemplate: z.string().max(100).nullable().optional(),
      customerId: z.string().regex(UUID_RE).nullable().optional()
        .describe('Customer UUID; null detaches.'),
      language: z.enum(LOCALE_CODES).nullable().optional()
        .describe('Content language; null inherits workspace.'),
      noLaneReason: z.string().nullable().optional(),
      browserAllowedHosts: z.array(z.string().max(253)).max(50).optional()
        .describe('Hosts its orboto browser sessions may act on beyond the default; replaces the list, [] clears.'),
    }).refine((p) => Object.keys(p).length > 0, { message: 'patch must include at least one field' }),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
};

type KeyChangeCounts = {
  ticketsUpdated: number; docsUpdated: number; milestonesUpdated: number; spacesUpdated: number;
  smartLinkTokens: number; gitActivities: number; aliasesWritten: number;
};
type KeyChangeResult = { project: ProjectRow; dryRun: boolean; oldKey: string; newKey: string; rewriteExistingTickets: boolean } & KeyChangeCounts & Record<string, unknown>;

/** What a rewrite of the existing keys touches, from the counts of change-key. */
const rewriteCounts = (r: KeyChangeCounts) => `${r.ticketsUpdated} ticket, ${r.docsUpdated} doc, ${r.milestonesUpdated} milestone and ${r.spacesUpdated} space keys and ${r.smartLinkTokens} smart-link tokens, keeping ${r.aliasesWritten} old ticket keys as aliases`;
const KEYS_STAY = 'only the project key changes and every existing ticket, doc, milestone and space key stays';

export function makeUpdateProjectHandler(client: OrbotoClient) {
  return async ({ projectKey, confirmProjectKey, rewriteExistingTickets, patch }: {
    projectKey: string;
    confirmProjectKey?: string;
    rewriteExistingTickets?: boolean;
    patch: {
      spec?: ProjectSpecSettings;
      name?: string;
      description?: string | null;
      key?: string;
      status?: 'draft' | 'active' | 'archived' | 'closed';
      branchTemplate?: string | null;
      customerId?: string | null;
      language?: LocaleCode | null;
      noLaneReason?: string | null;
      browserAllowedHosts?: string[];
    };
  }): Promise<CallToolResult> => {
    const { key, ...rest } = patch;
    if (key !== undefined && Object.keys(rest).length > 0) {
      throw new Error('A key change goes alone in the patch: change the other fields in a separate call, so one failure never leaves half a change.');
    }
    if (key === undefined && (confirmProjectKey !== undefined || rewriteExistingTickets !== undefined)) {
      throw new Error('confirmProjectKey and rewriteExistingTickets belong to a key change; set patch.key or leave them out.');
    }
    if (confirmProjectKey !== undefined && rewriteExistingTickets === undefined) {
      throw new Error('Set rewriteExistingTickets (true or false) with confirmProjectKey; the key change does not pick it for you.');
    }
    const project = await resolveProjectByKey(client, projectKey);
    if (key !== undefined) return changeProjectKey(client, project, key, confirmProjectKey, rewriteExistingTickets);
    const updated = await client.patch<ProjectRow>(`/projects/${project.id}`, rest);
    const fields = Object.keys(patch).join(', ');
    return {
      content: [{
        type: 'text',
        text: `Updated project ${updated.key} - ${updated.name} (${fields}).`,
      }],
      structuredContent: {
        id: updated.id,
        key: updated.key,
        name: updated.name,
        description: updated.description,
        status: updated.status,
        language: updated.language ?? null,
        noLaneReason: updated.noLaneReason ?? null,
        browserAllowedHosts: updated.browserAllowedHosts ?? [],
        spec: updated.spec,
      },
    };
  };
}

/** ORB-3175 - a key change mirrors `orboto project change-key`: a dry run unless the caller typed the current key and chose rewriteExistingTickets. */
async function changeProjectKey(client: OrbotoClient, project: ProjectRow, key: string, confirm: string | undefined, rewrite: boolean | undefined): Promise<CallToolResult> {
  const dryRun = confirm === undefined;
  const body: Record<string, unknown> = { key, rewriteExistingTickets: rewrite ?? true, dryRun };
  if (!dryRun) body.confirmProjectKey = confirm;
  const result = await client.post<KeyChangeResult>(`/projects/${project.id}/change-key`, body);
  const { project: row, ...counts } = result;
  const scope = !result.rewriteExistingTickets
    ? `rewriteExistingTickets is false, so ${KEYS_STAY} and no rewrite is counted; ${result.gitActivities} commits, branches and PRs name the old prefix.`
    : rewrite === undefined
      ? `With rewriteExistingTickets true the change rewrites ${rewriteCounts(result)}; with false ${KEYS_STAY}.`
      : `It rewrites ${rewriteCounts(result)}.`;
  const text = result.oldKey === result.newKey
    ? `${project.key} already has the key ${result.newKey}; nothing to change.`
    : result.dryRun
      ? `Dry run: ${result.oldKey} -> ${result.newKey}. Nothing changed. ${scope} To apply it, ask the user to type the current key and call again with confirmProjectKey and rewriteExistingTickets.`
      : `Project key changed: ${result.oldKey} -> ${result.newKey}. ${scope.replace('It rewrites', 'It rewrote')}`;
  return {
    content: [{ type: 'text', text }],
    structuredContent: { id: row.id, key: row.key, name: row.name, status: row.status, keyChange: counts },
  };
}

/** ORB-2503 - a customer by UUID or by case-insensitive exact name; an ambiguous or unknown name is refused with the candidates. */
export async function resolveCustomerRef(client: OrbotoClient, ref: string): Promise<string> {
  const wanted = ref.trim();
  if (UUID_RE.test(wanted)) return wanted;
  const rows = await client.get<Array<{ id: string; name: string }>>(`/customers?includeInactive=true&search=${encodeURIComponent(wanted)}`);
  const exact = rows.filter((c) => c.name.trim().toLowerCase() === wanted.toLowerCase());
  if (exact.length === 1) return exact[0].id;
  if (exact.length > 1) throw new Error(`Customer name "${wanted}" is ambiguous: ${exact.map((c) => `${c.name} (${c.id})`).join(', ')}. Pass the id.`);
  if (rows.length === 0) throw new Error(`No customer named "${wanted}".`);
  throw new Error(`No customer named exactly "${wanted}"; candidates: ${rows.map((c) => c.name).join(', ')}.`);
}

export const createProjectToolConfig = {
  title: 'Create a project',
  description: 'Create a project (key auto-derived if omitted). Agents pass customer or internal. Needs project:create. Returns readiness with fix actions; its doc space is auto-created.',
  inputSchema: z.object({
    name: z.string().min(1).max(255),
    key: z.string().min(2).max(10).regex(PROJECT_KEY_RE).optional(),
    description: z.string().nullable().optional(),
    customerId: z.string().regex(UUID_RE).nullable().optional(),
    customer: z.string().min(1).optional().describe('Customer name or UUID.'),
    internal: z.string().min(3).max(200).optional().describe('Reason for no customer.'),
    language: z.enum(LOCALE_CODES).nullable().optional()
      .describe('Null inherits workspace.'),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};

export function makeCreateProjectHandler(client: OrbotoClient) {
  return async ({ name, key, description, customerId, customer, internal, language }: {
    name: string;
    key?: string;
    description?: string | null;
    customerId?: string | null;
    customer?: string;
    internal?: string;
    language?: LocaleCode | null;
  }): Promise<CallToolResult> => {
    const body: Record<string, unknown> = { name };
    if (key !== undefined) body.key = key;
    if (description !== undefined) body.description = description;
    if (customerId !== undefined) body.customerId = customerId;
    if (customer !== undefined) body.customerId = await resolveCustomerRef(client, customer);
    if (internal !== undefined) Object.assign(body, { internal: true, internalReason: internal });
    if (language !== undefined) body.language = language;
    const created = await client.post<ProjectRow & { readiness?: ProjectReadiness }>('/projects', body);
    const parsed = ProjectReadinessSchema.safeParse(created.readiness);
    const readiness = parsed.success ? parsed.data : undefined;
    return {
      content: [{
        type: 'text',
        text: `Created project ${created.key} - ${created.name} (status: ${created.status}).${readiness ? ` Setup: ${readiness.ready ? 'ready' : 'incomplete; inspect readiness items and fix actions'}.` : ''}`,
      }],
      structuredContent: {
        readiness,
        id: created.id,
        key: created.key,
        name: created.name,
        description: created.description,
        status: created.status,
        language: created.language ?? null,
        customerId: created.customerId ?? null,
        internal: created.internal ?? false,
      },
    };
  };
}

export const archiveProjectToolConfig = {
  title: 'Archive a project',
  description:
    'Archive a project: out of the active rotation, no data deleted. Convenience wrapper around `orboto_update_project({ status: "archived" })` because "archive this project" is a workflow operators hit often. Archiving is reversible: pass the same project back through `orboto_update_project({ status: "active" })` to restore. Idempotent - re-archiving an already-archived project is a no-op success.',
  inputSchema: z.object({
    projectKey: z.string().min(1),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
};

export function makeArchiveProjectHandler(client: OrbotoClient) {
  return async ({ projectKey }: { projectKey: string }): Promise<CallToolResult> => {
    const project = await resolveProjectByKey(client, projectKey);
    if (project.status === 'archived') {
      return {
        content: [{
          type: 'text',
          text: `Project ${project.key} is already archived (no-op).`,
        }],
        structuredContent: {
          id: project.id,
          key: project.key,
          name: project.name,
          description: project.description,
          status: project.status,
          alreadyArchived: true,
        },
      };
    }
    const updated = await client.patch<ProjectRow>(`/projects/${project.id}`, { status: 'archived' });
    return {
      content: [{
        type: 'text',
        text: `Archived project ${updated.key} - ${updated.name}.`,
      }],
      structuredContent: {
        id: updated.id,
        key: updated.key,
        name: updated.name,
        description: updated.description,
        status: updated.status,
        alreadyArchived: false,
      },
    };
  };
}

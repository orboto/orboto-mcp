/**
 * ORB-510 / ORB-513 — primer-fact tools.
 *
 * Six tools that wrap the `/projects/:id/primer-facts` and
 * `/primer-facts/:id` REST surface from ORB-511. Agents call these to
 * record structured project facts — tech-stack details, conventions,
 * deployment quirks — that the AI primer (ORB-512) renders at the top
 * of every session. The skill rule (ORB-514) tells agents *when* to
 * record; these tools are the *how*.
 *
 * All tool descriptions and parameter `.describe()` strings are in
 * English so the international LLM tool-selection path is reliable.
 *
 * Wire order in server.ts:
 *   - orboto_primer_fact_list
 *   - orboto_primer_fact_add
 *   - orboto_primer_fact_update
 *   - orboto_primer_fact_supersede
 *   - orboto_primer_fact_verify
 *   - orboto_primer_fact_delete
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OrbotoApiError, type OrbotoClient } from '../orboto-client.js';
import { resolveProjectByKey } from './shared.js';

// ---------------------------------------------------------------------------
// Shared types + helpers
// ---------------------------------------------------------------------------

const PRIMER_FACT_CATEGORIES = [
  'tech_stack',
  'conventions',
  'deployment',
  'architecture',
  'integrations',
  'gotchas',
  'commands',
  'other',
] as const;

const PRIMER_FACT_SOURCES = ['manual', 'agent_observed', 'imported'] as const;

const PrimerFactCategoryEnum = z.enum(PRIMER_FACT_CATEGORIES);
const PrimerFactSourceEnum = z.enum(PRIMER_FACT_SOURCES);

interface PrimerFactRow {
  id: string;
  projectId: string | null;
  category: (typeof PRIMER_FACT_CATEGORIES)[number];
  key: string;
  value: string;
  source: (typeof PRIMER_FACT_SOURCES)[number];
  verified: boolean;
  verifiedBy: string | null;
  verifiedAt: string | null;
  lastVerifiedAt: string;
  supersededById: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

function rewritePermissionError(action: string): (err: unknown) => never {
  return (err) => {
    if (err instanceof OrbotoApiError && err.status === 403) {
      throw new Error(
        `${action} requires project:edit on the target project, or admin:ai:write for workspace-wide facts.`,
      );
    }
    if (err instanceof OrbotoApiError && err.status === 404) {
      throw new Error(`${action}: target not found (or not visible to your account).`);
    }
    if (err instanceof OrbotoApiError && err.status === 409) {
      throw new Error(
        `${action}: a fact with that category + key already exists in this scope. Use orboto_primer_fact_supersede or orboto_primer_fact_update instead.`,
      );
    }
    throw err as Error;
  };
}

function summariseFact(f: PrimerFactRow): string {
  const markers: string[] = [];
  if (f.source === 'agent_observed' && !f.verified) markers.push('observed');
  if (f.source === 'imported') markers.push('imported');
  if (f.supersededById) markers.push('superseded');
  const tag = markers.length > 0 ? ` _(${markers.join(', ')})_` : '';
  // Single-line preview of the value — multi-line bodies get truncated
  // so the list output stays scannable.
  const valuePreview = f.value.length > 120 || f.value.includes('\n')
    ? `${f.value.replace(/\n/g, ' ').slice(0, 120)}…`
    : f.value;
  const scope = f.projectId === null ? '[workspace]' : '[project]';
  return `- ${scope} **${f.category}/${f.key}**: ${valuePreview}${tag}`;
}

// ---------------------------------------------------------------------------
// orboto_primer_fact_list
// ---------------------------------------------------------------------------

export const primerFactListToolConfig = {
  title: 'List structured project primer facts',
  description:
    'List structured project facts that feed the AI primer (tech stack, conventions, deployment, architecture, integrations, gotchas, commands). Use this to discover what the project has already documented before adding a new observation. Workspace-wide facts (applying to every project) are merged in by default; pass includeWorkspace=false to see only project-scoped rows.',
  inputSchema: z.object({
    projectKey: z.string().min(1).describe('Project key, e.g. "ORB". Case-insensitive.'),
    category: PrimerFactCategoryEnum.optional().describe(
      'Filter by category. Omit for all categories.',
    ),
    source: PrimerFactSourceEnum.optional().describe(
      'Filter by provenance: manual (operator), agent_observed (bot, awaiting verification), imported.',
    ),
    verified: z.boolean().optional().describe(
      'Filter by verification flag. true = verified facts only, false = unverified only.',
    ),
    includeWorkspace: z.boolean().default(true).describe(
      'When true (default), workspace-wide facts that apply to every project are merged into the result.',
    ),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makePrimerFactListHandler(client: OrbotoClient) {
  return async ({
    projectKey,
    category,
    source,
    verified,
    includeWorkspace,
  }: {
    projectKey: string;
    category?: (typeof PRIMER_FACT_CATEGORIES)[number];
    source?: (typeof PRIMER_FACT_SOURCES)[number];
    verified?: boolean;
    includeWorkspace?: boolean;
  }): Promise<CallToolResult> => {
    const project = await resolveProjectByKey(client, projectKey);
    const qs = new URLSearchParams();
    if (category) qs.set('category', category);
    if (source) qs.set('source', source);
    if (verified !== undefined) qs.set('verified', String(verified));
    qs.set('includeWorkspace', String(includeWorkspace ?? true));
    const path = `/projects/${project.id}/primer-facts${qs.toString() ? `?${qs}` : ''}`;
    const rows = await client.get<PrimerFactRow[]>(path).catch(
      rewritePermissionError('list primer facts'),
    );

    const text = rows.length === 0
      ? 'No primer facts in scope.'
      : rows.map(summariseFact).join('\n');

    return {
      content: [{ type: 'text', text }],
      structuredContent: {
        count: rows.length,
        facts: rows.map((f) => ({
          id: f.id,
          scope: f.projectId === null ? 'workspace' : 'project',
          category: f.category,
          key: f.key,
          value: f.value,
          source: f.source,
          verified: f.verified,
          lastVerifiedAt: f.lastVerifiedAt,
        })),
      },
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_primer_fact_add
// ---------------------------------------------------------------------------

export const primerFactAddToolConfig = {
  title: 'Record a new project primer fact',
  description:
    'Record a new structured fact about the project that future AI agents should see at session start. Use when you learn something during work that is missing from the primer (a library version, a convention, a deployment quirk, an architecture decision). Note: the auto-generated primer does NOT automatically include CLAUDE.md / AGENTS.md content unless the operator configured repo briefings and the API host can read those files from disk — most deployments cannot. Treat key conventions documented in CLAUDE.md / AGENTS.md as fair game to record here so they survive cross-deployment. Set observed=true when you are recording from a bot/agent context — the fact will land as agent_observed and require operator verification before losing the (observed) marker.',
  inputSchema: z.object({
    projectKey: z.string().min(1).describe('Project key, e.g. "ORB". Case-insensitive.'),
    category: PrimerFactCategoryEnum.describe(
      'Category bucket. Pick the closest fit; categories are fixed.',
    ),
    key: z.string().min(1).max(120).describe(
      'Short machine-readable identifier, e.g. "package-manager", "node-version", "css-framework". Lowercase + dashes preferred.',
    ),
    value: z.string().min(1).max(8000).describe(
      'Human-readable Markdown body, 1-3 sentences typically. Include a version number, a path, or a command where relevant.',
    ),
    observed: z.boolean().default(false).describe(
      'True = source is agent_observed (needs operator verification). False = manual entry by operator. Bots without project:edit get coerced to agent_observed server-side regardless.',
    ),
  }).shape,
};

export function makePrimerFactAddHandler(client: OrbotoClient) {
  return async ({
    projectKey,
    category,
    key,
    value,
    observed,
  }: {
    projectKey: string;
    category: (typeof PRIMER_FACT_CATEGORIES)[number];
    key: string;
    value: string;
    observed?: boolean;
  }): Promise<CallToolResult> => {
    const project = await resolveProjectByKey(client, projectKey);
    const body = {
      category,
      key,
      value,
      source: observed ? ('agent_observed' as const) : ('manual' as const),
    };
    const row = await client
      .post<PrimerFactRow>(`/projects/${project.id}/primer-facts`, body)
      .catch(rewritePermissionError('add primer fact'));

    return {
      content: [{
        type: 'text',
        text: `Recorded ${project.key} primer fact: ${row.category}/${row.key} (source: ${row.source}, id ${row.id.slice(0, 8)}).`,
      }],
      structuredContent: {
        id: row.id,
        category: row.category,
        key: row.key,
        source: row.source,
        verified: row.verified,
      },
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_primer_fact_update
// ---------------------------------------------------------------------------

export const primerFactUpdateToolConfig = {
  title: 'Update an existing primer fact',
  description:
    'Update an existing fact. Use this when the value has changed (e.g. version bumped) or you are renaming the key. Bumps last_verified_at automatically when the value changes; pure renames leave it untouched. To replace a fact while preserving history, use orboto_primer_fact_supersede instead.',
  inputSchema: z.object({
    factId: z.string().min(1).describe('UUID of the fact to update. Read it from orboto_primer_fact_list output.'),
    value: z.string().min(1).max(8000).optional().describe('New Markdown body.'),
    category: PrimerFactCategoryEnum.optional().describe('New category.'),
    key: z.string().min(1).max(120).optional().describe('New key.'),
  }).shape,
};

export function makePrimerFactUpdateHandler(client: OrbotoClient) {
  return async ({
    factId,
    value,
    category,
    key,
  }: {
    factId: string;
    value?: string;
    category?: (typeof PRIMER_FACT_CATEGORIES)[number];
    key?: string;
  }): Promise<CallToolResult> => {
    const body: Record<string, unknown> = {};
    if (value !== undefined) body.value = value;
    if (category !== undefined) body.category = category;
    if (key !== undefined) body.key = key;
    if (Object.keys(body).length === 0) {
      throw new Error('orboto_primer_fact_update needs at least one of value, category, key.');
    }
    const row = await client
      .patch<PrimerFactRow>(`/primer-facts/${factId}`, body)
      .catch(rewritePermissionError('update primer fact'));

    return {
      content: [{
        type: 'text',
        text: `Updated primer fact ${row.category}/${row.key} (id ${row.id.slice(0, 8)}).`,
      }],
      structuredContent: {
        id: row.id,
        category: row.category,
        key: row.key,
        lastVerifiedAt: row.lastVerifiedAt,
      },
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_primer_fact_supersede
// ---------------------------------------------------------------------------

export const primerFactSupersedeToolConfig = {
  title: 'Replace a primer fact while preserving history',
  description:
    'Replace a fact with a corrected version, preserving the old one in history (linked via superseded_by_id). Use when you discover a previously recorded fact was wrong; do not just delete it. The old row gets a tombstoned key suffix so the partial unique index does not collide; the new row starts unverified and needs operator verification before losing the (observed) marker.',
  inputSchema: z.object({
    oldFactId: z.string().min(1).describe('UUID of the fact being replaced.'),
    category: PrimerFactCategoryEnum.describe('Category of the new fact (usually unchanged).'),
    key: z.string().min(1).max(120).describe('Key of the new fact (usually unchanged).'),
    value: z.string().min(1).max(8000).describe('Corrected Markdown body.'),
  }).shape,
};

export function makePrimerFactSupersedeHandler(client: OrbotoClient) {
  return async ({
    oldFactId,
    category,
    key,
    value,
  }: {
    oldFactId: string;
    category: (typeof PRIMER_FACT_CATEGORIES)[number];
    key: string;
    value: string;
  }): Promise<CallToolResult> => {
    const row = await client
      .post<PrimerFactRow>(`/primer-facts/${oldFactId}/supersede`, { category, key, value })
      .catch(rewritePermissionError('supersede primer fact'));

    return {
      content: [{
        type: 'text',
        text: `Superseded primer fact: new id ${row.id.slice(0, 8)}, category ${row.category}, key ${row.key}.`,
      }],
      structuredContent: {
        newId: row.id,
        category: row.category,
        key: row.key,
        verified: row.verified,
      },
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_primer_fact_verify
// ---------------------------------------------------------------------------

export const primerFactVerifyToolConfig = {
  title: 'Verify an agent-observed primer fact',
  description:
    'Promote an agent-observed fact to verified. Operator-only action; bots without project:edit cannot self-verify. Removes the (observed) marker from the rendered primer and stamps verifiedBy / verifiedAt.',
  inputSchema: z.object({
    factId: z.string().min(1).describe('UUID of the fact to verify.'),
  }).shape,
};

export function makePrimerFactVerifyHandler(client: OrbotoClient) {
  return async ({ factId }: { factId: string }): Promise<CallToolResult> => {
    const row = await client
      .post<PrimerFactRow>(`/primer-facts/${factId}/verify`, {})
      .catch(rewritePermissionError('verify primer fact'));

    return {
      content: [{
        type: 'text',
        text: `Verified primer fact ${row.category}/${row.key} (id ${row.id.slice(0, 8)}).`,
      }],
      structuredContent: {
        id: row.id,
        verified: row.verified,
        verifiedBy: row.verifiedBy,
        verifiedAt: row.verifiedAt,
      },
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_primer_fact_delete
// ---------------------------------------------------------------------------

export const primerFactDeleteToolConfig = {
  title: 'Delete a primer fact',
  description:
    'Hard-delete a fact. Prefer orboto_primer_fact_supersede when the fact is being replaced; only delete when the fact was wrong from the start or no longer relevant. Writes an audit-log entry; the row itself is gone (no soft-delete).',
  inputSchema: z.object({
    factId: z.string().min(1).describe('UUID of the fact to delete.'),
    reason: z.string().max(500).optional().describe(
      'Optional human-readable reason; recorded in the audit log details for future operators.',
    ),
  }).shape,
};

export function makePrimerFactDeleteHandler(client: OrbotoClient) {
  return async ({ factId, reason }: { factId: string; reason?: string }): Promise<CallToolResult> => {
    // ORB-516 — pass the reason through so the audit-log entry
    // captures it. Old API versions silently ignore the querystring
    // so there's no compat risk.
    const path = reason
      ? `/primer-facts/${factId}?reason=${encodeURIComponent(reason)}`
      : `/primer-facts/${factId}`;
    await client.delete(path).catch(rewritePermissionError('delete primer fact'));
    return {
      content: [{
        type: 'text',
        text: `Deleted primer fact ${factId.slice(0, 8)}${reason ? ` (reason: ${reason})` : ''}.`,
      }],
      structuredContent: { id: factId, deleted: true, reason: reason ?? null },
    };
  };
}

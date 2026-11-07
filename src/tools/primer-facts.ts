/**
 * ORB-510 / ORB-513 - primer-fact tools; ORB-2773 - an agent's fact is live at once with its evidence, a person pins.
 *
 * @see ORB-511, ORB-512, ORB-514
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OrbotoApiError, type OrbotoClient } from '../orboto-client.js';
import { OVERSIZE_REASON_PARAM, resolveProjectByKey, sizeBlockResult } from './shared.js';

const FACT_WRITING_CONTRACT =
  ' Fact: <= 300 chars, one fact per key, the value is the fact - long material goes into a doc, the fact holds the doc key.';

const LIVE_CONTRACT =
  ' Live at once with your evidence and session; an unpinned fact under the key is replaced (history kept), a pinned one stays and your value becomes a wiki lesson - nothing to ask, continue. 30 agent writes per session-hour (429).';

const PRIMER_FACT_CATEGORIES = [
  'tech_stack',
  'conventions',
  'deployment',
  'architecture',
  'integrations',
  'gotchas',
  'commands',
  'non_functional',
  'glossary',
  'other',
] as const;

const PRIMER_FACT_SOURCES = ['manual', 'agent_observed', 'imported'] as const;

const PrimerFactCategoryEnum = z.enum(PRIMER_FACT_CATEGORIES);
const PrimerFactSourceEnum = z.enum(PRIMER_FACT_SOURCES);

const EvidenceParam = z.string().min(1).max(600).optional().describe(
  'Required for an agent: file:line, command output or doc key.',
);

interface PrimerFactRow {
  id: string;
  projectId: string | null;
  projectKey?: string | null;
  category: (typeof PRIMER_FACT_CATEGORIES)[number];
  key: string;
  value: string;
  source: (typeof PRIMER_FACT_SOURCES)[number];
  verified: boolean;
  pinned?: boolean;
  verifiedBy: string | null;
  verifiedAt: string | null;
  lastVerifiedAt: string;
  supersededById: string | null;
  createdBy: string | null;
  createdByName?: string | null;
  agentSessionLabel?: string | null;
  evidence?: string | null;
  earlierVersions?: number;
  createdAt: string;
  updatedAt: string;
  replaced?: { id: string; value: string } | null;
  sizeWarning?: { chars: number; limit: number; hint: string };
}

interface LessonAnswer {
  outcome: 'lesson';
  fact: PrimerFactRow;
  lesson: { id: string; key: string | null; title: string; webUrl: string } | null;
  text: string;
}

type WriteAnswer = PrimerFactRow | LessonAnswer;

function isLesson(answer: WriteAnswer): answer is LessonAnswer {
  return (answer as LessonAnswer).outcome === 'lesson';
}

function serverRefusal(err: OrbotoApiError): string | null {
  try {
    const parsed = JSON.parse(err.body) as { error?: string; errorKey?: string };
    if (parsed.errorKey && parsed.error && /^errors\.(primer_facts|knowledge|content\.secret)/.test(parsed.errorKey)) {
      const retry = err.retryAfterSeconds ? ` Retry after ${err.retryAfterSeconds} s.` : '';
      return `${parsed.error} (${parsed.errorKey}).${retry}`;
    }
  } catch { return null; }
  return null;
}

function rewritePermissionError(action: string): (err: unknown) => never {
  return (err) => {
    const named = err instanceof OrbotoApiError ? serverRefusal(err) : null;
    if (named) throw new Error(`${action}: ${named}`);
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

function provenance(f: PrimerFactRow): string {
  const parts: string[] = [];
  if (f.createdByName) parts.push(`by ${f.createdByName}${f.agentSessionLabel ? ` (${f.agentSessionLabel})` : ''}`);
  if (f.createdAt) parts.push(f.createdAt.slice(0, 10));
  if (f.evidence) parts.push(`evidence: ${f.evidence.replace(/\n/g, ' ').slice(0, 120)}`);
  return parts.join(', ');
}

function summariseFact(f: PrimerFactRow): string {
  const markers: string[] = [];
  if (f.verified) markers.push('pinned');
  if (f.source === 'imported') markers.push('imported');
  if (f.supersededById) markers.push('superseded');
  if (f.earlierVersions) markers.push(`${f.earlierVersions} earlier`);
  const tag = markers.length > 0 ? ` _(${markers.join(', ')})_` : '';
  const valuePreview = f.value.length > 120 || f.value.includes('\n')
    ? `${f.value.replace(/\n/g, ' ').slice(0, 120)}…`
    : f.value;
  const scope = f.projectId === null ? '[workspace]' : f.projectKey ? `[${f.projectKey}]` : '[project]';
  const line = provenance(f);
  return `- ${scope} **${f.category}/${f.key}**: ${valuePreview}${tag}${line ? `\n  ${line}` : ''}`;
}

function factSummary(f: PrimerFactRow) {
  return {
    id: f.id,
    scope: f.projectId === null ? 'workspace' : 'project',
    category: f.category,
    key: f.key,
    value: f.value,
    source: f.source,
    verified: f.verified,
    pinned: f.verified,
    evidence: f.evidence ?? null,
    createdByName: f.createdByName ?? null,
    agentSessionLabel: f.agentSessionLabel ?? null,
    earlierVersions: f.earlierVersions ?? 0,
    supersededById: f.supersededById,
    lastVerifiedAt: f.lastVerifiedAt,
  };
}

function writeResult(answer: WriteAnswer, label: string): CallToolResult {
  if (isLesson(answer)) {
    return {
      content: [{ type: 'text', text: answer.text }],
      structuredContent: {
        outcome: 'lesson',
        id: answer.fact.id,
        category: answer.fact.category,
        key: answer.fact.key,
        pinned: true,
        lesson: answer.lesson,
      },
    };
  }
  const row = answer;
  const warn = row.sizeWarning ? `\n⚠ ${row.value.length} chars, over the ${row.sizeWarning.limit}-char soft limit. ${row.sizeWarning.hint}` : '';
  const replaced = row.replaced ? `, replaces ${row.replaced.id.slice(0, 8)}; earlier versions: orboto_primer_fact_history ${row.id}` : '';
  return {
    content: [{
      type: 'text',
      text: `Live ${label}: ${row.category}/${row.key} (source: ${row.source}, id ${row.id.slice(0, 8)}${replaced}).${warn}`,
    }],
    structuredContent: {
      outcome: row.replaced ? 'replaced' : 'live',
      id: row.id,
      newId: row.id,
      category: row.category,
      key: row.key,
      source: row.source,
      verified: row.verified,
      pinned: row.verified,
      replaced: row.replaced?.id ?? null,
    },
  };
}

export const primerFactListToolConfig = {
  title: 'List primer facts',
  description:
    'List the structured project facts feeding the AI primer, each with author, session and evidence. Read them before adding an observation. Workspace facts are merged in unless includeWorkspace=false.',
  inputSchema: z.object({
    projectKey: z.string().min(1),
    category: PrimerFactCategoryEnum.optional().describe(
      'Category; omit for all.',
    ),
    source: PrimerFactSourceEnum.optional().describe(
      'manual, agent_observed (an agent) or imported.',
    ),
    verified: z.boolean().optional().describe(
      'true = pinned only.',
    ),
    includeWorkspace: z.boolean().default(true).describe(
      'Merge workspace-wide facts (default).',
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
      structuredContent: { count: rows.length, facts: rows.map(factSummary) },
    };
  };
}

export const primerFactAddToolConfig = {
  title: 'Record a primer fact',
  description:
    'Record a project fact with your evidence; it is live at once in every session primer. Use it for a version, convention, deployment quirk or architecture decision, CLAUDE.md / AGENTS.md conventions too (the primer rarely reads them). Workspace facts are person-written (403 workspace_needs_person). CLI: orboto primer-fact add <KEY> --category <c> --key <k> --value "<v>" --evidence "<how>".'
    + LIVE_CONTRACT
    + FACT_WRITING_CONTRACT,
  inputSchema: z.object({
    projectKey: z.string().min(1),
    category: PrimerFactCategoryEnum.describe(
      'non_functional: an NFR (key = area); glossary: a term and its definition.',
    ),
    key: z.string().min(1).max(120).describe(
      'Short id, lowercase-dashed, e.g. "node-version".',
    ),
    value: z.string().min(1).max(8000).describe(
      'Markdown, 1-3 sentences; name versions, paths, commands.',
    ),
    evidence: EvidenceParam,
    observed: z.boolean().default(false),
    allowOversize: z.boolean().optional().describe('After a 600-char block.'),
    oversizeReason: z.string().min(10).max(500).optional().describe(OVERSIZE_REASON_PARAM),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};

export function makePrimerFactAddHandler(client: OrbotoClient) {
  return async ({
    projectKey,
    category,
    key,
    value,
    evidence,
    observed,
    allowOversize,
    oversizeReason,
  }: {
    projectKey: string;
    category: (typeof PRIMER_FACT_CATEGORIES)[number];
    key: string;
    value: string;
    evidence?: string;
    observed?: boolean;
    allowOversize?: boolean;
    oversizeReason?: string;
  }): Promise<CallToolResult> => {
    const project = await resolveProjectByKey(client, projectKey);
    const body = {
      category,
      key,
      value,
      evidence,
      source: observed ? ('agent_observed' as const) : ('manual' as const),
      allowOversize,
      oversizeReason,
    };
    let answer: WriteAnswer;
    try {
      answer = await client.post<WriteAnswer>(`/projects/${project.id}/primer-facts`, body);
    } catch (err) {
      const blocked = sizeBlockResult(err, 'Primer fact add');
      if (blocked) return blocked;
      return rewritePermissionError('add primer fact')(err);
    }
    return writeResult(answer, `${project.key} primer fact`);
  };
}

export const primerFactUpdateToolConfig = {
  title: 'Update a primer fact',
  description:
    'Edit a fact in place. Use this when the value has changed (e.g. version bumped) or you are renaming the key. Bumps last_verified_at automatically when the value changes; pure renames leave it untouched. To replace a fact while preserving history, use orboto_primer_fact_supersede instead. A person edits in place: a bot account or an agent key gets 403 errors.primer_facts.update_needs_person and writes the corrected value with orboto_primer_fact_add, which replaces an unpinned fact and keeps its history.'
    + FACT_WRITING_CONTRACT,
  inputSchema: z.object({
    factId: z.string().min(1).describe('UUID from orboto_primer_fact_list.'),
    value: z.string().min(1).max(8000).optional().describe('New Markdown body.'),
    category: PrimerFactCategoryEnum.optional(),
    key: z.string().min(1).max(120).optional(),
    allowOversize: z.boolean().optional().describe('After a 600-char block.'),
    oversizeReason: z.string().min(10).max(500).optional().describe(OVERSIZE_REASON_PARAM),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
};

export function makePrimerFactUpdateHandler(client: OrbotoClient) {
  return async ({
    factId,
    value,
    category,
    key,
    allowOversize,
    oversizeReason,
  }: {
    factId: string;
    value?: string;
    category?: (typeof PRIMER_FACT_CATEGORIES)[number];
    key?: string;
    allowOversize?: boolean;
    oversizeReason?: string;
  }): Promise<CallToolResult> => {
    const body: Record<string, unknown> = {};
    if (value !== undefined) body.value = value;
    if (category !== undefined) body.category = category;
    if (key !== undefined) body.key = key;
    if (Object.keys(body).length === 0) {
      throw new Error('orboto_primer_fact_update needs at least one of value, category, key.');
    }
    if (allowOversize !== undefined) body.allowOversize = allowOversize;
    if (oversizeReason !== undefined) body.oversizeReason = oversizeReason;
    let row: PrimerFactRow;
    try {
      row = await client.patch<PrimerFactRow>(`/primer-facts/${factId}`, body);
    } catch (err) {
      const blocked = sizeBlockResult(err, 'Primer fact update');
      if (blocked) return blocked;
      return rewritePermissionError('update primer fact')(err);
    }

    const warn = row.sizeWarning ? `\n⚠ ${row.value.length} chars, over the ${row.sizeWarning.limit}-char soft limit. ${row.sizeWarning.hint}` : '';
    return {
      content: [{
        type: 'text',
        text: `Updated primer fact ${row.category}/${row.key} (id ${row.id.slice(0, 8)}).${warn}`,
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

export const primerFactSupersedeToolConfig = {
  title: 'Supersede a primer fact',
  description:
    'Replace a wrong fact by id instead of deleting it; the old one stays in orboto_primer_fact_history. Workspace facts are person-written (403); an already superseded fact answers 409 already_superseded. Same live, pinned and size rules as orboto_primer_fact_add.',
  inputSchema: z.object({
    oldFactId: z.string().min(1).describe('UUID of the replaced fact.'),
    category: PrimerFactCategoryEnum,
    key: z.string().min(1).max(120),
    value: z.string().min(1).max(8000).describe('Corrected Markdown body.'),
    evidence: EvidenceParam,
    allowOversize: z.boolean().optional().describe('After a 600-char block.'),
    oversizeReason: z.string().min(10).max(500).optional().describe(OVERSIZE_REASON_PARAM),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};

export function makePrimerFactSupersedeHandler(client: OrbotoClient) {
  return async ({
    oldFactId,
    category,
    key,
    value,
    evidence,
    allowOversize,
    oversizeReason,
  }: {
    oldFactId: string;
    category: (typeof PRIMER_FACT_CATEGORIES)[number];
    key: string;
    value: string;
    evidence?: string;
    allowOversize?: boolean;
    oversizeReason?: string;
  }): Promise<CallToolResult> => {
    let answer: WriteAnswer;
    try {
      answer = await client.post<WriteAnswer>(`/primer-facts/${oldFactId}/supersede`, { category, key, value, evidence, allowOversize, oversizeReason });
    } catch (err) {
      const blocked = sizeBlockResult(err, 'Primer fact supersede');
      if (blocked) return blocked;
      return rewritePermissionError('supersede primer fact')(err);
    }
    return writeResult(answer, 'superseding primer fact');
  };
}

export const primerFactHistoryToolConfig = {
  title: 'Primer fact history',
  description:
    'A fact and every version it replaced, newest first, with author, session and evidence. Project members only (else 404). CLI: orboto primer-fact history.',
  inputSchema: z.object({
    factId: z.string().min(1).describe('UUID of any version.'),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makePrimerFactHistoryHandler(client: OrbotoClient) {
  return async ({ factId }: { factId: string }): Promise<CallToolResult> => {
    const rows = await client
      .get<PrimerFactRow[]>(`/primer-facts/${factId}/history`)
      .catch(rewritePermissionError('read primer fact history'));
    return {
      content: [{ type: 'text', text: rows.length === 0 ? 'No versions.' : rows.map(summariseFact).join('\n') }],
      structuredContent: { count: rows.length, versions: rows.map(factSummary) },
    };
  };
}

async function pinCall(client: OrbotoClient, factId: string, verb: 'pin' | 'unpin'): Promise<CallToolResult> {
  const path = `/primer-facts/${factId}/pin`;
  const call = verb === 'unpin' ? client.delete<PrimerFactRow>(path) : client.post<PrimerFactRow>(path, {});
  const row = await call.catch(rewritePermissionError(`${verb} primer fact`));
  return {
    content: [{
      type: 'text',
      text: `${verb === 'unpin' ? 'Unpinned' : 'Pinned'} primer fact ${row.category}/${row.key} (id ${row.id.slice(0, 8)}).`,
    }],
    structuredContent: {
      id: row.id,
      pinned: row.verified,
      verified: row.verified,
      verifiedBy: row.verifiedBy,
      verifiedAt: row.verifiedAt,
    },
  };
}

export const primerFactVerifyToolConfig = {
  title: 'Pin or unpin a primer fact',
  description:
    'Pin a fact (pinned=false unpins); verify is the older name. An agent never replaces a pinned fact, its value becomes a wiki lesson. A person pins: a bot or agent key gets 403 errors.primer_facts.pin_needs_person. CLI: orboto primer-fact pin|unpin.',
  inputSchema: z.object({
    factId: z.string().min(1),
    pinned: z.boolean().default(true),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
};

export function makePrimerFactVerifyHandler(client: OrbotoClient) {
  return async ({ factId, pinned }: { factId: string; pinned?: boolean }): Promise<CallToolResult> =>
    pinCall(client, factId, pinned === false ? 'unpin' : 'pin');
}

export const primerFactDeleteToolConfig = {
  title: 'Delete a primer fact',
  description:
    'Hard-delete a fact. Prefer orboto_primer_fact_supersede when the fact is being replaced; only delete when the fact was wrong from the start or no longer relevant. Writes an audit-log entry; the row itself is gone (no soft-delete). A person deletes: a bot account or an agent key gets 403 errors.primer_facts.delete_needs_person (CLI: orboto primer-fact delete).',
  inputSchema: z.object({
    factId: z.string().min(1).describe('Fact UUID.'),
    reason: z.string().max(500).optional().describe(
      'Kept in the audit log.',
    ),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
};

export function makePrimerFactDeleteHandler(client: OrbotoClient) {
  return async ({ factId, reason }: { factId: string; reason?: string }): Promise<CallToolResult> => {
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

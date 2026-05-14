/**
 * ORB-244 Phase B — milestone tools, expanded in ORB-799 with CRUD.
 *
 * `orboto_list_milestones` and `orboto_get_milestone` share this file
 * because they're cheap neighbours (same API root, same resolution
 * chain). The `get` tool also pulls the `/progress` endpoint so the
 * model sees ticket-count breakdowns alongside the metadata.
 *
 * ORB-799 added the write half of the surface to close wrapper-parity:
 *
 *   - orboto_create_milestone — mirrors `orboto.mjs create-milestone`,
 *     including the nullable-but-required `startDate`/`endDate` quirk
 *     the bare POST chokes on (the API's Zod schema requires the keys
 *     to be present even when their value is null).
 *   - orboto_close_milestone — close + optional archive. Resolves the
 *     milestone by name OR UUID against the includeClosed=true list so
 *     re-closing an already-closed milestone is idempotent.
 *   - orboto_update_milestone — patch name / dates / private flag.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OrbotoApiError, type OrbotoClient } from '../orboto-client.js';
import { resolveProjectByKey } from './shared.js';

const UUID_RE = /^[0-9a-f-]{36}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Matches MilestoneSchema in @orboto/shared-schema. `description` is
 *  intentionally absent there — milestones hold name + dates + status
 *  only, no free-text body. */
interface MilestoneRow {
  id: string;
  projectId: string;
  name: string;
  status: string;
  startDate: string | null;
  endDate: string | null;
  isPrivate: boolean;
}

/** `/progress` response — one row per status, plus total count.
 *  Keys in `byStatus` are the legacy status enum (TODO / IN_PROGRESS
 *  / IN_REVIEW / DONE / WONT_FIX). */
interface MilestoneProgress {
  total: number;
  byStatus: Record<string, number>;
}

// ---------------------------------------------------------------------------
// orboto_list_milestones
// ---------------------------------------------------------------------------

export const listMilestonesToolConfig = {
  title: 'List milestones',
  description: 'List milestones in a project, newest first.',
  inputSchema: z.object({
    projectKey: z.string().min(1).describe('Project key (e.g. "ACME").'),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeListMilestonesHandler(client: OrbotoClient) {
  return async ({ projectKey }: { projectKey: string }): Promise<CallToolResult> => {
    const project = await resolveProjectByKey(client, projectKey);
    const milestones = await client.get<MilestoneRow[]>(`/projects/${project.id}/milestones`);
    const text = milestones.length === 0
      ? `No milestones in project ${project.key}.`
      : milestones.map((m) => {
        const range = [m.startDate, m.endDate].filter(Boolean).join(' → ') || 'no dates';
        return `- ${m.name} [${m.status}] (${range})`;
      }).join('\n');
    return {
      content: [{ type: 'text', text }],
      structuredContent: {
        project: { key: project.key },
        milestones: milestones.map((m) => ({
          name: m.name,
          status: m.status,
          startDate: m.startDate,
          endDate: m.endDate,
          isPrivate: m.isPrivate,
        })),
      },
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_get_milestone
// ---------------------------------------------------------------------------

export const getMilestoneToolConfig = {
  title: 'Get milestone details',
  description:
    'Return milestone metadata plus ticket-count breakdown by status (to do / in progress / done / …).',
  inputSchema: z.object({
    projectKey: z.string().min(1).describe('Project key (e.g. "ACME").'),
    milestone: z.string().min(1).describe('Milestone name (case-sensitive).'),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeGetMilestoneHandler(client: OrbotoClient) {
  return async ({ projectKey, milestone: milestoneName }: {
    projectKey: string; milestone: string;
  }): Promise<CallToolResult> => {
    const project = await resolveProjectByKey(client, projectKey);
    const milestones = await client.get<MilestoneRow[]>(`/projects/${project.id}/milestones`);
    const m = milestones.find((x) => x.name === milestoneName);
    if (!m) throw new Error(`Milestone "${milestoneName}" not found in project ${project.key}.`);

    // Progress comes from a separate endpoint; tolerate 404 gracefully
    // in case a future API rename drops it so the tool still returns
    // the metadata half.
    const progress = await client.get<MilestoneProgress>(
      `/projects/${project.id}/milestones/${m.id}/progress`,
    ).catch((err) => {
      if (err instanceof OrbotoApiError && err.status === 404) return null;
      throw err;
    });

    const lines = [
      `${m.name} [${m.status}]`,
      `Dates: ${m.startDate ?? '(no start)'} → ${m.endDate ?? '(no end)'}`,
      m.isPrivate ? 'Private: yes' : null,
    ].filter((l): l is string => l !== null);

    if (progress) {
      const done = progress.byStatus.DONE ?? 0;
      const inProgress = progress.byStatus.IN_PROGRESS ?? 0;
      const inReview = progress.byStatus.IN_REVIEW ?? 0;
      const todo = progress.byStatus.TODO ?? 0;
      const wontFix = progress.byStatus.WONT_FIX ?? 0;
      const percent = progress.total > 0 ? Math.round((done / progress.total) * 100) : 0;
      lines.push(
        '',
        `Progress: ${percent}% done (${done}/${progress.total})`,
        `  to do: ${todo} · in progress: ${inProgress} · in review: ${inReview} · won't fix: ${wontFix}`,
      );
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: {
        milestone: {
          name: m.name,
          status: m.status,
          startDate: m.startDate,
          endDate: m.endDate,
          isPrivate: m.isPrivate,
        },
        progress,
      },
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_create_milestone — ORB-799
// ---------------------------------------------------------------------------

export const createMilestoneToolConfig = {
  title: 'Create a milestone',
  description:
    'Create a milestone in a project. `startDate` + `endDate` are nullable but both keys are sent on the wire (the API\'s Zod schema requires their presence even when null) — this tool handles that quirk so the common "just a name" case works. The caller must have `milestone:create`.',
  inputSchema: z.object({
    projectKey: z.string().min(1).describe('Project key (e.g. "ACME").'),
    name: z.string().min(1).describe('Milestone name (unique within the project).'),
    startDate: z.string().regex(DATE_RE).nullable().optional().describe('YYYY-MM-DD or null.'),
    endDate: z.string().regex(DATE_RE).nullable().optional().describe('YYYY-MM-DD or null.'),
    isPrivate: z.boolean().optional().describe('Restrict to project members only. Default: false.'),
  }).shape,
};

export function makeCreateMilestoneHandler(client: OrbotoClient) {
  return async ({ projectKey, name, startDate, endDate, isPrivate }: {
    projectKey: string;
    name: string;
    startDate?: string | null;
    endDate?: string | null;
    isPrivate?: boolean;
  }): Promise<CallToolResult> => {
    const project = await resolveProjectByKey(client, projectKey);
    const body = {
      name,
      // Send both keys explicitly with null fallbacks — the bare POST
      // returns 400 "body/startDate Required" otherwise.
      startDate: startDate ?? null,
      endDate: endDate ?? null,
      isPrivate: isPrivate ?? false,
    };
    const created = await client.post<MilestoneRow>(`/projects/${project.id}/milestones`, body);
    return {
      content: [{
        type: 'text',
        text: `Created milestone "${created.name}" in ${project.key} (status: ${created.status ?? 'active'}).`,
      }],
      structuredContent: {
        id: created.id,
        name: created.name,
        status: created.status,
        startDate: created.startDate,
        endDate: created.endDate,
        isPrivate: created.isPrivate,
        projectKey: project.key,
      },
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_close_milestone — ORB-799
// ---------------------------------------------------------------------------

/** Resolve a milestone by name or UUID against the includeClosed list,
 *  so closing an already-completed milestone (re-close) or archiving a
 *  completed milestone both work without the caller pre-fetching. */
async function resolveMilestoneByNameOrId(
  client: OrbotoClient,
  projectId: string,
  nameOrId: string,
): Promise<MilestoneRow> {
  const all = await client.get<MilestoneRow[]>(
    `/projects/${projectId}/milestones?includeClosed=true`,
  );
  const m = UUID_RE.test(nameOrId)
    ? all.find((x) => x.id === nameOrId)
    : all.find((x) => x.name === nameOrId);
  if (!m) {
    throw new Error(`Milestone "${nameOrId}" not found in the project (including closed/archived).`);
  }
  return m;
}

export const closeMilestoneToolConfig = {
  title: 'Close (or archive) a milestone',
  description:
    'Move a milestone to `completed` (default) or `archived` (pass `archive=true`). Looks up the milestone by name or UUID, including already-closed ones, so re-closing is idempotent. Useful when a release ships and you want to lock the milestone but keep the tickets on it.',
  inputSchema: z.object({
    projectKey: z.string().min(1),
    milestone: z.string().min(1).describe('Milestone name or UUID.'),
    archive: z.boolean().optional().describe('Set true to archive (status=archived) instead of merely completing.'),
  }).shape,
};

export function makeCloseMilestoneHandler(client: OrbotoClient) {
  return async ({ projectKey, milestone, archive }: {
    projectKey: string; milestone: string; archive?: boolean;
  }): Promise<CallToolResult> => {
    const project = await resolveProjectByKey(client, projectKey);
    const found = await resolveMilestoneByNameOrId(client, project.id, milestone);
    const target = archive ? 'archived' : 'completed';
    const updated = await client.patch<MilestoneRow>(
      `/projects/${project.id}/milestones/${found.id}`,
      { status: target },
    );
    return {
      content: [{
        type: 'text',
        text: `Milestone "${updated.name}" → ${updated.status}.`,
      }],
      structuredContent: {
        id: updated.id,
        name: updated.name,
        status: updated.status,
        projectKey: project.key,
      },
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_update_milestone — ORB-799
// ---------------------------------------------------------------------------

export const updateMilestoneToolConfig = {
  title: 'Update a milestone\'s fields',
  description:
    'Patch a milestone (`name`, `startDate`, `endDate`, `isPrivate`). At least one field must be set. Use `orboto_close_milestone` to flip status to completed/archived — this tool intentionally does NOT touch the status field so closing remains a clear semantic operation.',
  inputSchema: z.object({
    projectKey: z.string().min(1),
    milestone: z.string().min(1).describe('Milestone name or UUID to identify the target.'),
    patch: z.object({
      name: z.string().min(1).optional(),
      startDate: z.string().regex(DATE_RE).nullable().optional(),
      endDate: z.string().regex(DATE_RE).nullable().optional(),
      isPrivate: z.boolean().optional(),
    }).refine((p) => Object.keys(p).length > 0, { message: 'patch must include at least one field' }),
  }).shape,
};

export function makeUpdateMilestoneHandler(client: OrbotoClient) {
  return async ({ projectKey, milestone, patch }: {
    projectKey: string;
    milestone: string;
    patch: { name?: string; startDate?: string | null; endDate?: string | null; isPrivate?: boolean };
  }): Promise<CallToolResult> => {
    const project = await resolveProjectByKey(client, projectKey);
    const found = await resolveMilestoneByNameOrId(client, project.id, milestone);
    const updated = await client.patch<MilestoneRow>(
      `/projects/${project.id}/milestones/${found.id}`,
      patch,
    );
    return {
      content: [{
        type: 'text',
        text: `Updated milestone "${updated.name}" (${Object.keys(patch).join(', ')}).`,
      }],
      structuredContent: {
        id: updated.id,
        name: updated.name,
        status: updated.status,
        startDate: updated.startDate,
        endDate: updated.endDate,
        isPrivate: updated.isPrivate,
        projectKey: project.key,
      },
    };
  };
}

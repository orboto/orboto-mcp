/**
 * ORB-244 Phase B — milestone tools.
 *
 * `orboto_list_milestones` and `orboto_get_milestone` share this file
 * because they're cheap neighbours (same API root, same resolution
 * chain). The `get` tool also pulls the `/progress` endpoint so the
 * model sees ticket-count breakdowns alongside the metadata.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OrbotoApiError, type OrbotoClient } from '../orboto-client.js';
import { resolveProjectByKey } from './shared.js';

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

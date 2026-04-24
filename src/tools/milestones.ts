/**
 * ORB-244 Phase B — milestone tools.
 *
 * `orbit_list_milestones` and `orbit_get_milestone` share this file
 * because they're cheap neighbours (same API root, same resolution
 * chain). The `get` tool also pulls the `/progress` endpoint so the
 * model sees burndown numbers without an extra call.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OrbitApiError, type OrbitClient } from '../orbit-client.js';
import { resolveProjectByKey } from './shared.js';

interface MilestoneRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  startDate: string | null;
  endDate: string | null;
  isPrivate: boolean;
}

interface MilestoneProgress {
  total: number;
  done: number;
  inProgress: number;
  todo: number;
  percentDone: number;
  loggedMinutes: number;
  estimatedMinutes: number;
}

// ---------------------------------------------------------------------------
// orbit_list_milestones
// ---------------------------------------------------------------------------

export const listMilestonesToolConfig = {
  title: 'List milestones',
  description: 'List milestones in a project, newest first.',
  inputSchema: z.object({
    projectKey: z.string().min(1).describe('Project key (e.g. "ACME").'),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeListMilestonesHandler(client: OrbitClient) {
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
// orbit_get_milestone
// ---------------------------------------------------------------------------

export const getMilestoneToolConfig = {
  title: 'Get milestone details',
  description:
    'Return milestone metadata plus burndown (% done, ticket counts, logged vs estimated minutes).',
  inputSchema: z.object({
    projectKey: z.string().min(1).describe('Project key (e.g. "ACME").'),
    milestone: z.string().min(1).describe('Milestone name (case-sensitive).'),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeGetMilestoneHandler(client: OrbitClient) {
  return async ({ projectKey, milestone: milestoneName }: {
    projectKey: string; milestone: string;
  }): Promise<CallToolResult> => {
    const project = await resolveProjectByKey(client, projectKey);
    const milestones = await client.get<MilestoneRow[]>(`/projects/${project.id}/milestones`);
    const m = milestones.find((x) => x.name === milestoneName);
    if (!m) throw new Error(`Milestone "${milestoneName}" not found in project ${project.key}.`);

    // Burndown comes from a separate endpoint; tolerate 404 gracefully
    // in case a future API rename drops it so the tool still returns
    // the metadata half.
    const progress = await client.get<MilestoneProgress>(
      `/projects/${project.id}/milestones/${m.id}/progress`,
    ).catch((err) => {
      if (err instanceof OrbitApiError && err.status === 404) return null;
      throw err;
    });

    const lines = [
      `${m.name} [${m.status}]`,
      m.description ? `Description: ${m.description}` : null,
      `Dates: ${m.startDate ?? '(no start)'} → ${m.endDate ?? '(no end)'}`,
      m.isPrivate ? 'Private: yes' : null,
    ].filter((l): l is string => l !== null);

    if (progress) {
      lines.push(
        '',
        `Progress: ${progress.percentDone}% done`,
        `Tickets: ${progress.done}/${progress.total} done · ${progress.inProgress} in progress · ${progress.todo} to do`,
        `Time: ${progress.loggedMinutes} logged / ${progress.estimatedMinutes} estimated minutes`,
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
          description: m.description,
          isPrivate: m.isPrivate,
        },
        progress,
      },
    };
  };
}

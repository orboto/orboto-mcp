/**
 * ORB-1032 — `orboto_analytics`. One multiplexed read tool over the project
 * analytics suite + Earned Value, since AI is a main feature. Inherits the
 * ORB-1031 permission gate: the API returns 403 for reports the caller
 * can't see (budget / earned-value money mode need budget:view).
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OrbotoApiError, type OrbotoClient } from '../orboto-client.js';
import { resolveProjectByKey } from './shared.js';

const REPORTS = ['overview', 'burndown', 'velocity', 'cycle-time', 'workload', 'budget', 'earned-value', 'estimation-accuracy', 'flow-time'] as const;
type Report = (typeof REPORTS)[number];

export const analyticsToolConfig = {
  title: 'Project analytics',
  description:
    "Read a project's analytics or Earned Value. `report`: overview, burndown, velocity, cycle-time, workload, budget, earned-value, estimation-accuracy, or flow-time. `flow-time` shows lead vs cycle vs effort side-by-side as median + p75/p90 (NOT just mean - the legacy cycle-time report's mean hid a 0-day median), split by agent/human cohort, size and type. `estimation-accuracy` is the estimate-vs-actual calibration (multiplier + confidence per agents/humans/combined; degrades through tracked-effort -> cycle-time -> lead-time and reports insufficient rather than inventing a number) — reach for estimation-accuracy + flow-time for grounded effort/duration answers instead of free-reasoning from cycle time. `milestone` scopes burndown + earned-value; `mode` (hours|money) applies to earned-value. Requires `analytics:view`; `budget` and the earned-value MONEY mode additionally require `budget:view` (you'll get a permission error otherwise).",
  inputSchema: z.object({
    projectKey: z.string().min(1).describe('Project key (e.g. "ORB").'),
    report: z.enum(REPORTS).describe('Which report to return.'),
    milestone: z.string().optional().describe('Milestone name (burndown / earned-value).'),
    mode: z.enum(['hours', 'money']).optional().describe('earned-value unit (default hours). Money needs budget:view.'),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeAnalyticsHandler(client: OrbotoClient) {
  return async (input: { projectKey: string; report: Report; milestone?: string; mode?: 'hours' | 'money' }): Promise<CallToolResult> => {
    const project = await resolveProjectByKey(client, input.projectKey);

    let milestoneId: string | undefined;
    if (input.milestone && (input.report === 'burndown' || input.report === 'earned-value')) {
      const milestones = await client.get<Array<{ id: string; name: string }>>(`/projects/${project.id}/milestones`);
      const m = milestones.find((x) => x.name === input.milestone);
      if (!m) throw new Error(`Milestone "${input.milestone}" not found in project ${project.key}.`);
      milestoneId = m.id;
    }

    const path = (() => {
      switch (input.report) {
        case 'earned-value': {
          const qs = new URLSearchParams();
          if (milestoneId) qs.set('milestoneId', milestoneId);
          if (input.mode) qs.set('mode', input.mode);
          return `/projects/${project.id}/earned-value${qs.toString() ? `?${qs}` : ''}`;
        }
        case 'burndown':
          return `/projects/${project.id}/analytics/burndown${milestoneId ? `?milestoneId=${milestoneId}` : ''}`;
        default:
          return `/projects/${project.id}/analytics/${input.report}`;
      }
    })();

    let data: unknown;
    try {
      data = await client.get<unknown>(path);
    } catch (err) {
      if (err instanceof OrbotoApiError && err.status === 403) {
        const need = input.report === 'budget' || (input.report === 'earned-value' && input.mode === 'money') ? 'budget:view' : 'analytics:view';
        return {
          content: [{ type: 'text', text: `Not permitted: the ${input.report} report needs the ${need} permission on ${project.key}.` }],
          structuredContent: { error: 'forbidden', report: input.report, requiredPermission: need },
        };
      }
      throw err;
    }

    return {
      content: [{ type: 'text', text: `${input.report} for ${project.key}:\n${JSON.stringify(data, null, 2)}` }],
      structuredContent: { report: input.report, projectKey: project.key, data },
    };
  };
}

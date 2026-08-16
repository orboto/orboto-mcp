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
import { resolveMilestoneByNameOrId } from './milestones.js';

const REPORTS = ['overview', 'burndown', 'velocity', 'cycle-time', 'workload', 'budget', 'collaboration', 'earned-value', 'estimation-accuracy', 'flow-time', 'flow-metrics', 'forecast', 'bottleneck'] as const;
type Report = (typeof REPORTS)[number];

export const analyticsToolConfig = {
  title: 'Project analytics',
  description:
    "Read a project's analytics or Earned Value. `report`: overview, burndown, velocity, cycle-time, workload, budget, collaboration, earned-value, estimation-accuracy, flow-time, flow-metrics, forecast, or bottleneck. `collaboration` classifies tickets human-only / agent-only / mixed from the agent-work stamps (time entries, comments, activities), with agent share of effort per project / milestone / member and a weekly trend - use it for 'who works with agents and what comes out of it' questions; `milestone` scopes it. `bottleneck` shows which status clogs the flow (longest-dwell status + trend), delivery predictability (lead/cycle variance), and the worst-aging open tickets with assignee. `forecast` is a Monte-Carlo delivery forecast (probabilistic 'done by X' date with p50/p85/p95 bands from historical throughput) - reach for it on 'when will this be done / how long for N tickets' questions instead of guessing from cycle time; `milestone` scopes its remaining set. `flow-metrics` gives Kanban flow: current WIP (leaf tickets only - `epicWip`/`epicWipByCategory` report epics separately, `excludedEpicsCount` says how many), weekly throughput, flow efficiency (active vs queue time), aging WIP, and a cumulative flow diagram. `flow-time` shows lead vs cycle vs effort side-by-side as median + p75/p90 (NOT just mean - the legacy cycle-time report's mean hid a 0-day median); sub-day medians round to 0 in the Days fields, so also check the parallel `leadMinutes`/`cycleMinutes` fields for fast-moving cohorts. `estimation-accuracy` is the estimate-vs-actual calibration (multiplier + confidence; degrades through tracked-effort -> cycle-time -> lead-time and reports insufficient rather than inventing a number) - reach for estimation-accuracy + flow-time + forecast for grounded effort/duration answers instead of free-reasoning from cycle time. For `bottleneck`/`flow-time`/`flow-metrics`/`estimation-accuracy`, prefer the `byWorkOrigin`/`cohortsByWorkOrigin`/`predictabilityByWorkOrigin` fields (agent/human/mixed, derived from WHO actually did the work) over the legacy `byCohort`/`cohorts`/`predictability` fields (agents/humans/combined, derived from account type only) - an agent operating through a human account reads correctly under workOrigin but not under accountType, so the two can disagree on the same ticket set. `milestone` scopes burndown + earned-value + forecast; `mode` (hours|money) applies to earned-value. Requires `analytics:view`; `budget` and the earned-value MONEY mode additionally require `budget:view` (you'll get a permission error otherwise).",
  inputSchema: z.object({
    projectKey: z.string().min(1).describe('Project key (e.g. "ORB").'),
    report: z.enum(REPORTS).describe('Which report to return.'),
    milestone: z.string().optional().describe('Milestone name (burndown / earned-value / forecast / collaboration).'),
    mode: z.enum(['hours', 'money']).optional().describe('earned-value unit (default hours). Money needs budget:view.'),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeAnalyticsHandler(client: OrbotoClient) {
  return async (input: { projectKey: string; report: Report; milestone?: string; mode?: 'hours' | 'money' }): Promise<CallToolResult> => {
    const project = await resolveProjectByKey(client, input.projectKey);

    let milestoneId: string | undefined;
    if (input.milestone && (input.report === 'burndown' || input.report === 'earned-value' || input.report === 'forecast' || input.report === 'collaboration')) {
      // ORB-1696 - shared resolver: key (ORB-M3), name or UUID, ambiguous
      // name -> explicit error. Matches create_ticket/set_milestone/OQL.
      const m = await resolveMilestoneByNameOrId(client, project.id, input.milestone);
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
        case 'forecast':
          return `/projects/${project.id}/analytics/forecast${milestoneId ? `?milestoneId=${milestoneId}` : ''}`;
        case 'collaboration':
          return `/projects/${project.id}/analytics/collaboration${milestoneId ? `?milestoneId=${milestoneId}` : ''}`;
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

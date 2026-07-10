/**
 * ORB-1028 — `orboto_critical_path`. Phase 4 agent surface for the CPM
 * endpoint shipped in Phase 1. Wraps GET /projects/:id/critical-path,
 * resolving the project key (and optional milestone name) for the caller.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';
import { resolveProjectByKey } from './shared.js';

interface CpTicket {
  ticketKey: string | null;
  title: string;
  durationDays: number;
  totalFloat: number;
  isCritical: boolean;
  deadlineCritical?: boolean;
  bindingConstraint?: 'project_end' | 'successors' | 'due_date';
}
interface CpDeadlineRisk {
  ticketKey: string | null;
  constrainingTicketKey: string | null;
  dueDate: string | null;
  shortfallDays: number;
}
interface CpResult {
  tickets: CpTicket[];
  criticalPath: string[];
  deadlineRisks?: CpDeadlineRisk[];
  projectDurationDays: number;
  cycle: { ticketKeys: string[] } | null;
}

export const criticalPathToolConfig = {
  title: 'Critical path (CPM)',
  description:
    "Compute a project's (or one milestone's) critical path via the Critical Path Method: the longest finish-to-start dependency chain that sets the delivery date, plus each ticket's slack (total float, in working days). Durations come from `estimatedTimeMinutes` (8h/day, floored at 1 day). Deadline-aware (ORB-1459): a ticket's due date (or its milestone's, when tighter) seeds the backward pass, so total float can go NEGATIVE when a chain cannot meet its deadline - those tickets are reported under `deadlineRisks` with the shortfall in working days. Returns the critical path (ticket keys in order), the total working-day duration, per-ticket float, and the deadline risks. A dependency cycle returns the tangled ticket keys instead of a path. By default tickets in completed/archived milestones are excluded (matching the board); set includeClosedMilestones to include them.",
  inputSchema: z.object({
    projectKey: z.string().min(1).describe('Project key (e.g. "ACME").'),
    milestone: z.string().optional().describe('Milestone name to scope to. Omit for the whole project.'),
    includeClosedMilestones: z.boolean().optional().describe('Include tickets from completed/archived milestones. Default false (hidden, matching the board).'),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeCriticalPathHandler(client: OrbotoClient) {
  return async (input: { projectKey: string; milestone?: string; includeClosedMilestones?: boolean }): Promise<CallToolResult> => {
    const project = await resolveProjectByKey(client, input.projectKey);
    const params = new URLSearchParams();
    if (input.milestone) {
      const milestones = await client.get<Array<{ id: string; name: string }>>(`/projects/${project.id}/milestones`);
      const m = milestones.find((x) => x.name === input.milestone);
      if (!m) throw new Error(`Milestone "${input.milestone}" not found in project ${project.key}.`);
      params.set('milestoneId', m.id);
    }
    if (input.includeClosedMilestones) params.set('includeClosedMilestones', 'true');
    const qs = params.toString();
    const url = `/projects/${project.id}/critical-path${qs ? `?${qs}` : ''}`;
    const res = await client.get<CpResult>(url);

    if (res.cycle) {
      return {
        content: [{ type: 'text', text: `Dependency cycle — the critical path is undefined until it's broken. Tickets involved: ${res.cycle.ticketKeys.join(', ')}` }],
        structuredContent: { cycle: res.cycle, criticalPath: [], projectDurationDays: 0, tickets: [] },
      };
    }

    const path = res.criticalPath.length ? res.criticalPath.join(' -> ') : '(none)';
    const slack = res.tickets
      .filter((t) => !t.isCritical && t.totalFloat > 0)
      .sort((a, b) => a.totalFloat - b.totalFloat)
      .map((t) => `  ${t.ticketKey}: ${t.totalFloat}d slack`)
      .join('\n');
    // ORB-1459 - surface tickets whose deadline can't be met (negative float).
    const risks = (res.deadlineRisks ?? [])
      .map((r) => {
        const via = r.constrainingTicketKey && r.constrainingTicketKey !== r.ticketKey
          ? ` (via ${r.constrainingTicketKey}${r.dueDate ? ` due ${r.dueDate}` : ''})`
          : r.dueDate ? ` (due ${r.dueDate})` : '';
        return `  ${r.ticketKey}: ${r.shortfallDays}d short${via}`;
      })
      .join('\n');
    const text =
      `Critical path (${res.projectDurationDays} working day${res.projectDurationDays === 1 ? '' : 's'}): ${path}` +
      (slack ? `\nSlack on non-critical tickets:\n${slack}` : '\nAll in-scope tickets are on the critical path.') +
      (risks ? `\nDEADLINE RISKS (negative float - cannot meet the deadline):\n${risks}` : '');

    return {
      content: [{ type: 'text', text }],
      structuredContent: {
        criticalPath: res.criticalPath,
        projectDurationDays: res.projectDurationDays,
        tickets: res.tickets.map((t) => ({
          ticketKey: t.ticketKey,
          isCritical: t.isCritical,
          deadlineCritical: t.deadlineCritical ?? false,
          bindingConstraint: t.bindingConstraint ?? 'project_end',
          totalFloat: t.totalFloat,
          durationDays: t.durationDays,
        })),
        deadlineRisks: res.deadlineRisks ?? [],
        cycle: null,
      },
    };
  };
}

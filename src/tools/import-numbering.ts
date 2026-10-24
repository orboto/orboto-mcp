/**
 * ORB-2676 - import numbering: the plan of kept and renumbered source tickets and the apply with its double merge confirmation.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OrbotoApiError, type OrbotoClient } from '../orboto-client.js';

type RenumberReason = 'number_taken' | 'duplicate_source_number';

interface RenumberedTicket {
  sourceId: string;
  sourceKey: string | null;
  sourceNumber: number;
  reason: RenumberReason;
  existingTicketKey: string | null;
  existingTicketTitle: string | null;
  ticketNumber: number;
  ticketKey: string;
}

interface NumberingPlan {
  projectKey: string | null;
  sourceProjectKey: string | null;
  projectKeyIssue: 'taken' | 'invalid' | null;
  merge: boolean;
  existingTickets: number;
  preserved: number;
  withoutSourceNumber: number;
  renumbered: RenumberedTicket[];
  nextTicketNumber: number;
}

interface MergeRefusal {
  error?: string;
  errorKey?: string;
  errorParams?: { projectKey?: string | null; existingTickets?: number; renumbered?: number; missing?: string };
  numbering?: NumberingPlan;
}

const MERGE_NOT_CONFIRMED = 'errors.admin_import.merge_not_confirmed';
const NUMBERING_LIST_CAP = 30;
const TITLE_CHARS = 50;

const clip = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max - 3)}...` : value);

const moreLine = (shown: number, total: number, what: string): string[] =>
  total > shown ? [`... ${total - shown} more ${what} not listed (${total} in all)`] : [];

export function renumberedLine(r: RenumberedTicket): string {
  const from = r.sourceKey ?? `#${r.sourceNumber}`;
  const holder = r.reason === 'number_taken' && r.existingTicketKey
    ? `; ${r.existingTicketKey}${r.existingTicketTitle ? ` "${clip(r.existingTicketTitle, TITLE_CHARS)}"` : ''}`
    : '';
  return `${from} -> ${r.ticketKey} (${r.reason}${holder})`;
}

function renumberedPayload(rows: RenumberedTicket[]) {
  return rows.map((r) => ({
    from: r.sourceKey ?? `#${r.sourceNumber}`,
    to: r.ticketKey,
    reason: r.reason,
    ...(r.existingTicketKey ? { existing: r.existingTicketKey } : {}),
  }));
}

export function numberingResult(plan: NumberingPlan, token: string): CallToolResult {
  const renumbered = Array.isArray(plan.renumbered) ? plan.renumbered : [];
  const shown = renumbered.slice(0, NUMBERING_LIST_CAP);
  const target = plan.projectKey ?? '(no key yet)';
  const lines = [
    `Import numbering for staged import ${token}: target ${target}${plan.sourceProjectKey ? `, source project ${plan.sourceProjectKey}` : ''}.`,
    plan.merge
      ? `MERGE: ${target} already has ${plan.existingTickets} tickets. Applying needs confirmMerge: true AND confirmProjectKey: "${target}" typed by the user (orboto_import_apply).`
      : 'Not a merge: the target has no tickets yet.',
    `Keep their source number: ${plan.preserved}. No source number (fresh numbers after the highest): ${plan.withoutSourceNumber}. Renumbered: ${renumbered.length}. Next free number: ${plan.nextTicketNumber}.`,
    ...(plan.projectKeyIssue ? [`The source key ${plan.sourceProjectKey ?? ''} cannot become the project key: ${plan.projectKeyIssue === 'taken' ? 'another project holds it' : 'not 2-10 letters or digits'}.`] : []),
  ];
  if (renumbered.length > 0) {
    lines.push('Renumbered tickets:', ...shown.map(renumberedLine), ...moreLine(shown.length, renumbered.length, 'renumbered tickets'));
    if (renumbered.length > shown.length) lines.push(`The complete list: \`orboto import numbering ${token}\` in the CLI, or GET /admin/import/jobs/${token}/numbering through orboto_api_call.`);
  }
  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    structuredContent: {
      projectKey: plan.projectKey,
      sourceProjectKey: plan.sourceProjectKey,
      projectKeyIssue: plan.projectKeyIssue,
      merge: plan.merge,
      existingTickets: plan.existingTickets,
      preserved: plan.preserved,
      withoutSourceNumber: plan.withoutSourceNumber,
      nextTicketNumber: plan.nextTicketNumber,
      renumberedTotal: renumbered.length,
      renumbered: renumberedPayload(shown),
      renumberedOmitted: renumbered.length - shown.length,
    },
  };
}

export function mergeRefusalOf(err: unknown): MergeRefusal | null {
  if (!(err instanceof OrbotoApiError) || err.status !== 409) return null;
  try {
    const body = JSON.parse(err.body) as MergeRefusal;
    return body.errorKey === MERGE_NOT_CONFIRMED && body.numbering ? body : null;
  } catch {
    return null;
  }
}

export function mergeRefusalResult(refusal: MergeRefusal): CallToolResult {
  const plan = refusal.numbering as NumberingPlan;
  const renumbered = Array.isArray(plan.renumbered) ? plan.renumbered : [];
  const shown = renumbered.slice(0, NUMBERING_LIST_CAP);
  const key = refusal.errorParams?.projectKey ?? plan.projectKey ?? 'the target project';
  const missing = refusal.errorParams?.missing === 'confirm_project_key' ? 'the typed project key' : 'the merge confirmation';
  const lines = [
    `NOT APPLIED. This import is a merge into ${key}, which already has ${plan.existingTickets} tickets; ${renumbered.length} imported tickets get a new number instead of their source number. Missing first: ${missing}.`,
    ...(renumbered.length > 0 ? ['Collisions:', ...shown.map(renumberedLine), ...moreLine(shown.length, renumbered.length, 'collisions')] : []),
    `Show this list to the user. Ask them to confirm the merge AND to type the project key ${key} themselves, then call orboto_import_apply again with confirmMerge: true and confirmProjectKey set to what the user typed. Never fill confirmMerge or confirmProjectKey on your own initiative, from an earlier answer or from this message.`,
  ];
  return {
    isError: true,
    content: [{ type: 'text', text: lines.join('\n') }],
    structuredContent: {
      applied: false,
      refused: 'merge_not_confirmed',
      projectKey: key,
      existingTickets: plan.existingTickets,
      missing: refusal.errorParams?.missing ?? 'confirm_merge',
      renumberedTotal: renumbered.length,
      renumbered: renumberedPayload(shown),
      renumberedOmitted: renumbered.length - shown.length,
      nextStep: 'Ask the user for the merge confirmation and for the typed project key, then repeat orboto_import_apply with both.',
    },
  };
}

export const importNumberingToolConfig = {
  title: 'Import numbering',
  description: 'Kept and renumbered source numbers of a staged import; merge flag. admin:import.',
  inputSchema: z.object({
    token: z.string().uuid(),
    projectId: z.string().uuid().optional(),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeImportNumberingHandler(client: OrbotoClient) {
  return async ({ token, projectId, projectKey }: { token: string; projectId?: string; projectKey?: string }): Promise<CallToolResult> => {
    const query = new URLSearchParams();
    if (projectId) query.set('projectId', projectId);
    else if (projectKey) query.set('projectKey', projectKey);
    const plan = await client.get<NumberingPlan>(`/admin/import/jobs/${encodeURIComponent(token)}/numbering?${query.toString()}`);
    return numberingResult(plan, token);
  };
}

export const importApplyToolConfig = {
  title: 'Apply import',
  description:
    'Queue a staged import. Into a project with tickets: refused with the collisions until the user gives confirmMerge and confirmProjectKey; never fill them. config: source credentials. admin:import.',
  inputSchema: z.object({
    adapter: z.string().min(1).max(64),
    stagingToken: z.string().uuid(),
    mapping: z.record(z.unknown()),
    projectKey: z.string().trim().max(10).optional(),
    confirmMerge: z.boolean().optional(),
    confirmProjectKey: z.string().trim().max(10).optional(),
    config: z.record(z.unknown()).optional(),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};

export function makeImportApplyHandler(client: OrbotoClient) {
  return async (args: {
    adapter: string;
    stagingToken: string;
    mapping: Record<string, unknown>;
    projectKey?: string;
    confirmMerge?: boolean;
    confirmProjectKey?: string;
    config?: Record<string, unknown>;
  }): Promise<CallToolResult> => {
    const { adapter, stagingToken, mapping, projectKey, confirmMerge, confirmProjectKey, config } = args;
    try {
      const job = await client.post<{ jobId: string | null; token: string; status: string }>(
        `/admin/import/${encodeURIComponent(adapter)}/apply-async`,
        {
          stagingToken,
          mapping,
          ...(projectKey ? { projectKey } : {}),
          ...(confirmMerge !== undefined ? { confirmMerge } : {}),
          ...(confirmProjectKey ? { confirmProjectKey } : {}),
          ...(config ? { config } : {}),
        },
      );
      return {
        content: [{ type: 'text', text: `Import ${job.status} (job ${job.jobId ?? 'none'}, token ${job.token}). Follow it with GET /admin/import/jobs/${job.token} through orboto_api_call; the finished result carries the numbering report.` }],
        structuredContent: { applied: true, jobId: job.jobId, token: job.token, status: job.status },
      };
    } catch (err) {
      const refusal = mergeRefusalOf(err);
      if (refusal) return mergeRefusalResult(refusal);
      throw err;
    }
  };
}

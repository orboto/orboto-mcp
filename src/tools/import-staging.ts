/**
 * ORB-3121 - the background staging of an import source: start it (the source config is sealed on the server, never in a job), follow its
 * progress and rate-limit waits, read the staged preview without its batch, and cancel it.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';

/** Mirrors `ImportStagingProgressSchema` of @orboto/shared-schema (this package cannot import it; pinned by import-staging.test.ts). */
export interface StagingProgress {
  percent: number;
  waitingUntil: string | null;
  waits: number;
  revivals?: number;
}

interface JobStatus {
  token: string;
  status: string;
  adapterId?: string;
  total: number;
  error: string | null;
  progress?: { staging?: StagingProgress } | null;
}

interface StagedPreview {
  stagingToken?: string;
  mapping: Record<string, unknown> & { warnings?: string[] };
  summary: Record<string, number>;
  numbering?: { projectKey: string | null; merge: boolean; existingTickets: number; renumbered: unknown[] };
  availableStatuses?: unknown[];
}

const WARNINGS_CAP = 20;

export const importStageToolConfig = {
  title: 'Stage import',
  description:
    'Read an import source in the background. Adapters with resumableStaging (openproject-api) wait out the source\'s rate limit and resume. config: the source credentials, sealed on the server for at most 24 hours, never in a job, and used again by orboto_import_apply (no config needed there). Needs an API-key profile: an OAuth connection is refused (403). Follow with orboto_import_staging. admin:import.',
  inputSchema: z.object({
    adapter: z.string().max(64),
    config: z.record(z.string(), z.unknown()),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false },
};

export function makeImportStageHandler(client: OrbotoClient) {
  return async ({ adapter, config }: { adapter: string; config: Record<string, unknown> }): Promise<CallToolResult> => {
    const job = await client.post<{ jobId: string | null; token: string; status: string }>(`/admin/import/${encodeURIComponent(adapter)}/stage-async`, { config });
    return {
      content: [{ type: 'text', text: `Staging started (token ${job.token}). Follow it with orboto_import_staging token ${job.token}; once it is staged, the same tool with preview: true answers the mapping for orboto_import_apply.` }],
      structuredContent: { token: job.token, jobId: job.jobId, status: job.status },
    };
  };
}

export function stagingLines(job: JobStatus): string[] {
  const staging = job.progress?.staging;
  const lines = [`Import ${job.token}: ${job.status}${job.adapterId ? ` (${job.adapterId})` : ''}.`];
  if (job.status === 'staging' && staging) {
    lines.push(staging.waitingUntil
      ? `Read ${staging.percent} %; the source is rate limited, reading resumes at ${staging.waitingUntil} (wait ${staging.waits}).`
      : `Read ${staging.percent} %.`);
  }
  if (job.status === 'staged') lines.push(`Staged: ${job.total} tickets. Call again with preview: true for the mapping, then orboto_import_apply.`);
  if (job.error) lines.push(`Error: ${job.error}`);
  return lines;
}

export const importStagingToolConfig = {
  title: 'Import staging',
  description:
    'Status of a background import staging. It answers the percent read, until when a rate limit holds it and the error; preview: true on a staged import adds the suggested mapping, summary and numbering (no batch). admin:import.',
  inputSchema: z.object({
    token: z.guid(),
    preview: z.boolean().optional(),
    projectId: z.guid().optional(),
    projectKey: z.string().max(10).optional(),
  }).shape,
  annotations: { readOnlyHint: true, openWorldHint: false },
};

export function makeImportStagingHandler(client: OrbotoClient) {
  return async ({ token, preview, projectId, projectKey }: { token: string; preview?: boolean; projectId?: string; projectKey?: string }): Promise<CallToolResult> => {
    const job = await client.get<JobStatus>(`/admin/import/jobs/${encodeURIComponent(token)}`);
    const lines = stagingLines(job);
    const structured: Record<string, unknown> = {
      token: job.token, status: job.status, adapterId: job.adapterId ?? null, tickets: job.total, error: job.error,
      staging: job.progress?.staging ?? null,
    };
    if (preview && job.status === 'staged') {
      const query = new URLSearchParams();
      if (projectId) query.set('projectId', projectId);
      else if (projectKey) query.set('projectKey', projectKey);
      const suffix = query.toString();
      const staged = await client.get<StagedPreview>(`/admin/import/jobs/${encodeURIComponent(token)}/preview${suffix ? `?${suffix}` : ''}`);
      const { warnings = [], ...mapping } = staged.mapping;
      lines.push(`Summary: ${Object.entries(staged.summary).map(([k, v]) => `${k} ${v}`).join(', ')}.`);
      if (staged.numbering) lines.push(`Target key ${staged.numbering.projectKey ?? '(none)'}${staged.numbering.merge ? `, a MERGE into ${staged.numbering.existingTickets} existing tickets` : ''}; renumbered ${staged.numbering.renumbered.length}.`);
      if (warnings.length) lines.push(`Warnings (${warnings.length}):`, ...warnings.slice(0, WARNINGS_CAP).map((w) => `- ${w}`));
      structured.mapping = mapping;
      structured.summary = staged.summary;
      structured.warnings = warnings.slice(0, WARNINGS_CAP);
      structured.warningsOmitted = Math.max(0, warnings.length - WARNINGS_CAP);
      structured.numbering = staged.numbering ? { projectKey: staged.numbering.projectKey, merge: staged.numbering.merge, existingTickets: staged.numbering.existingTickets, renumbered: staged.numbering.renumbered.length } : null;
    }
    return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: structured };
  };
}

export const importCancelToolConfig = {
  title: 'Cancel staging',
  description: 'Cancel a background import staging, or discard a staged import not applied yet. Its sealed source config and read checkpoint are deleted. Only on the user\'s request. admin:import.',
  inputSchema: z.object({ token: z.guid() }).shape,
  annotations: { readOnlyHint: false, destructiveHint: true },
};

export function makeImportCancelHandler(client: OrbotoClient) {
  return async ({ token }: { token: string }): Promise<CallToolResult> => {
    const res = await client.post<{ token: string; status: string }>(`/admin/import/jobs/${encodeURIComponent(token)}/cancel`, {});
    return {
      content: [{ type: 'text', text: `Import ${res.token} cancelled (status ${res.status}); its sealed source config is deleted.` }],
      structuredContent: { token: res.token, status: res.status },
    };
  };
}

/** ORB-3013 - `orboto_ci_status`, `orboto_ci_log`, `orboto_ci_artifacts`: CI of a project's repository through its git connection, read-only. */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';
import { resolveProjectByKey } from './shared.js';
import type { CiArtifactListResponse, CiLogResponse, CiStatusResponse } from './ci-result.js';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
/** Lines a log answer carries when the caller names no `tail`; the MCP answer budget holds no whole build log. */
export const MCP_LOG_TAIL = 200;

const connection = {
  projectKey: z.string().min(1).max(64),
  repository: z.string().min(3).max(300).optional().describe('owner/name'),
  connectionId: z.string().max(36).optional(),
};

type Selector = { repository?: string; connectionId?: string };

function query(values: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) if (v !== undefined) params.set(k, String(v));
  const text = params.toString();
  return text ? `?${text}` : '';
}

export const ciStatusToolConfig = {
  title: 'CI status of a commit',
  description: 'CI runs of a commit, branch, tag or pull request with verdicts and the jobs that did not end green. Read through the project\'s Forgejo or GitHub connection. The newest run of a workflow decides; older runs, a cancelled run whose branch moved on and a run whose job `superseded` ran read superseded. Needs ticket:edit. CLI: `orboto ci status`, `orboto ci wait` blocks until final.',
  inputSchema: z.object({
    ...connection,
    ref: z.string().min(1).max(255).optional(),
    pr: z.number().int().positive().max(1_000_000_000).optional(),
  }).shape,
  annotations: READ,
};

export function makeCiStatusHandler(client: OrbotoClient) {
  return async (args: Selector & { projectKey: string; ref?: string; pr?: number }): Promise<CallToolResult> => {
    const project = await resolveProjectByKey(client, args.projectKey);
    const res = await client.get<CiStatusResponse>(`/projects/${project.id}/ci/status${query({ ref: args.ref, pr: args.pr, repository: args.repository, connectionId: args.connectionId })}`);
    const lines = [`${res.connection.repository} ${res.sha.slice(0, 12)} (${res.ref}): ${res.verdict}`];
    for (const run of res.runs) {
      if (run.supersededReason === 'newer_run_on_commit') continue;
      const failing = run.jobs.map((j) => `${j.name} ${j.state} (job ${j.id})`).join(', ');
      lines.push(`- ${run.workflow} #${run.number ?? run.id} run ${run.id}: ${run.verdict} (${run.providerStatus})${failing ? `; not green: ${failing}` : ''}`);
    }
    for (const s of res.superseded) lines.push(`superseded: ${s}`);
    if (res.capabilities.reason) lines.push(`note: ${res.capabilities.reason}`);
    return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: { ...res } };
  };
}

export const ciLogToolConfig = {
  title: 'CI job log',
  description: `Log of a CI job (jobId) or of a run's jobs (runId; failed=true: red only), last ${MCP_LOG_TAIL} lines by default. tail sets the line count, contains keeps lines with that literal text. A provider without a job log API (Forgejo before 16) answers errors.ci.job_logs_unsupported with the reason. Needs ticket:edit.`,
  inputSchema: z.object({
    ...connection,
    jobId: z.string().regex(/^\d{1,20}$/).optional(),
    runId: z.string().regex(/^\d{1,20}$/).optional(),
    failed: z.boolean().optional(),
    tail: z.number().int().positive().max(20_000).optional(),
    contains: z.string().min(1).max(200).optional(),
  }).shape,
  annotations: READ,
};

export function makeCiLogHandler(client: OrbotoClient) {
  return async (args: Selector & { projectKey: string; jobId?: string; runId?: string; failed?: boolean; tail?: number; contains?: string }): Promise<CallToolResult> => {
    if (Boolean(args.jobId) === Boolean(args.runId)) throw new Error('Pass exactly one of jobId or runId.');
    const project = await resolveProjectByKey(client, args.projectKey);
    const q = query({ tail: args.tail ?? MCP_LOG_TAIL, contains: args.contains, failed: args.runId && args.failed ? true : undefined, repository: args.repository, connectionId: args.connectionId });
    const path = args.jobId ? `/projects/${project.id}/ci/jobs/${args.jobId}/log${q}` : `/projects/${project.id}/ci/runs/${args.runId}/log${q}`;
    const res = await client.get<CiLogResponse>(path);
    const parts = res.jobs.map((j) => `=== job ${j.id}${j.name ? ` ${j.name}` : ''}${j.state ? ` (${j.state})` : ''}, ${j.lines} lines${j.truncated ? ', cut' : ''} ===\n${j.log}`);
    const omitted = res.jobsOmitted > 0 ? `\n\n${res.jobsOmitted} more jobs not read (50 per call, 45 s budget): ask for them by jobId.` : '';
    return { content: [{ type: 'text', text: `${parts.join('\n\n') || 'No job matched.'}${omitted}` }], structuredContent: { ...res, jobs: res.jobs.map(({ log: _log, ...job }) => job) } };
  };
}

export const ciArtifactsToolConfig = {
  title: 'CI artifacts of a run',
  description: 'The artifacts of a CI run (id, name, size, expiry). Download one with `orboto ci artifacts <run> --download <name|id>` or GET /projects/{projectId}/ci/artifacts/{artifactId}/download. Forgejo before 16 answers errors.ci.artifacts_unsupported. Needs ticket:edit.',
  inputSchema: z.object({ ...connection, runId: z.string().regex(/^\d{1,20}$/) }).shape,
  annotations: READ,
};

export function makeCiArtifactsHandler(client: OrbotoClient) {
  return async (args: Selector & { projectKey: string; runId: string }): Promise<CallToolResult> => {
    const project = await resolveProjectByKey(client, args.projectKey);
    const res = await client.get<CiArtifactListResponse>(`/projects/${project.id}/ci/runs/${args.runId}/artifacts${query({ repository: args.repository, connectionId: args.connectionId })}`);
    const lines = res.artifacts.map((a) => `- ${a.name} (artifact ${a.id}, ${a.sizeBytes ?? '?'} bytes${a.expired ? ', expired' : ''})`);
    return { content: [{ type: 'text', text: lines.length ? `Artifacts of run ${res.runId}:\n${lines.join('\n')}` : `Run ${res.runId} has no artifacts.` }], structuredContent: { ...res } };
  };
}

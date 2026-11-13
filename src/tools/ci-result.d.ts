/** Mirrors the CI answers of @orboto/shared-schema (ci.ts); the MCP package ships without it, apps/api/src/test/ci-mcp-drift.test.ts pins the copy in both directions. */
export type CiState = 'pending' | 'running' | 'success' | 'failure' | 'cancelled' | 'skipped';
export type CiRunVerdict = 'green' | 'red' | 'pending' | 'superseded' | 'skipped';

export interface CiConnectionRef {
  id: string;
  provider: 'forgejo' | 'github';
  name: string;
  repository: string;
  providerVersion: string | null;
}

export interface CiCapabilities {
  jobLogs: boolean;
  artifacts: boolean;
  reason: string | null;
}

export interface CiJob {
  id: string;
  runId: string;
  name: string;
  state: CiState;
  providerStatus: string;
  attempt: number | null;
  webUrl: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface CiRun {
  id: string;
  number: number | null;
  workflow: string;
  title: string | null;
  event: string | null;
  branch: string | null;
  sha: string;
  state: CiState;
  providerStatus: string;
  verdict: CiRunVerdict;
  supersededBy: string | null;
  supersededReason: 'newer_run_on_commit' | 'newer_run_on_branch' | 'superseded_job' | null;
  webUrl: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  jobsShown: 'all' | 'not_successful' | 'none';
  jobs: CiJob[];
  jobTotals: { total: number; success: number; failure: number; cancelled: number; skipped: number; pending: number; running: number } | null;
}

export interface CiStatusResponse {
  connection: CiConnectionRef;
  ref: string;
  sha: string;
  verdict: CiRunVerdict | 'none';
  runs: CiRun[];
  red: string[];
  pending: string[];
  superseded: string[];
  capabilities: CiCapabilities;
  checkedAt: string;
}

export interface CiLogResponse {
  connection: CiConnectionRef;
  runId: string | null;
  jobs: Array<{ id: string; name: string | null; state: CiState | null; log: string; bytes: number; lines: number; truncated: boolean }>;
  jobsOmitted: number;
}

export interface CiArtifactListResponse {
  connection: CiConnectionRef;
  runId: string;
  artifacts: Array<{ id: string; runId: string; name: string; sizeBytes: number | null; expired: boolean; createdAt: string | null; expiresAt: string | null }>;
}

/** ORB-3013 - the CI read tools call the project's CI routes and print one line per deciding run. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import { ciArtifactsToolConfig, ciLogToolConfig, ciStatusToolConfig, makeCiArtifactsHandler, makeCiLogHandler, makeCiStatusHandler, MCP_LOG_TAIL } from './ci.js';

const project = { id: '11111111-1111-4111-8111-111111111111', key: 'ORB', name: 'orboto' };
const connection = { id: '22222222-2222-4222-8222-222222222222', provider: 'forgejo', name: 'acme/app', repository: 'acme/app', providerVersion: '15.0.3' };
const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });

function stub(answers: unknown[]): string[] {
  const urls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    urls.push(url.toString());
    const body = answers.shift();
    if (body === undefined) throw new Error(`unexpected fetch ${url.toString()}`);
    return { ok: true, status: 200, statusText: 'OK', json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
  });
  return urls;
}

const job = { id: '105', runId: '12', name: 'api-tests', state: 'failure', providerStatus: 'failure', attempt: null, webUrl: null, startedAt: null, completedAt: null };
const run = (id: string, verdict: string, extra: Record<string, unknown> = {}) => ({
  id, number: Number(id), workflow: 'tests.yml', title: null, event: 'push', branch: 'develop', sha: 'a'.repeat(40), state: 'failure', providerStatus: 'failure',
  verdict, supersededBy: null, supersededReason: null, webUrl: null, createdAt: null, updatedAt: null, jobsShown: 'not_successful', jobs: [], jobTotals: null, ...extra,
});

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('orboto_ci_status', () => {
  it('reads the status route with the ref and prints the deciding runs, the failing jobs and the missing log API', async () => {
    const status = {
      connection, ref: 'develop', sha: 'a'.repeat(40), verdict: 'red',
      runs: [run('12', 'red', { jobs: [job] }), run('11', 'superseded', { supersededReason: 'newer_run_on_commit', jobsShown: 'none' })],
      red: ['tests.yml #12 failure (api-tests)'], pending: [], superseded: [], capabilities: { jobLogs: false, artifacts: false, reason: 'Forgejo 15.0.3 has no API for job logs' }, checkedAt: '2026-11-13T10:00:00.000Z',
    };
    const urls = stub([project, status]);
    const out = await makeCiStatusHandler(client)({ projectKey: 'ORB', ref: 'develop' });
    expect(urls[1]).toBe(`https://orboto.example.com/projects/${project.id}/ci/status?ref=develop`);
    const text = (out.content[0] as { text: string }).text;
    expect(text).toContain('acme/app aaaaaaaaaaaa (develop): red');
    expect(text).toContain('- tests.yml #12 run 12: red (failure); not green: api-tests failure (job 105)');
    expect(text).not.toContain('#11');
    expect(text).toContain('note: Forgejo 15.0.3 has no API for job logs');
    expect(out.structuredContent).toEqual(status);
  });

  it('is a read-only tool that reaches the git host', () => {
    for (const config of [ciStatusToolConfig, ciLogToolConfig, ciArtifactsToolConfig]) {
      expect(config.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    }
  });
});

describe('orboto_ci_log and orboto_ci_artifacts', () => {
  it('asks a run log for the red jobs with the default tail and prints each job under its header', async () => {
    const urls = stub([project, { connection, runId: '12', jobs: [{ id: '7', name: 'api-tests', state: 'failure', log: 'FAIL a', bytes: 9, lines: 1, truncated: true }], jobsOmitted: 2 }]);
    const out = await makeCiLogHandler(client)({ projectKey: 'ORB', runId: '12', failed: true, contains: 'FAIL' });
    expect(urls[1]).toBe(`https://orboto.example.com/projects/${project.id}/ci/runs/12/log?tail=${MCP_LOG_TAIL}&contains=FAIL&failed=true`);
    expect((out.content[0] as { text: string }).text).toBe('=== job 7 api-tests (failure), 1 lines, cut ===\nFAIL a\n\n2 more jobs not read (50 per call, 45 s budget): ask for them by jobId.');
    expect(JSON.stringify(out.structuredContent)).not.toContain('FAIL a');
    expect(out.structuredContent).toMatchObject({ jobsOmitted: 2, jobs: [{ id: '7', lines: 1 }] });
    await expect(makeCiLogHandler(client)({ projectKey: 'ORB' })).rejects.toThrow('exactly one of jobId or runId');
  });

  it('passes the connection id on, so two connections to one repository can be told apart', async () => {
    const id = '33333333-3333-4333-8333-333333333333';
    const urls = stub([project, { connection, runId: '12', jobs: [], jobsOmitted: 0 }, project, { connection, runId: '12', artifacts: [] }]);
    await makeCiLogHandler(client)({ projectKey: 'ORB', jobId: '7', connectionId: id });
    await makeCiArtifactsHandler(client)({ projectKey: 'ORB', runId: '12', connectionId: id });
    expect(urls[1]).toContain(`connectionId=${id}`);
    expect(urls[3]).toBe(`https://orboto.example.com/projects/${project.id}/ci/runs/12/artifacts?connectionId=${id}`);
    expect(ciStatusToolConfig.inputSchema).toHaveProperty('connectionId');
  });

  it('lists the artifacts of a run', async () => {
    stub([project, { connection, runId: '12', artifacts: [{ id: '5', runId: '12', name: 'coverage', sizeBytes: 4, expired: false, createdAt: null, expiresAt: null }] }]);
    const out = await makeCiArtifactsHandler(client)({ projectKey: 'ORB', runId: '12', repository: 'acme/app' });
    expect((out.content[0] as { text: string }).text).toBe('Artifacts of run 12:\n- coverage (artifact 5, 4 bytes)');
  });
});

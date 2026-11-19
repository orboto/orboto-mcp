/**
 * ORB-3121 - orboto_import_stage, orboto_import_staging and orboto_import_cancel.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { OrbotoClient } from '../orboto-client.js';
import { toolInToolset } from '../toolset.js';
import {
  importCancelToolConfig, importStageToolConfig, importStagingToolConfig,
  makeImportCancelHandler, makeImportStageHandler, makeImportStagingHandler, stagingLines,
} from './import-staging.js';

const TOKEN = '3f2b6c1e-8a4d-4e5f-9b7a-1c2d3e4f5a6b';
const textOf = (result: { content: unknown[] }): string => (result.content[0] as { text: string }).text;

const status = (over: Record<string, unknown> = {}) => ({
  token: TOKEN, status: 'staging', adapterId: 'openproject-api', total: 0, error: null,
  progress: { comments: 0, staging: { percent: 40, waitingUntil: '2026-11-19T10:15:00.000Z', waits: 2 } },
  ...over,
});

describe('orboto_import_stage', () => {
  it('starts the staging with the config and answers the token to follow', async () => {
    const post = vi.fn().mockResolvedValue({ jobId: 'job-1', token: TOKEN, status: 'staging' });
    const result = await makeImportStageHandler({ post } as unknown as OrbotoClient)({ adapter: 'openproject-api', config: { baseUrl: 'https://op.example.test', project: 'demo', apiToken: 't' } });
    expect(post).toHaveBeenCalledWith('/admin/import/openproject-api/stage-async', { config: { baseUrl: 'https://op.example.test', project: 'demo', apiToken: 't' } });
    expect(result.structuredContent).toEqual({ token: TOKEN, jobId: 'job-1', status: 'staging' });
    expect(textOf(result)).toContain(`orboto_import_staging token ${TOKEN}`);
  });
});

describe('orboto_import_staging', () => {
  it('shows the percent and the rate-limit wait of a running staging, without a preview call', async () => {
    const get = vi.fn().mockResolvedValue(status());
    const result = await makeImportStagingHandler({ get } as unknown as OrbotoClient)({ token: TOKEN, preview: true });
    expect(get).toHaveBeenCalledTimes(1);
    expect(textOf(result)).toContain('Read 40 %; the source is rate limited, reading resumes at 2026-11-19T10:15:00.000Z (wait 2).');
    expect(result.structuredContent).toMatchObject({ status: 'staging', staging: { percent: 40, waits: 2 } });
  });

  it('adds the mapping, summary and numbering of a staged import without the batch', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce(status({ status: 'staged', total: 3, progress: { staging: { percent: 100, waitingUntil: null, waits: 0 } } }))
      .mockResolvedValueOnce({
        stagingToken: TOKEN, batch: { tickets: [{ sourceId: '1' }] },
        mapping: { projectId: null, statusMap: { New: 'todo' }, warnings: ['w1'] },
        summary: { tickets: 3, comments: 4 },
        numbering: { projectKey: 'OPDEMO', merge: false, existingTickets: 0, renumbered: [] },
      });
    const result = await makeImportStagingHandler({ get } as unknown as OrbotoClient)({ token: TOKEN, preview: true, projectKey: 'OPDEMO' });
    expect(get).toHaveBeenLastCalledWith(`/admin/import/jobs/${TOKEN}/preview?projectKey=OPDEMO`);
    expect(result.structuredContent).toMatchObject({ mapping: { projectId: null, statusMap: { New: 'todo' } }, summary: { tickets: 3 }, warnings: ['w1'], numbering: { projectKey: 'OPDEMO', renumbered: 0 } });
    expect(JSON.stringify(result.structuredContent)).not.toContain('batch');
    expect(textOf(result)).toContain('Staged: 3 tickets.');
  });

  it('names a failed staging with its reason', () => {
    expect(stagingLines(status({ status: 'failed', error: 'Cancelled by an administrator.' }) as never)).toEqual([
      `Import ${TOKEN}: failed (openproject-api).`, 'Error: Cancelled by an administrator.',
    ]);
  });
});

describe('orboto_import_cancel', () => {
  it('cancels the staging', async () => {
    const post = vi.fn().mockResolvedValue({ token: TOKEN, status: 'failed' });
    const result = await makeImportCancelHandler({ post } as unknown as OrbotoClient)({ token: TOKEN });
    expect(post).toHaveBeenCalledWith(`/admin/import/jobs/${TOKEN}/cancel`, {});
    expect(result.structuredContent).toEqual({ token: TOKEN, status: 'failed' });
  });
});

describe('contract', () => {
  it('annotations: stage writes without destroying, staging reads, cancel is destructive', () => {
    expect(importStageToolConfig.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(importStagingToolConfig.annotations).toMatchObject({ readOnlyHint: true });
    expect(importCancelToolConfig.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it('the staging progress mirrors ImportStagingProgressSchema of @orboto/shared-schema', () => {
    const shared = readFileSync(resolve(process.cwd(), '../../packages/shared-schema/src/import-jobs.ts'), 'utf8');
    const block = /export const ImportStagingProgressSchema = z\.object\(\{([\s\S]*?)\n\}\);/.exec(shared)?.[1] ?? '';
    const fields = [...block.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]).sort();
    const mirror = readFileSync(resolve(process.cwd(), 'src/tools/import-staging.ts'), 'utf8');
    const local = /export interface StagingProgress \{([\s\S]*?)\n\}/.exec(mirror)?.[1] ?? '';
    expect([...local.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]).sort()).toEqual(fields);
    expect(fields).toEqual(['percent', 'revivals', 'waitingUntil', 'waits']);
  });

  it('keeps the staging tools out of the curated, minimal and channel sets', () => {
    for (const name of ['orboto_import_stage', 'orboto_import_staging', 'orboto_import_cancel']) {
      expect(toolInToolset(name, 'full')).toBe(true);
      expect(toolInToolset(name, 'curated')).toBe(false);
      expect(toolInToolset(name, 'minimal')).toBe(false);
      expect(toolInToolset(name, 'channel')).toBe(false);
    }
  });
});

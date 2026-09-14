import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { OrbotoClient } from '../orboto-client.js';
import { makeProjectReadinessHandler } from './project-readiness.js';

it('returns measured readiness after project key resolution and preserves fix actions', async () => {
  const report = { projectId: '11111111-2222-4333-8444-555555555555', projectKey: 'TEST', language: 'en', ready: false, ticketScope: 'visible', items: [{ id: 'commands', status: 'missing', reason: 'commands_missing', checked: 1, missing: 1, fix: { method: 'POST', route: '/projects/p/primer-facts', mcpTool: 'orboto_primer_fact_add', cliCommand: 'orboto post /projects/p/primer-facts', settingsPath: '/projects/test/settings?tab=aiPrimer' } }] };
  const get = vi.fn().mockResolvedValueOnce({ id: report.projectId, key: 'TEST', name: 'Test' }).mockResolvedValueOnce(report);
  const result = await makeProjectReadinessHandler({ get } as unknown as OrbotoClient)({ projectKey: 'test' });
  expect(get).toHaveBeenLastCalledWith(`/projects/${report.projectId}/readiness`);
  expect(result.structuredContent).toEqual(report);
});
it('pins the standalone schema mirror to shared-schema', () => {
  const root = resolve(process.cwd(), '../..');
  expect(readFileSync(resolve(root, 'apps/mcp/src/tools/project-readiness-schema.ts'), 'utf8')).toBe(readFileSync(resolve(root, 'packages/shared-schema/src/project-readiness.ts'), 'utf8').replace("import { ProjectSchema } from './projects.ts';\n", '').replace('\nexport const CreatedProjectSchema = ProjectSchema.extend({ readiness: ProjectReadinessSchema });\n', ''));
});
it('propagates denied access instead of reporting readiness', async () => {
  const get = vi.fn().mockRejectedValue(new Error('404'));
  await expect(makeProjectReadinessHandler({ get } as unknown as OrbotoClient)({ projectKey: 'private' })).rejects.toThrow();
});

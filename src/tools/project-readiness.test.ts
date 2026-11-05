import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { OrbotoClient } from '../orboto-client.js';
import { makeProjectReadinessHandler } from './project-readiness.js';
import { ProjectReadinessItemSchema, ProjectReadinessStatusSchema } from './project-readiness-schema.js';

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
it('ORB-2834 keeps the status enum closed at ok, missing and n/a, so an older build parses a never-probed connection', () => {
  expect(ProjectReadinessStatusSchema.options).toEqual(['ok', 'missing', 'n/a']);
  const item = { id: 'git_connection', status: 'missing', reason: 'probe_pending', pending: true, checked: 1, missing: 1, connectionId: '66666666-7777-4888-8999-000000000000',
    fix: { method: 'POST', route: '/projects/p/git-connections/c/probe', mcpTool: 'orboto_git_probe', cliCommand: 'orboto git probe', settingsPath: '/projects/test/settings?tab=git' } };
  expect(ProjectReadinessItemSchema.parse(item)).toEqual(item);
});
it('ORB-2834 names a pending git probe by its pending flag with the next fleet probe cycle and the command that probes it now', async () => {
  const connectionId = '66666666-7777-4888-8999-000000000000';
  const report = { projectId: '11111111-2222-4333-8444-555555555555', projectKey: 'TEST', language: 'en', ready: false, ticketScope: 'visible', items: [{
    id: 'git_connection', status: 'missing', reason: 'probe_pending', pending: true, checked: 1, missing: 1, connectionId, nextProbeAt: '2026-11-05T10:10:00.000Z',
    fix: { method: 'POST', route: `/projects/p/git-connections/${connectionId}/probe`, mcpTool: 'orboto_git_probe', cliCommand: `orboto git probe --project TEST --connection ${connectionId}`, settingsPath: '/projects/test/settings?tab=git' },
  }] };
  const get = vi.fn().mockResolvedValueOnce({ id: report.projectId, key: 'TEST', name: 'Test' }).mockResolvedValueOnce(report);
  const result = await makeProjectReadinessHandler({ get } as unknown as OrbotoClient)({ projectKey: 'test' });
  const text = (result.content[0] as { text: string }).text;
  expect(text).toContain('TEST: setup check pending');
  expect(text).toContain(`missing: git_connection (probe_pending) - pending, next fleet probe cycle 2026-11-05T10:10:00.000Z, now: orboto git probe --project TEST --connection ${connectionId}`);
  expect(result.structuredContent).toEqual(report);
});
it('ORB-2834 keeps a failing git connection with a missing item apart from a pending one', async () => {
  const connectionId = '66666666-7777-4888-8999-000000000000';
  const fix = { method: 'POST', route: '/projects/p/x', mcpTool: 'orboto_x', cliCommand: 'orboto x', settingsPath: '/projects/test/settings' };
  const report = { projectId: '11111111-2222-4333-8444-555555555555', projectKey: 'TEST', language: 'en', ready: false, ticketScope: 'visible', items: [
    { id: 'git_connection', status: 'missing', reason: 'probe_pending', pending: true, checked: 1, missing: 1, connectionId, fix },
    { id: 'commands', status: 'missing', reason: 'commands_missing', checked: 1, missing: 1, fix },
  ] };
  const get = vi.fn().mockResolvedValueOnce({ id: report.projectId, key: 'TEST', name: 'Test' }).mockResolvedValueOnce(report);
  const text = ((await makeProjectReadinessHandler({ get } as unknown as OrbotoClient)({ projectKey: 'test' })).content[0] as { text: string }).text;
  expect(text).toContain('TEST: setup incomplete');
  expect(text).toContain('missing: commands (commands_missing)');
  expect(text).toContain('pending, next fleet probe cycle unknown');
});
it('propagates denied access instead of reporting readiness', async () => {
  const get = vi.fn().mockRejectedValue(new Error('404'));
  await expect(makeProjectReadinessHandler({ get } as unknown as OrbotoClient)({ projectKey: 'private' })).rejects.toThrow();
});

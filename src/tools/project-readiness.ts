import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';
import { ProjectReadinessSchema } from './project-readiness-schema.js';
import { resolveProjectByKey } from './shared.js';

export const projectReadinessToolConfig = {
  title: 'Check project readiness',
  description: 'Check setup before autonomous work: measured ok/missing/n/a items with reasons and fix actions. Visible tickets only; no external probes.',
  inputSchema: z.object({ projectKey: z.string().min(1).describe('Project key, case-insensitive.') }).shape,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
};
export function makeProjectReadinessHandler(client: OrbotoClient) {
  return async ({ projectKey }: { projectKey: string }): Promise<CallToolResult> => {
    const project = await resolveProjectByKey(client, projectKey);
    const report = ProjectReadinessSchema.parse(await client.get(`/projects/${project.id}/readiness`));
    return { content: [{ type: 'text', text: `${report.projectKey}: ${report.ready ? 'ready' : 'setup incomplete'}\n${report.items.map(i => `${i.status}: ${i.id} (${i.reason})`).join('\n')}` }], structuredContent: report };
  };
}

import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';
import { ProjectReadinessSchema, type ProjectReadiness } from './project-readiness-schema.js';
import { resolveProjectByKey } from './shared.js';

export const projectReadinessToolConfig = {
  title: 'Check project readiness',
  description: 'Setup checklist before autonomous work: each item ok, missing or n/a, with its fix. Visible tickets only; no external probes.',
  inputSchema: z.object({ projectKey: z.string().min(1) }).shape,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
};

/** A pending item (a git connection no probe has checked yet) names the start of the next fleet probe cycle and the command that checks it now. */
function itemLine(i: ProjectReadiness['items'][number]): string {
  const line = `${i.status}: ${i.id} (${i.reason})`;
  return i.pending ? `${line} - pending, next fleet probe cycle ${i.nextProbeAt ?? 'unknown'}, now: ${i.fix.cliCommand}` : line;
}

export function makeProjectReadinessHandler(client: OrbotoClient) {
  return async ({ projectKey }: { projectKey: string }): Promise<CallToolResult> => {
    const project = await resolveProjectByKey(client, projectKey);
    const report = ProjectReadinessSchema.parse(await client.get(`/projects/${project.id}/readiness`));
    const verdict = report.ready ? 'ready' : report.items.some(i => i.status === 'missing' && !i.pending) ? 'setup incomplete' : 'setup check pending';
    return { content: [{ type: 'text', text: `${report.projectKey}: ${verdict}\n${report.items.map(itemLine).join('\n')}` }], structuredContent: report };
  };
}

/** ORB-2834 - `orboto_git_probe`: check one git connection with its host now instead of waiting for the fleet probe. */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';
import { resolveProjectByKey } from './shared.js';

interface ProbeResponse {
  health: {
    connectionId: string;
    name: string;
    healthy: boolean;
    reason: string | null;
    outboundReachable: boolean | null;
    inboundDelivering: boolean | null;
    tokenState: string;
    deliveryError: string | null;
    lastProbeAt: string | null;
  };
  durationMs: number;
  timedOut: boolean;
}

export const gitProbeToolConfig = {
  title: 'Probe a git connection',
  description:
    'Check a git connection with its host now. The probe checks the credential, the reachability and the webhook deliveries and stores the result, so readiness judges it at once instead of at the next fleet probe, up to 10 minutes later. Needs project:edit, audited. An ssh-poll or switched-off connection answers 422.',
  inputSchema: z.object({
    projectKey: z.string().min(1),
    connectionId: z.string().uuid(),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
};

export function makeGitProbeHandler(client: OrbotoClient) {
  return async (args: { projectKey: string; connectionId: string }): Promise<CallToolResult> => {
    const project = await resolveProjectByKey(client, args.projectKey);
    const res = await client.post<ProbeResponse>(`/projects/${project.id}/git-connections/${args.connectionId}/probe`, {});
    const h = res.health;
    const mark = (v: boolean | null) => (v === null ? 'unknown' : v ? 'ok' : 'failing');
    const lines = [
      `Probed "${h.name}" (${h.connectionId}) in ${res.durationMs} ms${res.timedOut ? ', ran into the time bound' : ''}.`,
      `Outbound ${mark(h.outboundReachable)}, inbound ${mark(h.inboundDelivering)}, token ${h.tokenState}; healthy: ${h.healthy}${h.reason ? ` (${h.reason})` : ''}.`,
    ];
    if (h.deliveryError) lines.push(`Provider error: ${h.deliveryError}`);
    return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: { ...res } };
  };
}

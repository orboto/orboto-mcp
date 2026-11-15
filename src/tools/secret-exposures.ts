/**
 * ORB-3090 - `orboto_secret_exposures`, the agent secret guard's incident list. Resolving is not a tool: only a person closes an exposure.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';

/** Mirror of shared-schema SecretExposureSchema (the MCP package cannot import shared-schema); pinned by secret-exposures.test.ts. */
export interface SecretExposure {
  id: string;
  reportId: string;
  class: string;
  source: 'pattern' | 'fingerprint';
  preview: string;
  length: number;
  sha256: string;
  toolName: string;
  stage: 'tool_output' | 'command_output' | 'tool_failure';
  harness: string;
  harnessSessionId: string | null;
  hostLabel: string | null;
  reporterId: string | null;
  reporterName: string | null;
  agentSessionId: string | null;
  projectId: string | null;
  projectKey: string | null;
  credentialId: string | null;
  credentialKey: string | null;
  state: 'open' | 'resolved';
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
  rotatedCredentialId: string | null;
  createdAt: string;
}

export const secretExposuresToolConfig = {
  title: 'Agent secret exposures',
  description:
    'Super-admin list of the agent secret guard incidents: a secret an agent tool output held, redacted before the model read it, or reported only when it came from a failed Claude Code call whose output no hook can rewrite (stage tool_failure; the model has read that value) (class, masked preview, tool, harness, host, reporter, project, the vault credential marked due for rotation). Skill reference admin.md "Agent secret exposures". Resolving is person-only: Admin -> Security -> Secret exposures or `orboto admin secret-exposures resolve`.',
  inputSchema: z.object({
    state: z.enum(['open', 'resolved']).optional().describe('Only open or only resolved incidents.'),
    projectId: z.string().uuid().optional().describe('Only incidents of this project.'),
    session: z.string().min(1).max(200).optional().describe('An agent session id or a harness session id.'),
    limit: z.number().int().min(1).max(200).optional().describe('Page size (default 50).'),
    cursor: z.string().min(1).max(2000).optional().describe('nextCursor of the previous page.'),
  }).shape,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

export function makeSecretExposuresHandler(client: OrbotoClient) {
  return async (args: { state?: 'open' | 'resolved'; projectId?: string; session?: string; limit?: number; cursor?: string }): Promise<CallToolResult> => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(args)) {
      if (value !== undefined) query.set(key, String(value));
    }
    const page = await client.get<{ items: SecretExposure[]; nextCursor: string | null }>(`/admin/secret-exposures?${query.toString()}`);
    const lines = page.items.length === 0
      ? ['No agent secret exposure.']
      : page.items.map((e) => {
        const where = [e.projectKey, e.hostLabel, e.harness].filter(Boolean).join(', ');
        const credential = e.credentialKey ? ` - matches ${e.credentialKey}, due for rotation` : '';
        const state = e.state === 'resolved' ? ` - resolved: ${e.resolutionNote ?? ''}` : ' - open';
        return `${e.createdAt} ${e.class} (${e.preview}, ${e.length} chars) in ${e.toolName} output of ${e.reporterName ?? 'unknown'} [${where}]${credential}${state} (id ${e.id})`;
      });
    if (page.nextCursor) lines.push(`More: cursor ${page.nextCursor}`);
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { items: page.items, nextCursor: page.nextCursor },
    };
  };
}

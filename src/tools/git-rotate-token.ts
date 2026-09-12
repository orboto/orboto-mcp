/**
 * ORB-2112 - `orboto_git_rotate_token`.
 *
 * Replace the credential a project's git connection uses. orboto probes
 * the provider with the new one first, so a bad paste leaves the working
 * credential in place and the connection id, its activities and issue
 * links untouched.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';
import { resolveProjectByKey } from './shared.js';

interface RotateResponse {
  rotated: true;
  health: {
    connectionId: string;
    name: string;
    healthy: boolean;
    tokenState: 'ok' | 'unauthorized' | 'unknown';
    unhealthySince: string | null;
    reason: string | null;
  };
  webhookUrl?: string;
  webhookAutoInstalled?: boolean;
  webhookInstallError?: string | null;
}

export const gitRotateTokenToolConfig = {
  title: 'Rotate a git connection\'s access token',
  description:
    'Replace the access token (or, for an ssh-poll connection, the private key) a project\'s git connection authenticates with. The provider is probed with the NEW credential before anything is stored: on success it is re-sealed and the connection\'s health resets to ok without a new connection id; on failure the call returns 422 and the old credential stays in place. Pass reinstallWebhook to also reinstall the provider hook on the configured public URL. Use this when git health reports tokenState "unauthorized" / reason "token_rejected". A connection that mints its own tokens (GitHub App installation or GitLab OAuth) has no stored credential and returns 422 - re-run its install flow instead.',
  inputSchema: z.object({
    projectKey: z.string().min(1).describe('Project key, e.g. ORB.'),
    connectionId: z.string().uuid().describe('Git connection id, from GET /projects/:projectId/git-connections or git health.'),
    accessToken: z.string().min(1).optional().describe('The new access token. Required for every provider except ssh.'),
    privateKey: z.string().min(1).optional().describe('The new SSH private key. Only for an ssh-poll connection.'),
    reinstallWebhook: z.boolean().optional().describe('Also delete the provider hook and install a fresh one on the configured public URL (ORB-2110).'),
  }).shape,
  outputSchema: z.object({
    connectionId: z.string(),
    name: z.string(),
    healthy: z.boolean(),
    tokenState: z.enum(['ok', 'unauthorized', 'unknown']),
    reason: z.string().nullable(),
    webhookUrl: z.string().optional(),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};

export function makeGitRotateTokenHandler(client: OrbotoClient) {
  return async (args: {
    projectKey: string;
    connectionId: string;
    accessToken?: string;
    privateKey?: string;
    reinstallWebhook?: boolean;
  }): Promise<CallToolResult> => {
    if ((args.accessToken ? 1 : 0) + (args.privateKey ? 1 : 0) !== 1) {
      throw new Error('Pass exactly one of accessToken or privateKey.');
    }
    const project = await resolveProjectByKey(client, args.projectKey);
    const res = await client.post<RotateResponse>(
      `/projects/${project.id}/git-connections/${args.connectionId}/rotate-token`,
      {
        ...(args.accessToken ? { accessToken: args.accessToken } : {}),
        ...(args.privateKey ? { privateKey: args.privateKey } : {}),
        ...(args.reinstallWebhook ? { reinstallWebhook: true } : {}),
      },
    );
    const lines = [
      `Rotated the credential on "${res.health.name}" (${res.health.connectionId}).`,
      `Token state: ${res.health.tokenState}; healthy: ${res.health.healthy}${res.health.reason ? ` (${res.health.reason})` : ''}.`,
    ];
    if (res.webhookUrl) {
      lines.push(`Webhook ${res.webhookAutoInstalled ? 'reinstalled on' : 'install failed for'} ${res.webhookUrl}${res.webhookInstallError ? ` - ${res.webhookInstallError}` : ''}.`);
    }
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: {
        connectionId: res.health.connectionId,
        name: res.health.name,
        healthy: res.health.healthy,
        tokenState: res.health.tokenState,
        reason: res.health.reason,
        ...(res.webhookUrl ? { webhookUrl: res.webhookUrl } : {}),
      },
    };
  };
}

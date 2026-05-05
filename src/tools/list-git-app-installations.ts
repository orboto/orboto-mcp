/**
 * ORB-320 — `orboto_list_git_app_installations`.
 *
 * Returns every GitHub App installation Orboto knows about. Wraps
 * `GET /admin/git-app-installations` (super-admin only on the API
 * side; a 403 here means the caller's API key isn't super-admin).
 *
 * Useful for agents triaging "is my repo connected?" questions
 * without paging through Project Settings → Git in every project.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';

interface InstallationRow {
  id: string;
  provider: string;
  installationId: string;
  accountLogin: string;
  accountType: string;
  installedAt: string;
  suspendedAt: string | null;
}

export const listGitAppInstallationsToolConfig = {
  title: 'List GitHub App installations',
  description:
    'Return every GitHub App installation Orboto knows about (across all projects). Requires super-admin on the API side. Each row carries the org/user the App is installed on, when it was installed, and whether it is currently suspended.',
  inputSchema: z.object({}).shape,
  outputSchema: z.object({
    installations: z.array(z.object({
      provider: z.string(),
      accountLogin: z.string(),
      accountType: z.string(),
      installedAt: z.string(),
      suspended: z.boolean(),
    })),
  }).shape,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
  },
};

export function makeListGitAppInstallationsHandler(client: OrbotoClient) {
  return async (): Promise<CallToolResult> => {
    const rows = await client.get<InstallationRow[]>('/admin/git-app-installations');
    const out = rows.map((r) => ({
      provider: r.provider,
      accountLogin: r.accountLogin,
      accountType: r.accountType,
      installedAt: r.installedAt,
      suspended: r.suspendedAt !== null,
    }));
    const text = out.length === 0
      ? 'No GitHub App installations registered.'
      : out.map((r) => `- ${r.accountLogin} (${r.accountType}) — installed ${r.installedAt}${r.suspended ? ' — SUSPENDED' : ''}`).join('\n');
    return {
      content: [{ type: 'text', text }],
      structuredContent: { installations: out },
    };
  };
}

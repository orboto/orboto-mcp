/**
 * ORB-799 — identity / debug tools.
 *
 * `orboto_whoami` — return the authenticated principal as `{id, email,
 * fullName, isBot}`. Mirrors `orboto.mjs whoami`. The wrapper hits the
 * existing `/users/me` route directly; we do the same so a stale-token
 * 401 surfaces the same way it does for every other tool.
 *
 * Useful for debugging "which API key is this session actually using?",
 * which is the most common confusion when an agent has multiple MCP
 * configs (`claude-desktop`, `cursor`, `gemini-cli`) wired to different
 * `orb_*` keys.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';

interface UserRow {
  id: string;
  email: string;
  fullName: string | null;
  isBot?: boolean;
  isActive?: boolean;
  isExternal?: boolean;
  // ORB-989 — workspace's expected content language, echoed on
  // /users/me so an agent learns the language to write tickets in
  // before its first write.
  workspaceLocale?: string;
}

export const whoamiToolConfig = {
  title: 'Show the authenticated MCP principal',
  description:
    'Return the authenticated user record `{id, email, fullName, isBot, workspaceLocale}` corresponding to the API key this MCP server is running with. Useful for debugging which credential / bot identity is in use when multiple MCP configs are wired to different `orb_*` keys. **`workspaceLocale` (ORB-989)** is the language the workspace expects tickets / comments / docs in — check it before a mass-create so you write in the right language from the start instead of relying on the after-the-fact language-mismatch warning.',
  inputSchema: z.object({}).shape,
  outputSchema: z.object({
    id: z.string(),
    email: z.string(),
    fullName: z.string().nullable(),
    isBot: z.boolean(),
    workspaceLocale: z.string().nullable(),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeWhoamiHandler(client: OrbotoClient) {
  return async (): Promise<CallToolResult> => {
    const me = await client.get<UserRow>('/users/me');
    const isBot = me.isBot === true;
    const workspaceLocale = me.workspaceLocale ?? null;
    const lines = [
      `${me.fullName ?? '(no name)'} <${me.email}>`,
      `  id: ${me.id}`,
      `  bot: ${isBot ? 'yes' : 'no'}`,
    ];
    if (workspaceLocale) {
      lines.push(`  workspace language: ${workspaceLocale} (write tickets in this language)`);
    }
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: {
        id: me.id,
        email: me.email,
        fullName: me.fullName ?? null,
        isBot,
        workspaceLocale,
      },
    };
  };
}

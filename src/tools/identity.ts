/**
 * ORB-799 - identity / debug tools.
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
  workspaceLocale?: string;
  actingAuthorizedBy?: { id: string; email: string; fullName: string } | null;
  agentSession?: { id: string; label: string; harness: string | null; pid: number | null; foreign: boolean } | null;
}

export const whoamiToolConfig = {
  title: 'Show the authenticated MCP principal',
  description:
    'Return the authenticated user record `{id, email, fullName, isBot, workspaceLocale}` for the API key this server runs with. Useful for debugging which credential / bot identity is in use when multiple MCP configs are wired to different `orb_*` keys. **`workspaceLocale` (ORB-989)** is the language the workspace expects tickets / comments / docs in - check it before a mass-create so you write in the right language from the start instead of relying on the after-the-fact language-mismatch warning. **`agentSession` (ORB-2550)** is the agent session every write of this connection is attributed to, null when the server knows none for its instance token; `foreign: true` means another harness process owns it, so writes carry no session and timers and work sessions are refused until this process has an instance token (`ORBOTO_AGENT_SESSION`) or a profile of its own.',
  inputSchema: z.object({}).shape,
  outputSchema: z.object({
    id: z.string(),
    email: z.string(),
    fullName: z.string().nullable(),
    isBot: z.boolean(),
    workspaceLocale: z.string().nullable(),
    actingAuthorizedBy: z.object({ id: z.string(), email: z.string(), fullName: z.string() }).nullable(),
    agentSession: z.object({ id: z.string(), label: z.string(), harness: z.string().nullable(), pid: z.number().nullable(), foreign: z.boolean() }).nullable(),
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
    if (me.actingAuthorizedBy) {
      lines.push(`  acting as this bot, authorised by: ${me.actingAuthorizedBy.fullName} <${me.actingAuthorizedBy.email}>`);
    }
    const session = me.agentSession ?? null;
    if (session) {
      lines.push(`  session: ${session.id} (${session.label})${session.foreign ? ` - owned by ${session.harness ?? 'unknown'} pid ${session.pid ?? 0}, another process: writes carry no session, timers and work sessions are refused; give this process an instance token of its own (ORBOTO_AGENT_SESSION=<own value>) or its own identity (orboto profile bind <harness> <profile>); after a restart of the same harness, orboto session-start registers the row again` : ''}`);
    } else {
      lines.push('  session: none - the server knows no session for this connection\'s instance token yet');
    }
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: {
        id: me.id,
        email: me.email,
        fullName: me.fullName ?? null,
        isBot,
        workspaceLocale,
        actingAuthorizedBy: me.actingAuthorizedBy ?? null,
        agentSession: session,
      },
    };
  };
}

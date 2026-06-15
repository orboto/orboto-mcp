/**
 * ORB-1089 — MCP tools to manage the configurable coding-agent
 * working-rule blocks. Mirrors the REST CRUD (admin:ai:read/write
 * gated server-side; a 403 means the caller's key lacks the slug).
 * Part of the 4-way sync (REST + MCP + skill + in-app chat).
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';

interface BlockRow {
  id: string;
  builtinKey: string | null;
  title: string;
  body: string;
  enabled: boolean;
  sortOrder: number;
}

function renderBlock(b: BlockRow): string {
  const flag = b.enabled ? '' : ' [disabled]';
  const kind = b.builtinKey ? `default:${b.builtinKey}` : 'custom';
  return `- ${b.title}${flag}  (${kind}, id ${b.id})\n  ${b.body}`;
}

export const listAgentInstructionsToolConfig = {
  title: 'List the workspace coding-agent rule blocks',
  description:
    'List the configurable working-rule blocks that govern how external coding agents work with orboto (claim->commit->close etc.), plus the assembled text agents actually receive. Needs admin:ai:read. To READ the rules to follow as an agent (not manage them) just read the MCP server instructions / run the session-start command instead.',
  inputSchema: z.object({}).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeListAgentInstructionsHandler(client: OrbotoClient) {
  return async (): Promise<CallToolResult> => {
    const res = await client.get<{ blocks: BlockRow[]; assembled: string }>('/admin/agent-instructions');
    const text = res.blocks.length
      ? res.blocks.map(renderBlock).join('\n')
      : 'No rule blocks configured.';
    return {
      content: [{ type: 'text', text }],
      structuredContent: { blocks: res.blocks, assembled: res.assembled },
    };
  };
}

export const createAgentInstructionToolConfig = {
  title: 'Add a custom coding-agent rule block',
  description:
    'Create a custom working-rule block for coding agents. Needs admin:ai:write. Appends at the end by default; pass sortOrder to place it.',
  inputSchema: z.object({
    title: z.string().min(1).max(120),
    body: z.string().min(1).max(8000).describe('The rule text the agent should follow.'),
    enabled: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
  }).shape,
  annotations: {},
};

export function makeCreateAgentInstructionHandler(client: OrbotoClient) {
  return async (input: { title: string; body: string; enabled?: boolean; sortOrder?: number }): Promise<CallToolResult> => {
    const row = await client.post<BlockRow>('/admin/agent-instructions', input);
    return { content: [{ type: 'text', text: `Created rule block "${row.title}" (id ${row.id}).` }], structuredContent: row as unknown as Record<string, unknown> };
  };
}

export const updateAgentInstructionToolConfig = {
  title: 'Edit / toggle / reorder a coding-agent rule block',
  description:
    'Patch a rule block: title, body, enabled (toggle a rule on/off), or sortOrder. Works on default AND custom blocks (defaults keep their builtinKey and can be reset later). Needs admin:ai:write.',
  inputSchema: z.object({
    id: z.string().uuid(),
    title: z.string().min(1).max(120).optional(),
    body: z.string().min(1).max(8000).optional(),
    enabled: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
  }).shape,
  annotations: { idempotentHint: true },
};

export function makeUpdateAgentInstructionHandler(client: OrbotoClient) {
  return async (input: { id: string; title?: string; body?: string; enabled?: boolean; sortOrder?: number }): Promise<CallToolResult> => {
    const { id, ...patch } = input;
    const row = await client.patch<BlockRow>(`/admin/agent-instructions/${id}`, patch);
    return { content: [{ type: 'text', text: `Updated rule block "${row.title}" (enabled: ${row.enabled}).` }], structuredContent: row as unknown as Record<string, unknown> };
  };
}

export const resetAgentInstructionToolConfig = {
  title: 'Reset a default rule block to its shipped text',
  description:
    'Restore a seeded DEFAULT rule block (one with a builtinKey) to the text orboto ships. No-op for custom blocks. Needs admin:ai:write.',
  inputSchema: z.object({ id: z.string().uuid() }).shape,
  annotations: { idempotentHint: true },
};

export function makeResetAgentInstructionHandler(client: OrbotoClient) {
  return async (input: { id: string }): Promise<CallToolResult> => {
    const row = await client.post<BlockRow>(`/admin/agent-instructions/${input.id}/reset`, {});
    return { content: [{ type: 'text', text: `Reset rule block "${row.title}" to its default text.` }], structuredContent: row as unknown as Record<string, unknown> };
  };
}

export const deleteAgentInstructionToolConfig = {
  title: 'Delete a custom coding-agent rule block',
  description:
    'Delete a CUSTOM rule block. Default (builtin) blocks cannot be deleted — disable them via update instead. Needs admin:ai:write.',
  inputSchema: z.object({ id: z.string().uuid() }).shape,
  annotations: { destructiveHint: true },
};

export function makeDeleteAgentInstructionHandler(client: OrbotoClient) {
  return async (input: { id: string }): Promise<CallToolResult> => {
    await client.delete(`/admin/agent-instructions/${input.id}`);
    return { content: [{ type: 'text', text: `Deleted rule block ${input.id}.` }], structuredContent: { id: input.id, deleted: true } };
  };
}

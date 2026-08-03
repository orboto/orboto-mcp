/**
 * ORB-1089 — MCP tools to manage the configurable coding-agent
 * working-rule blocks. Mirrors the REST CRUD (admin:ai:read/write
 * gated server-side; a 403 means the caller's key lacks the slug).
 * Part of the 4-way sync (REST + MCP + skill + in-app chat).
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';
import { sizeBlockResult } from './shared.js';

interface BlockRow {
  id: string;
  builtinKey: string | null;
  title: string;
  body: string;
  enabled: boolean;
  sortOrder: number;
  sizeWarning?: { chars: number; limit: number; hint: string };
}

// ORB-1819 - the writing contract, verbatim in every write-tool
// description so the writing agent sees it at the moment of writing.
const RULE_WRITING_CONTRACT =
  ' Rule: title = one imperative sentence; body <= 400 chars, Rule / Why / How, no long examples, nothing another block says.';

// ORB-1700 - a LIST answers "what exists"; the body belongs to the
// follow-up read (blockId input below). First line, hard-capped.
function excerptOf(body: string): string {
  const firstLine = body.split('\n', 1)[0] ?? '';
  return firstLine.length > 200 ? `${firstLine.slice(0, 199)}\u2026` : firstLine;
}

function renderBlock(b: BlockRow): string {
  const flag = b.enabled ? '' : ' [disabled]';
  const kind = b.builtinKey ? `default:${b.builtinKey}` : 'custom';
  return `- ${b.title}${flag}  (${kind}, ${b.body.length} chars, id ${b.id})\n  ${excerptOf(b.body)}`;
}

export const listAgentInstructionsToolConfig = {
  title: 'MANAGE the workspace coding-agent rule blocks (admin)',
  description:
    'ADMIN/MANAGEMENT tool — lists the individual rule BLOCKS at a scope (workspace: needs admin:ai:read; project: needs project:edit; personal: your own) so they can be edited/toggled/reordered. This is NOT how you read the rules to follow. To LOAD the rules you must follow as an agent, call orboto_session_start instead — it returns the complete assembled rule set.',
  inputSchema: z.object({
    scope: z.enum(['workspace', 'customer', 'project', 'personal']).default('workspace'),
    projectId: z.string().uuid().optional().describe('Required for scope=project.'),
    customerId: z.string().uuid().optional().describe('Required for scope=customer.'),
    blockId: z.string().uuid().optional().describe('Return THIS block with its full body (ORB-1700). Without it the list carries excerpts + contentChars only.'),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

function scopeQs(scope: string, projectId?: string, customerId?: string): string {
  const p = new URLSearchParams({ scope });
  if (projectId) p.set('projectId', projectId);
  if (customerId) p.set('customerId', customerId);
  return p.toString();
}

export function makeListAgentInstructionsHandler(client: OrbotoClient) {
  return async (input: { scope?: string; projectId?: string; customerId?: string; blockId?: string } = {}): Promise<CallToolResult> => {
    const res = await client.get<{ blocks: BlockRow[]; assembled: string }>(`/agent-instructions/blocks?${scopeQs(input.scope ?? 'workspace', input.projectId, input.customerId)}`);

    // ORB-1700 - full body for ONE explicitly named block, in one call.
    if (input.blockId) {
      const block = res.blocks.find((b) => b.id === input.blockId);
      if (!block) {
        return {
          content: [{ type: 'text', text: `No rule block with id ${input.blockId} at this scope.` }],
          structuredContent: { block: null },
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: `# ${block.title}${block.enabled ? '' : ' [disabled]'}\n\n${block.body}` }],
        structuredContent: { block },
      };
    }

    // ORB-1700 - list = metadata + excerpt. The assembled 24k rule text is
    // NOT re-shipped here (it rode along on every management call and cost
    // 238 Mtok over 3 calls); agents load the rules via orboto_session_start.
    const text = res.blocks.length
      ? res.blocks.map(renderBlock).join('\n')
      : 'No rule blocks configured.';
    return {
      content: [{ type: 'text', text }],
      structuredContent: {
        // Array order = sortOrder; builtinKey only when it is one; the
        // descriptive TITLE is the excerpt (bodies via blockId).
        blocks: res.blocks.map((b) => ({
          id: b.id,
          title: b.title,
          enabled: b.enabled,
          contentChars: b.body.length,
          ...(b.builtinKey ? { builtinKey: b.builtinKey } : {}),
        })),
        bodyHint: 'Full body of one block: re-call with blockId. The assembled agent-facing rule set comes from orboto_session_start.',
      },
    };
  };
}

export const createAgentInstructionToolConfig = {
  title: 'Add a custom coding-agent rule block',
  description:
    'Create a custom rule block at a scope: workspace (every agent; admin:ai:write), customer (every project of one customer; customer:write), project (one project; project:edit), or personal (your own). For scope=customer pass customerId; for scope=project pass projectId.'
    + RULE_WRITING_CONTRACT,
  inputSchema: z.object({
    title: z.string().min(1).max(120),
    body: z.string().min(1).max(8000).describe('The rule text the agent should follow.'),
    scope: z.enum(['workspace', 'customer', 'project', 'personal']).default('workspace'),
    projectId: z.string().uuid().optional().describe('Required for scope=project.'),
    customerId: z.string().uuid().optional().describe('Required for scope=customer.'),
    enabled: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
    allowOversize: z.boolean().optional().describe('Override the hard size-cap block (400*2 chars). Only after a call was blocked.'),
    oversizeReason: z.string().min(10).max(500).optional().describe('Required with allowOversize=true - why this body genuinely needs the length. Audit-logged.'),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};

export function makeCreateAgentInstructionHandler(client: OrbotoClient) {
  return async (input: {
    title: string; body: string; scope?: string; projectId?: string; customerId?: string; enabled?: boolean; sortOrder?: number;
    allowOversize?: boolean; oversizeReason?: string;
  }): Promise<CallToolResult> => {
    const { scope, projectId, customerId, ...body } = input;
    let row: BlockRow;
    try {
      row = await client.post<BlockRow>(`/agent-instructions/blocks?${scopeQs(scope ?? 'workspace', projectId, customerId)}`, body);
    } catch (err) {
      const blocked = sizeBlockResult(err, 'Rule block create');
      if (blocked) return blocked;
      throw err;
    }
    const warn = row.sizeWarning ? `\n⚠ ${row.body.length} chars, over the ${row.sizeWarning.limit}-char soft limit. ${row.sizeWarning.hint}` : '';
    return { content: [{ type: 'text', text: `Created rule block "${row.title}" (id ${row.id}).${warn}` }], structuredContent: row as unknown as Record<string, unknown> };
  };
}

export const updateAgentInstructionToolConfig = {
  title: 'Edit / toggle / reorder a coding-agent rule block',
  description:
    'Patch a rule block: title, body, enabled (toggle a rule on/off), or sortOrder. Works on default AND custom blocks (defaults keep their builtinKey and can be reset later). Needs admin:ai:write.'
    + RULE_WRITING_CONTRACT,
  inputSchema: z.object({
    id: z.string().uuid(),
    title: z.string().min(1).max(120).optional(),
    body: z.string().min(1).max(8000).optional(),
    enabled: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
    allowOversize: z.boolean().optional().describe('Override the hard size-cap block (400*2 chars). Only after a call was blocked.'),
    oversizeReason: z.string().min(10).max(500).optional().describe('Required with allowOversize=true - why this body genuinely needs the length. Audit-logged.'),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
};

export function makeUpdateAgentInstructionHandler(client: OrbotoClient) {
  return async (input: {
    id: string; title?: string; body?: string; enabled?: boolean; sortOrder?: number;
    allowOversize?: boolean; oversizeReason?: string;
  }): Promise<CallToolResult> => {
    const { id, ...patch } = input;
    let row: BlockRow;
    try {
      row = await client.patch<BlockRow>(`/agent-instructions/blocks/${id}`, patch);
    } catch (err) {
      const blocked = sizeBlockResult(err, 'Rule block update');
      if (blocked) return blocked;
      throw err;
    }
    const warn = row.sizeWarning ? `\n⚠ ${row.body.length} chars, over the ${row.sizeWarning.limit}-char soft limit. ${row.sizeWarning.hint}` : '';
    return { content: [{ type: 'text', text: `Updated rule block "${row.title}" (enabled: ${row.enabled}).${warn}` }], structuredContent: row as unknown as Record<string, unknown> };
  };
}

export const resetAgentInstructionToolConfig = {
  title: 'Reset a default rule block to its shipped text',
  description:
    'Restore a seeded DEFAULT rule block (one with a builtinKey) to the text orboto ships. No-op for custom blocks. Needs admin:ai:write.',
  inputSchema: z.object({ id: z.string().uuid() }).shape,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
};

export function makeResetAgentInstructionHandler(client: OrbotoClient) {
  return async (input: { id: string }): Promise<CallToolResult> => {
    const row = await client.post<BlockRow>(`/agent-instructions/blocks/${input.id}/reset`, {});
    return { content: [{ type: 'text', text: `Reset rule block "${row.title}" to its default text.` }], structuredContent: row as unknown as Record<string, unknown> };
  };
}

export const deleteAgentInstructionToolConfig = {
  title: 'Delete a custom coding-agent rule block',
  description:
    'Delete a CUSTOM rule block. Default (builtin) blocks cannot be deleted — disable them via update instead. Needs admin:ai:write.',
  inputSchema: z.object({ id: z.string().uuid() }).shape,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
};

export function makeDeleteAgentInstructionHandler(client: OrbotoClient) {
  return async (input: { id: string }): Promise<CallToolResult> => {
    await client.delete(`/agent-instructions/blocks/${input.id}`);
    return { content: [{ type: 'text', text: `Deleted rule block ${input.id}.` }], structuredContent: { id: input.id, deleted: true } };
  };
}

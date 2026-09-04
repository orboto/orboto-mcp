/**
 * ORB-862 (LLM-Wiki Phase L) - personal AI-preference facts.
 *
 * The caller's OWN personal primer facts (communication style, coding
 * conventions, domain self-description). Privacy-strict: every route is
 * owner-scoped server-side, so these tools can only ever touch the
 * authenticated user's own facts - never another user's. English-only.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';

interface PersonalFact { id: string; category: string; key: string; value: string }
function text(t: string, structured?: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: t }], ...(structured ? { structuredContent: structured } : {}) };
}

const CATEGORY = z.enum(['tech_stack', 'conventions', 'deployment', 'architecture', 'integrations', 'gotchas', 'commands', 'other']);

export const personalFactListToolConfig = {
  title: 'List my personal AI preferences',
  description: 'List the calling user\'s own personal primer facts (their AI preferences). Privacy-strict - only your own facts, never another user\'s. These load into the project primer for your sessions only when you have enabled the opt-in in Profile -> AI Preferences. Wraps GET /users/me/primer-facts.',
  inputSchema: z.object({}).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};
export function makePersonalFactListHandler(client: OrbotoClient) {
  return async (): Promise<CallToolResult> => {
    const facts = await client.get<PersonalFact[]>('/users/me/primer-facts');
    const body = facts.length === 0 ? 'No personal preferences set.' : facts.map((f) => `- [${f.category}] ${f.key}: ${f.value}`).join('\n');
    return text(body, { facts });
  };
}

export const personalFactAddToolConfig = {
  title: 'Add a personal AI preference',
  description: 'Record a personal primer fact for the calling user (e.g. communication style, coding convention). Owner-scoped. Wraps POST /users/me/primer-facts.',
  inputSchema: z.object({
    category: CATEGORY.describe('Closest category (e.g. conventions for communication/coding style).'),
    key: z.string().min(1).max(100).describe('Short machine-readable key, e.g. "tone".'),
    value: z.string().min(1).max(4000),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};
export function makePersonalFactAddHandler(client: OrbotoClient) {
  return async (input: { category: string; key: string; value: string }): Promise<CallToolResult> => {
    const row = await client.post<PersonalFact>('/users/me/primer-facts', input);
    return text(`Added personal preference "${row.key}" (id: ${row.id}).`, { id: row.id });
  };
}

export const personalFactUpdateToolConfig = {
  title: 'Update a personal AI preference',
  description: 'Update one of the calling user\'s personal primer facts. Owner-scoped - you can only edit your own. Wraps PATCH /users/me/primer-facts/:id.',
  inputSchema: z.object({
    id: z.string().uuid(),
    category: CATEGORY.optional(),
    key: z.string().min(1).max(100).optional(),
    value: z.string().min(1).max(4000).optional(),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};
export function makePersonalFactUpdateHandler(client: OrbotoClient) {
  return async (input: { id: string; category?: string; key?: string; value?: string }): Promise<CallToolResult> => {
    const { id, ...body } = input;
    const row = await client.patch<PersonalFact>(`/users/me/primer-facts/${id}`, body);
    return text(`Updated personal preference "${row.key}".`, { id: row.id });
  };
}

export const personalFactDeleteToolConfig = {
  title: 'Delete a personal AI preference',
  description: 'Delete one of the calling user\'s personal primer facts. Owner-scoped. Wraps DELETE /users/me/primer-facts/:id.',
  inputSchema: z.object({ id: z.string().uuid() }).shape,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
};
export function makePersonalFactDeleteHandler(client: OrbotoClient) {
  return async (input: { id: string }): Promise<CallToolResult> => {
    await client.delete(`/users/me/primer-facts/${input.id}`);
    return text('Deleted.', { deleted: true });
  };
}

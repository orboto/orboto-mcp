/** ORB-2225 - the wiki as the agents' knowledge base: ask it first, file durable facts in it. */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';
import { mcpInstanceToken } from './shared.js';
import { droppedLines, type DroppedOp } from './wiki.js';

interface Citation { index: number; title: string; link: string }
interface SpaceRef { spaceKey: string | null; spaceName: string; projectKey: string | null }
interface AskResponse { answer: string; citations: Citation[]; mode: string; abstained: boolean; source: string; spaces: SpaceRef[] }
interface AddResponse { action: 'recorded' | 'ingesting'; text: string; pages: Array<{ key: string | null; title: string; webUrl: string }>; source: { key: string | null; title: string; webUrl: string } | null; droppedOps?: DroppedOp[] }

type Extra = { sessionId?: string } | undefined;

export const knowledgeAskToolConfig = {
  title: 'Ask the wiki',
  description: 'Ask your session\'s project wikis and the Operations wiki before asking a person; cite docs by key.',
  inputSchema: z.object({ question: z.string().min(3).max(1000), projectKeys: z.array(z.string().min(1).max(32)).max(20).optional() }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeKnowledgeAskHandler(client: OrbotoClient) {
  return async (input: { question: string; projectKeys?: string[] }, extra?: unknown): Promise<CallToolResult> => {
    const res = await client.post<AskResponse>('/knowledge/ask', input, { instanceToken: mcpInstanceToken(undefined, extra as Extra) });
    const where = res.spaces.map((s) => s.spaceKey ?? s.spaceName).join(', ');
    const cites = res.citations.map((c) => `[${c.index}] ${c.title} - ${c.link}`).join('\n');
    return {
      content: [{ type: 'text', text: [res.answer, cites ? `Sources:\n${cites}` : '', `Asked: ${where}.`].filter(Boolean).join('\n\n') }],
      structuredContent: res as unknown as Record<string, unknown>,
    };
  };
}

export const knowledgeAddToolConfig = {
  title: 'File a fact in the wiki',
  description: 'File a durable fact in a project wiki (projectKey) or the Operations wiki, never only in local memory.',
  inputSchema: z.object({
    title: z.string().min(1).max(200), content: z.string().min(1).max(50_000),
    projectKey: z.string().min(1).max(32).optional(), operations: z.boolean().optional(),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};

export function makeKnowledgeAddHandler(client: OrbotoClient) {
  return async (
    input: { title: string; content: string; projectKey?: string; operations?: boolean },
    extra?: unknown,
  ): Promise<CallToolResult> => {
    const res = await client.post<AddResponse>('/knowledge/add', input, { instanceToken: mcpInstanceToken(undefined, extra as Extra) });
    return { content: [{ type: 'text', text: `${res.text}${droppedLines(res.droppedOps ?? [])}` }], structuredContent: res as unknown as Record<string, unknown> };
  };
}

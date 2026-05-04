/**
 * ORB-564 — `orbit_ai_status`.
 *
 * Pre-flight check for agents: is the workspace's AI provider configured?
 * Wraps `GET /ai/status`. Two flags come back — chat features and
 * embeddings — because Anthropic-only deployments have chat fully
 * wired but cannot produce embeddings, and RAG-style features
 * (`ask-docs`, similar-tickets rerank, partial-overlap detection)
 * need both.
 *
 * Today no MCP tool requires AI directly — every `orbit_*` tool is a
 * thin REST wrapper that does its own thing. The dependency lives on
 * the skill side (`orbit ask-docs`) and on chat-only LLM calls the
 * agent host might make. This tool exists so an agent can plan around
 * the workspace shape before calling those skill shortcuts or before
 * suggesting AI-gated features to the operator.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbitClient } from '../orbit-client.js';

interface AiStatusResponse {
  configured: boolean;
  embeddingsConfigured: boolean;
}

export const aiStatusToolConfig = {
  title: 'Check whether the Orbit workspace has AI configured',
  description:
    'Pre-flight check for AI-gated operations. Returns two flags: `configured` (chat / completion provider set up — required by `ask-docs`, summarisation, ticket polish, suggest-title, suggest-priority, suggest-labels, translate, NL search, retro generation, daily digest, milestone risk, ticket split) and `embeddingsConfigured` (embedding provider set up — required by RAG features like `ask-docs` and similar-tickets rerank). Anthropic-only deployments return `{ configured: true, embeddingsConfigured: false }` because Anthropic does not produce embeddings. Call this before invoking AI-gated skill shortcuts so you can plan around a workspace that has AI disabled.',
  inputSchema: z.object({}).shape,
  outputSchema: z.object({
    configured: z.boolean(),
    embeddingsConfigured: z.boolean(),
  }).shape,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
  },
};

export function makeAiStatusHandler(client: OrbitClient) {
  return async (): Promise<CallToolResult> => {
    const status = await client.get<AiStatusResponse>('/ai/status');
    const lines: string[] = [];
    lines.push(`Chat / completion AI: ${status.configured ? 'configured' : 'NOT configured'}`);
    lines.push(`Embeddings: ${status.embeddingsConfigured ? 'configured' : 'NOT configured'}`);
    if (!status.configured) {
      lines.push('');
      lines.push('AI-gated operations (skill `ask-docs`, summarisation, suggest-*, etc.) will fail with a 400 until the workspace operator configures an AI provider in Admin → AI Settings.');
    } else if (!status.embeddingsConfigured) {
      lines.push('');
      lines.push('RAG features (`ask-docs`, similar-tickets rerank, partial-overlap detection) need an embedding-capable provider — Anthropic-only setups do not have one.');
    }
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: {
        configured: status.configured,
        embeddingsConfigured: status.embeddingsConfigured,
      },
    };
  };
}

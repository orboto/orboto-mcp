/**
 * ORB-564 - `orboto_ai_status`.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';

interface AiStatusResponse {
  configured: boolean;
  embeddingsConfigured: boolean;
  visionEnabled?: boolean;
}

export const aiStatusToolConfig = {
  title: 'Check whether the orboto workspace has AI configured',
  description:
    'Pre-flight check for AI-gated operations. Returns two flags: `configured` (chat / completion provider set up - required by `ask-docs`, summarisation, ticket polish, suggest-title, suggest-priority, suggest-labels, translate, NL search, retro generation, daily digest, milestone risk, ticket split) and `embeddingsConfigured` (embedding provider set up - required by RAG features like `ask-docs` and similar-tickets rerank), plus `visionEnabled` (image attachments allowed in AI calls - the `ai_vision_enabled` workspace toggle). Anthropic-only deployments return `embeddingsConfigured: false` because Anthropic does not produce embeddings. Call this before invoking AI-gated skill shortcuts so you can plan around a workspace that has AI disabled.',
  inputSchema: z.object({}).shape,
  outputSchema: z.object({
    configured: z.boolean(),
    embeddingsConfigured: z.boolean(),
    visionEnabled: z.boolean(),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeAiStatusHandler(client: OrbotoClient) {
  return async (): Promise<CallToolResult> => {
    const status = await client.get<AiStatusResponse>('/ai/status');
    const visionEnabled = status.visionEnabled ?? false;
    const lines: string[] = [];
    lines.push(`Chat / completion AI: ${status.configured ? 'configured' : 'NOT configured'}`);
    lines.push(`Embeddings: ${status.embeddingsConfigured ? 'configured' : 'NOT configured'}`);
    lines.push(`Vision (image attachments): ${visionEnabled ? 'enabled' : 'disabled'}`);
    if (!status.configured) {
      lines.push('');
      lines.push('AI-gated operations (skill `ask-docs`, summarisation, suggest-*, etc.) will fail with a 400 until the workspace operator configures an AI provider in Admin → AI Settings.');
    } else if (!status.embeddingsConfigured) {
      lines.push('');
      lines.push('RAG features (`ask-docs`, similar-tickets rerank, partial-overlap detection) need an embedding-capable provider - Anthropic-only setups do not have one.');
    }
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: {
        configured: status.configured,
        embeddingsConfigured: status.embeddingsConfigured,
        visionEnabled,
      },
    };
  };
}

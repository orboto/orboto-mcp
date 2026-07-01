/**
 * ORB-1309 — `orboto_embedding_status`.
 *
 * Operator diagnostic for the embedding pipeline: provider/model/dims, coverage
 * (embedded vs total, and how many are PENDING — never-embedded / stale — per
 * tickets / comments / docs and overall), the circuit-breaker state, and when
 * the last embedding was written. Wraps GET /admin/ai/embedding-status.
 *
 * `orboto_ai_status` only reports whether embeddings are configured; this is the
 * deeper surface for "why is semantic search / duplicate detection / ask-docs
 * stale" — a tripped breaker, a stuck queue, or a provider that stopped
 * responding. Admin:ai:read gated (403 for non-admin callers).
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';

interface EmbeddingStatusResponse {
  configured: boolean;
  provider: string | null;
  model: string | null;
  dimensions: number;
  coverage: {
    ticket: { embedded: number; total: number };
    comment: { embedded: number; total: number };
    doc: { embedded: number; total: number };
    overall: { embedded: number; total: number; pending: number };
  };
  breaker: { tripped: boolean; trippedUntil: string | null; consecutiveFailures: number; lastTrippedReason: string | null };
  lastEmbeddedAt: string | null;
}

export const embeddingStatusToolConfig = {
  title: 'Embedding pipeline status (coverage + circuit breaker)',
  description:
    'Operator diagnostic for AI search / embeddings. Returns the configured provider/model + vector dimensions, coverage (embedded vs total, and how many are PENDING — never-embedded / stale — per tickets / comments / docs and overall), the circuit-breaker state (tripped + reason + consecutive failures), and when the last embedding was written. Use this to diagnose why semantic search / duplicate detection / ask-docs are stale or empty — e.g. a tripped breaker, a stuck queue, or a provider that stopped responding. Deeper than orboto_ai_status (which only says whether embeddings are configured). Requires admin:ai:read — returns 403 for non-admin callers.',
  inputSchema: z.object({}).shape,
  outputSchema: z.object({
    configured: z.boolean(),
    provider: z.string().nullable(),
    model: z.string().nullable(),
    dimensions: z.number(),
    embedded: z.number(),
    total: z.number(),
    pending: z.number(),
    breakerTripped: z.boolean(),
    breakerReason: z.string().nullable(),
    lastEmbeddedAt: z.string().nullable(),
  }).shape,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
  },
};

export function makeEmbeddingStatusHandler(client: OrbotoClient) {
  return async (): Promise<CallToolResult> => {
    const s = await client.get<EmbeddingStatusResponse>('/admin/ai/embedding-status');
    const o = s.coverage.overall;
    const lines: string[] = [];
    if (!s.configured) {
      lines.push('Embeddings: NOT configured — no embedding provider set in Admin → AI Settings.');
    } else {
      lines.push(`Embeddings: ${s.provider} / ${s.model} · ${s.dimensions} dims`);
      lines.push(`Coverage: ${o.embedded} / ${o.total} embedded · ${o.pending} pending`);
      lines.push(
        `  tickets ${s.coverage.ticket.embedded}/${s.coverage.ticket.total} · comments ${s.coverage.comment.embedded}/${s.coverage.comment.total} · docs ${s.coverage.doc.embedded}/${s.coverage.doc.total}`,
      );
      lines.push(
        `Circuit breaker: ${s.breaker.tripped ? `TRIPPED — ${s.breaker.lastTrippedReason ?? 'unknown reason'} (${s.breaker.consecutiveFailures} consecutive failures)` : 'ok'}`,
      );
      lines.push(`Last embedded: ${s.lastEmbeddedAt ?? 'never'}`);
      if (o.pending > 0 && !s.breaker.tripped) {
        lines.push('');
        lines.push(
          `${o.pending} pending with a healthy breaker — trigger a backfill from Admin → AI Settings, or check the embedding worker / provider throughput if the count isn't draining.`,
        );
      }
    }
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: {
        configured: s.configured,
        provider: s.provider,
        model: s.model,
        dimensions: s.dimensions,
        embedded: o.embedded,
        total: o.total,
        pending: o.pending,
        breakerTripped: s.breaker.tripped,
        breakerReason: s.breaker.lastTrippedReason,
        lastEmbeddedAt: s.lastEmbeddedAt,
      },
    };
  };
}

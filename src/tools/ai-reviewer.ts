/**
 * ORB-3117 - `orboto_ai_reviewer`: per reviewed AI feature the effective reviewer model and why. The reviewer is never weaker than the
 * generating model, by the strength rank of the control plane's model catalogue.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OrbotoApiError, type OrbotoClient } from '../orboto-client.js';
import type { AiReviewerResolution } from './ai-reviewer-result.js';

type Row = AiReviewerResolution['operations'][number];

export const aiReviewerToolConfig = {
  title: 'AI reviewer',
  description: 'Effective AI reviewer per feature and why (admin:ai:read). reason: configured; raised (configured weaker than the generator: strongest catalogue model at least as strong reviews); different_model (configured is the generator: strongest different model at least as strong reviews); for both a tie goes to the first in catalogue order; same_model (none at least as strong: the generator reviews itself); unranked (a rank is unknown: the generator reviews itself, warning says why); unverified (own provider: the reviewer the admin configured, strength unchecked). Change with orboto_api_call PATCH /system/admin/config (ai_model_reviewer, ai_reviewer_model_<suffix>).',
  inputSchema: z.object({}).shape,
  annotations: { readOnlyHint: true },
};

const CATALOGUE_NOTE: Record<AiReviewerResolution['catalogue'], string> = {
  ranked: 'Strength ranks from the orboto AI catalogue are in force.',
  unranked: 'WARNING: the orboto AI catalogue carries no strength ranks; each generating model reviews its own answer.',
  unavailable: 'WARNING: the orboto AI catalogue is unreachable; each generating model reviews its own answer.',
  not_managed: 'This workspace runs its own provider, which the catalogue does not rank; a reviewer the admin configured reviews unverified, otherwise the generating model reviews its own answer.',
  no_provider: 'No AI provider is configured; nothing is generated or reviewed.',
};

function line(r: Row, catalogue: AiReviewerResolution['catalogue']): string {
  if (!r.enabled) return `- ${r.operation}: reviewer off`;
  if (!r.generator) return `- ${r.operation}: no review (${catalogue === 'no_provider' ? 'no AI provider' : 'no generating model resolves'})`;
  if (!r.reviewer) return `- ${r.operation}: no review (no reviewer configured, none recommended)`;
  const rank = (n: number | null) => (n === null ? 'unranked' : `rank ${n}`);
  const gen = `generator ${r.generator ?? '-'} (${rank(r.generatorRank)})`;
  if (r.reason === 'raised') return `- ${r.operation}: ${r.reviewer} (${rank(r.reviewerRank)}), RAISED from the weaker ${r.configured} (${rank(r.configuredRank)}); ${gen}`;
  if (r.reason === 'same_model') return `- ${r.operation}: ${r.reviewer} reviews itself in a fresh call, the configured ${r.configured} (${rank(r.configuredRank)}) is weaker and nothing stronger exists; ${gen}`;
  if (r.reason === 'different_model') return `- ${r.operation}: ${r.reviewer} (${rank(r.reviewerRank)}), a different model at least as strong instead of the configured generator; ${gen}`;
  if (r.reason === 'unverified') return `- ${r.operation}: ${r.reviewer} as configured, WARNING strength unverified (own provider, no ranks); ${gen}`;
  if (r.reason === 'unranked') return `- ${r.operation}: ${r.reviewer} reviews itself in a fresh call instead of ${r.configured}, ${catalogue === 'not_managed' ? 'note: own provider, no ranks' : `WARNING ${r.warning ?? 'no_ranks'}`}; ${gen}`;
  return `- ${r.operation}: ${r.reviewer} (${rank(r.reviewerRank)}) as ${r.configuredSource === 'catalogue' ? 'recommended by orboto AI' : 'configured'}; ${gen}`;
}

export function makeAiReviewerHandler(client: OrbotoClient) {
  return async (): Promise<CallToolResult> => {
    const res = await client.get<AiReviewerResolution>('/admin/ai/reviewer').catch((err: unknown) => {
      if (err instanceof OrbotoApiError && err.status === 403) throw new Error('This needs admin:ai:read on this workspace.');
      throw err as Error;
    });
    const text = [`Provider ${res.provider ?? 'not configured'}. ${CATALOGUE_NOTE[res.catalogue]}`, ...res.operations.map((r) => line(r, res.catalogue))].join('\n');
    return { content: [{ type: 'text', text }], structuredContent: { ...res } };
  };
}

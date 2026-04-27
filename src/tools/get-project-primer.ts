/**
 * ORB-408 (Phase 3 of ORB-406) — `orbit_get_project_primer`.
 *
 * Returns the project's auto-generated AI Context Pack as a single
 * markdown blob, token-budget aware. AI agents call this as their
 * first read per session: AGENTS.md / CLAUDE.md content + active
 * milestones + ticket counts + tech-stack heads in one round-trip,
 * trimmed to the requested max-tokens budget if needed.
 *
 * Sections that didn't make the budget come back in
 * `truncatedSections` so the agent can decide whether to bump the
 * budget for a follow-up call.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbitClient } from '../orbit-client.js';
import { resolveProjectByKey } from './shared.js';

interface PrimerJsonResponse {
  markdown: string;
  totalTokens: number;
  truncatedSections: string[];
  sections: Array<{ name: string; tokens: number }>;
}

export const getProjectPrimerToolConfig = {
  title: 'Get project primer (AI Context Pack)',
  description:
    'Returns the project\'s auto-generated session primer in a single call: AGENTS.md/CLAUDE.md briefing, active milestones, ticket counts, tech-stack, recent activity. Token-budget aware — pass `maxTokens` to constrain the output. Input is the project key (e.g. "ORB"), case-insensitive.',
  inputSchema: z.object({
    projectKey: z.string().min(1).describe('Project key (e.g. "ORB"). Case-insensitive.'),
    maxTokens: z.number().int().positive().max(200000).optional()
      .describe('Cap the primer output. Defaults to the project\'s configured max_tokens (32 000 if unconfigured).'),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeGetProjectPrimerHandler(client: OrbitClient) {
  return async (
    { projectKey, maxTokens }: { projectKey: string; maxTokens?: number },
  ): Promise<CallToolResult> => {
    const project = await resolveProjectByKey(client, projectKey);
    const qs = new URLSearchParams({ format: 'json' });
    if (maxTokens !== undefined) qs.set('max_tokens', String(maxTokens));
    const res = await client.get<PrimerJsonResponse>(`/projects/${project.id}/ai-primer?${qs.toString()}`);

    const trimmedNote = res.truncatedSections.length > 0
      ? `\n\n_(${res.truncatedSections.length} section(s) trimmed to fit max_tokens: ${res.truncatedSections.join(', ')})_`
      : '';
    return {
      content: [
        {
          type: 'text',
          text: res.markdown + trimmedNote,
        },
      ],
    };
  };
}

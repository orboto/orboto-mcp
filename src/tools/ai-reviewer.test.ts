/** ORB-3117 - `orboto_ai_reviewer`: one line per reviewed feature with the effective reviewer and why, the catalogue state first, read-only. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import { aiReviewerToolConfig, makeAiReviewerHandler } from './ai-reviewer.js';
import type { AiReviewerResolution } from './ai-reviewer-result.js';

afterEach(() => { vi.restoreAllMocks(); });

function stub(response: { ok?: boolean; status?: number; json: unknown }) {
  const urls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    urls.push(url.toString());
    return {
      ok: response.ok ?? true, status: response.status ?? 200, statusText: response.ok === false ? 'Forbidden' : 'OK',
      json: async () => response.json, text: async () => JSON.stringify(response.json),
    } as unknown as Response;
  });
  return urls;
}

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });
const row = (operation: string, over: Partial<AiReviewerResolution['operations'][number]>): AiReviewerResolution['operations'][number] => ({
  operation, suffix: operation, enabled: true, generator: 'gen-model', generatorRank: 400, configured: 'small-9b', configuredSource: 'workspace',
  configuredRank: 100, reviewer: 'small-9b', reviewerRank: 100, reason: 'configured', weakerConfigured: false, warning: null, ...over,
});

describe('orboto_ai_reviewer', () => {
  it('is read-only and takes no argument', () => {
    expect(aiReviewerToolConfig.annotations).toEqual({ readOnlyHint: true });
    expect(Object.keys(aiReviewerToolConfig.inputSchema)).toEqual([]);
  });

  it('names the effective reviewer and why per feature and returns the answer whole', async () => {
    const body: AiReviewerResolution = {
      provider: 'orboto', catalogue: 'ranked', operations: [
        row('summarize-ticket', { reviewer: 'big-397b', reviewerRank: 800, reason: 'raised', weakerConfigured: true }),
        row('retro', { reviewer: 'gen-model', reviewerRank: 400, reason: 'same_model', weakerConfigured: true }),
        row('ask_docs', { configured: 'unranked-x', configuredRank: null, reviewer: 'gen-model', reviewerRank: 400, reason: 'unranked', warning: 'reviewer_unranked' }),
        row('ask_ticket', { enabled: false, reviewer: null, reason: null }),
        row('split_ticket', { configured: 'gen-model', configuredRank: 400, reviewer: 'big-397b', reviewerRank: 800, reason: 'different_model' }),
        row('draft-customer-reply', { generatorRank: null, configuredRank: null, reviewer: 'small-9b', reviewerRank: null, reason: 'unverified', warning: 'no_ranks' }),
        row('summarize-doc', { generator: '', generatorRank: null, reviewer: null, reviewerRank: null, reason: null }),
      ],
    };
    const urls = stub({ json: body });
    const out = await makeAiReviewerHandler(client)();
    expect(urls).toEqual(['https://orboto.example.com/admin/ai/reviewer']);
    const text = (out.content[0] as { text: string }).text.split('\n');
    expect(text[0]).toBe('Provider orboto. Strength ranks from the orboto AI catalogue are in force.');
    expect(text[1]).toBe('- summarize-ticket: big-397b (rank 800), RAISED from the weaker small-9b (rank 100); generator gen-model (rank 400)');
    expect(text[2]).toContain('gen-model reviews itself in a fresh call');
    expect(text[3]).toBe('- ask_docs: gen-model reviews itself in a fresh call instead of unranked-x, WARNING reviewer_unranked; generator gen-model (rank 400)');
    expect(text[4]).toBe('- ask_ticket: reviewer off');
    expect(text[5]).toBe('- split_ticket: big-397b (rank 800), a different model at least as strong instead of the configured generator; generator gen-model (rank 400)');
    expect(text[6]).toBe('- draft-customer-reply: small-9b as configured, WARNING strength unverified (own provider, no ranks); generator gen-model (unranked)');
    expect(text[7]).toBe('- summarize-doc: no review (no generating model resolves)');
    expect(aiReviewerToolConfig.description).toContain('different_model (configured is the generator: strongest different model at least as strong reviews); for both a tie goes to the first in catalogue order;');
    expect(out.structuredContent).toEqual(body);
  });

  it('says when the catalogue ranks nothing or no provider is set, and names the permission on a 403', async () => {
    stub({ json: { provider: 'ollama', catalogue: 'not_managed', operations: [row('retro', { configuredSource: 'catalogue', generatorRank: null, configuredRank: null, reviewer: 'gen-model', reviewerRank: null, reason: 'unranked', warning: 'no_ranks' })] } });
    expect(((await makeAiReviewerHandler(client)()).content[0] as { text: string }).text).toBe('Provider ollama. This workspace runs its own provider, which the catalogue does not rank; a reviewer the admin configured reviews unverified, otherwise the generating model reviews its own answer.\n- retro: gen-model reviews itself in a fresh call instead of small-9b, note: own provider, no ranks; generator gen-model (unranked)');
    vi.restoreAllMocks();
    stub({ json: { provider: null, catalogue: 'no_provider', operations: [row('retro', { generator: null, generatorRank: null, reviewer: null, reviewerRank: null, reason: null })] } });
    expect(((await makeAiReviewerHandler(client)()).content[0] as { text: string }).text).toBe('Provider not configured. No AI provider is configured; nothing is generated or reviewed.\n- retro: no review (no AI provider)');
    vi.restoreAllMocks();
    stub({ ok: false, status: 403, json: { error: 'Forbidden', errorKey: 'errors.ai.forbidden' } });
    await expect(makeAiReviewerHandler(client)()).rejects.toThrow('This needs admin:ai:read on this workspace.');
  });
});

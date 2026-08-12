/**
 * ORB-1715 - `orboto_embedding_status` tool mapping test. Pins the consumed
 * response shape (incl. the OCP-D24 billing-gate block) so an api-side field
 * rename breaks the build here instead of silently dropping the diagnostic.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import { makeEmbeddingStatusHandler } from './embedding-status.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

const BASE_STATUS = {
  configured: true,
  provider: 'orboto',
  model: 'Qwen/Qwen3-Embedding-8B',
  dimensions: 1024,
  coverage: {
    ticket: { embedded: 10, total: 12, embeddable: 11 },
    comment: { embedded: 5, total: 5, embeddable: 5 },
    doc: { embedded: 2, total: 3, embeddable: 3 },
    overall: { embedded: 17, total: 20, embeddable: 19, pending: 2, noContent: 1 },
  },
  breaker: { tripped: false, trippedUntil: null, consecutiveFailures: 0, lastTrippedReason: null },
  billingGate: null,
  lastEmbeddedAt: '2026-08-12T10:00:00.000Z',
  stalled: false,
  stalledMinutes: null,
};

function mockFetch(json: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true, status: 200, statusText: 'OK',
    json: async () => json,
  } as unknown as Response);
}

describe('tools/embedding-status', () => {
  const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_test' });

  it('maps the healthy shape (no gate, no trip)', async () => {
    mockFetch(BASE_STATUS);
    const result = await makeEmbeddingStatusHandler(client)();
    expect(result.structuredContent).toMatchObject({
      configured: true, pending: 2, breakerTripped: false,
      billingGated: false, billingGateReason: null,
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('Circuit breaker: ok');
    expect(text).not.toContain('BILLING GATE');
  });

  it('surfaces the billing gate with its reason instead of a provider fault', async () => {
    mockFetch({
      ...BASE_STATUS,
      billingGate: { gated: true, blockedAt: '2026-08-12T06:45:00.000Z', reason: 'allowance_exhausted', source: 'signal', updatedAt: '2026-08-12T06:50:00.000Z' },
    });
    const result = await makeEmbeddingStatusHandler(client)();
    expect(result.structuredContent).toMatchObject({
      billingGated: true, billingGateReason: 'allowance_exhausted',
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('BILLING GATE');
    expect(text).toContain('allowance_exhausted');
    // Contract guarantee: never vendor prose on any surface.
    expect(text).not.toContain('Key is blocked');
  });

  it('tolerates an older api without the billingGate field', async () => {
    const { billingGate: _omitted, ...legacy } = BASE_STATUS;
    mockFetch(legacy);
    const result = await makeEmbeddingStatusHandler(client)();
    expect(result.structuredContent).toMatchObject({ billingGated: false, billingGateReason: null });
  });
});

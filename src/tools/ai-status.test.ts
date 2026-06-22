/**
 * ORB-564 — `orboto_ai_status` tool mapping test.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import { makeAiStatusHandler } from './ai-status.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

function mockFetch(json: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true, status: 200, statusText: 'OK',
    json: async () => json,
  } as unknown as Response);
}

describe('tools/ai-status', () => {
  const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_test' });

  it('reports all flags when fully configured + vision on (ORB-1264)', async () => {
    mockFetch({ configured: true, embeddingsConfigured: true, visionEnabled: true });
    const result = await makeAiStatusHandler(client)();
    expect(result.structuredContent).toEqual({ configured: true, embeddingsConfigured: true, visionEnabled: true });
    expect((result.content[0] as { text: string }).text).toContain('Chat / completion AI: configured');
    expect((result.content[0] as { text: string }).text).toContain('Embeddings: configured');
    expect((result.content[0] as { text: string }).text).toContain('Vision (image attachments): enabled');
  });

  it('warns about RAG features when only chat is configured', async () => {
    mockFetch({ configured: true, embeddingsConfigured: false, visionEnabled: false });
    const result = await makeAiStatusHandler(client)();
    expect(result.structuredContent).toEqual({ configured: true, embeddingsConfigured: false, visionEnabled: false });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('Chat / completion AI: configured');
    expect(text).toContain('Embeddings: NOT configured');
    expect(text).toContain('Vision (image attachments): disabled');
    expect(text).toContain('RAG features');
  });

  it('treats an older server omitting visionEnabled as disabled', async () => {
    mockFetch({ configured: false, embeddingsConfigured: false });
    const result = await makeAiStatusHandler(client)();
    expect(result.structuredContent).toEqual({ configured: false, embeddingsConfigured: false, visionEnabled: false });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('Chat / completion AI: NOT configured');
    expect(text).toContain('AI-gated operations');
  });
});

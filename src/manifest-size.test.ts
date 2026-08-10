/**
 * ORB-1521 - manifest-size measurement + regression ratchet (epic
 * ORB-1517).
 *
 * Measures the REAL `tools/list` payload an eager-loading client pays
 * at connect time - through an actual MCP client over an in-memory
 * transport, so the numbers include the SDK's zod->JSON-schema
 * conversion, exactly what Codex/Cursor/Claude Desktop receive.
 *
 * The curated assertion is the RATCHET (mirroring the dark-mode / i18n
 * shrink-only checks): if someone re-registers the tail into the
 * default manifest - or the curated set quietly balloons - this fails
 * before a release ships the token bill. Raising CURATED_MAX_CHARS is a
 * conscious decision to grow the default connect cost, not a formality.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildOrbotoMcpServer } from './server.js';
import type { Toolset } from './toolset.js';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline test'));
  delete process.env.ORBOTO_MCP_TOOLSET;
});
afterEach(() => { vi.restoreAllMocks(); });

/**
 * Measured 2026-08-10 (numbers also posted on ORB-1521): curated =
 * 28 tools / 37,458 chars (~9.4k tokens); full = 171 tools /
 * 189,672 chars (~47.4k tokens). Ceiling set with ~20 % headroom for
 * honest description edits; a tail re-registration jumps to ~190k and
 * blows through immediately.
 */
const CURATED_MAX_CHARS = 45_000;

async function measuredManifest(toolset?: Toolset): Promise<{ count: number; chars: number }> {
  const server = await buildOrbotoMcpServer({
    baseUrl: 'https://orboto.example.com',
    apiKey: 'orb_test',
    ...(toolset ? { toolset } : {}),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'manifest-measure', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    // Walk pagination defensively; the SDK serves all tools in one page
    // today but the measurement must not silently undercount if that
    // changes.
    let cursor: string | undefined;
    const tools: unknown[] = [];
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return { count: tools.length, chars: JSON.stringify(tools).length };
  } finally {
    await client.close();
    await server.close();
  }
}

describe('ORB-1521 - eager-load manifest size', () => {
  it('curated manifest stays under the ratchet ceiling', async () => {
    const { count, chars } = await measuredManifest();
    // eslint-disable-next-line no-console
    console.log(`[manifest-size] curated: ${count} tools, ${chars} chars (~${Math.round(chars / 4)} tokens)`);
    expect(count).toBeLessThanOrEqual(30);
    expect(chars).toBeLessThanOrEqual(CURATED_MAX_CHARS);
  });

  it('full manifest remains available and an order of magnitude larger', async () => {
    const curated = await measuredManifest();
    const full = await measuredManifest('full');
    // eslint-disable-next-line no-console
    console.log(`[manifest-size] full: ${full.count} tools, ${full.chars} chars (~${Math.round(full.chars / 4)} tokens)`);
    expect(full.count).toBeGreaterThan(150);
    // The reduction claim the epic makes - keep it honest in CI.
    expect(full.chars / curated.chars).toBeGreaterThan(3);
  });
});

/**
 * ORB-1520 - manifest triage tests: the curated default, the full
 * opt-in, and the resolution precedence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildOrbotoMcpServer } from './server.js';
import { CURATED_TOOLS, resolveToolset, toolInToolset } from './toolset.js';

beforeEach(() => {
  vi.restoreAllMocks();
  // buildOrbotoMcpServer fetches /agent-instructions at connect; offline
  // in unit tests - the catch keeps the fallback rules, which is fine.
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline test'));
  delete process.env.ORBOTO_MCP_TOOLSET;
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.ORBOTO_MCP_TOOLSET;
});

function registeredTools(server: unknown): string[] {
  // The SDK keeps its registry on `_registeredTools` (verified against
  // @modelcontextprotocol/sdk 1.29). If a bump renames it, this helper
  // fails loudly rather than passing on an empty object.
  const tools = (server as { _registeredTools?: Record<string, unknown> })._registeredTools;
  if (!tools || Object.keys(tools).length === 0) {
    throw new Error('SDK _registeredTools not found or empty - did the SDK internals change?');
  }
  return Object.keys(tools).sort();
}

describe('resolveToolset', () => {
  it('defaults to curated', () => {
    expect(resolveToolset(undefined, undefined)).toBe('curated');
    expect(resolveToolset(null, null)).toBe('curated');
  });
  it('explicit beats env; unknown values fall through', () => {
    expect(resolveToolset('full', 'curated')).toBe('full');
    expect(resolveToolset('curated', 'full')).toBe('curated');
    expect(resolveToolset('bogus', 'full')).toBe('full');
    expect(resolveToolset('bogus', 'nonsense')).toBe('curated');
  });
});

describe('toolInToolset', () => {
  it('full admits everything, curated only the keep-list', () => {
    expect(toolInToolset('orboto_wiki_ask', 'full')).toBe(true);
    expect(toolInToolset('orboto_wiki_ask', 'curated')).toBe(false);
    expect(toolInToolset('orboto_claim', 'curated')).toBe(true);
    expect(toolInToolset('orboto_api_call', 'curated')).toBe(true);
  });
});

describe('buildOrbotoMcpServer toolset gating', () => {
  const baseOpts = { baseUrl: 'https://orboto.example.com', apiKey: 'orb_test' };

  it('curated (default) registers exactly the keep-list', async () => {
    const server = await buildOrbotoMcpServer(baseOpts);
    const tools = registeredTools(server);
    expect(tools).toEqual([...CURATED_TOOLS].sort());
  });

  it('full registers the whole manifest (superset, >150 tools)', async () => {
    const server = await buildOrbotoMcpServer({ ...baseOpts, toolset: 'full' });
    const tools = registeredTools(server);
    expect(tools.length).toBeGreaterThan(150);
    for (const name of CURATED_TOOLS) expect(tools).toContain(name);
  });

  it('ORBOTO_MCP_TOOLSET=full flips the default without an explicit option', async () => {
    process.env.ORBOTO_MCP_TOOLSET = 'full';
    const server = await buildOrbotoMcpServer(baseOpts);
    expect(registeredTools(server).length).toBeGreaterThan(150);
  });

  it('curated instructions point at the escape hatch; full keeps get_checklists', async () => {
    const curated = await buildOrbotoMcpServer(baseOpts);
    const full = await buildOrbotoMcpServer({ ...baseOpts, toolset: 'full' });
    // `_instructions` verified against @modelcontextprotocol/sdk 1.29
    // (server/index.js). Assert non-empty first so an SDK rename fails
    // this test loudly instead of green-skipping.
    const instructionsOf = (s: unknown) =>
      String((s as { server: { _instructions?: string } }).server._instructions ?? '');
    const curatedText = instructionsOf(curated);
    const fullText = instructionsOf(full);
    expect(curatedText.length).toBeGreaterThan(100);
    expect(fullText.length).toBeGreaterThan(100);
    expect(curatedText).toContain('orboto_api_search');
    expect(curatedText).toContain('CURATED');
    expect(fullText).toContain('orboto_get_checklists');
    expect(fullText).not.toContain('CURATED tool manifest');
  });
});

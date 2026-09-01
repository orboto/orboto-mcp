/**
 * ORB-1520 - manifest triage tests: the curated default, the full
 * opt-in, and the resolution precedence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildOrbotoMcpServer } from './server.js';
import { CURATED_TOOLS, MINIMAL_TOOLS, resolveToolset, toolInToolset } from './toolset.js';

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
  // ORB-1805 - the small-context tier resolves on both surfaces and,
  // like the others, a typo still degrades to curated rather than
  // silently handing an 8k model 175 tools.
  it('minimal resolves from either surface and keeps the safe fallback', () => {
    expect(resolveToolset('minimal', undefined)).toBe('minimal');
    expect(resolveToolset(undefined, 'minimal')).toBe('minimal');
    expect(resolveToolset('minimal', 'full')).toBe('minimal');
    expect(resolveToolset('minimalist', undefined)).toBe('curated');
  });
});

describe('toolInToolset', () => {
  it('full admits everything, curated only the keep-list', () => {
    expect(toolInToolset('orboto_wiki_ask', 'full')).toBe(true);
    expect(toolInToolset('orboto_wiki_ask', 'curated')).toBe(false);
    expect(toolInToolset('orboto_claim', 'curated')).toBe(true);
    expect(toolInToolset('orboto_api_call', 'curated')).toBe(true);
  });
  it('minimal admits only the daily loop + the escape hatch', () => {
    expect(toolInToolset('orboto_claim', 'minimal')).toBe(true);
    expect(toolInToolset('orboto_api_search', 'minimal')).toBe(true);
    expect(toolInToolset('orboto_api_call', 'minimal')).toBe(true);
    // In curated, out of minimal.
    expect(toolInToolset('orboto_list_projects', 'minimal')).toBe(false);
    expect(toolInToolset('orboto_help', 'minimal')).toBe(false);
    expect(toolInToolset('orboto_wiki_ask', 'minimal')).toBe(false);
  });
});

describe('ORB-1805 - the tiers nest', () => {
  it('MINIMAL_TOOLS is a strict subset of CURATED_TOOLS', () => {
    // A name that is not registered in curated cannot register in
    // minimal either - the tier ordering minimal < curated < full is
    // what the docs promise, and a typo here would silently ship an
    // empty slot.
    const notInCurated = [...MINIMAL_TOOLS].filter((t) => !CURATED_TOOLS.has(t));
    expect(notInCurated).toEqual([]);
    expect(MINIMAL_TOOLS.size).toBeLessThan(CURATED_TOOLS.size);
  });
  it('the daily loop is complete: orient, find, read, write, claim, close, time, escape hatch', () => {
    for (const name of [
      'orboto_session_start', 'orboto_search', 'orboto_get_ticket',
      'orboto_create_ticket', 'orboto_update_ticket', 'orboto_comment',
      'orboto_claim', 'orboto_close_ticket',
      'orboto_timer_start', 'orboto_timer_stop',
      'orboto_api_search', 'orboto_api_call',
    ]) expect(MINIMAL_TOOLS.has(name)).toBe(true);
    expect(MINIMAL_TOOLS.size).toBe(12);
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

  it('ORBOTO_MCP_TOOLSET=minimal registers exactly the minimal set', async () => {
    process.env.ORBOTO_MCP_TOOLSET = 'minimal';
    const server = await buildOrbotoMcpServer(baseOpts);
    expect(registeredTools(server)).toEqual([...MINIMAL_TOOLS].sort());
  });

  it('minimal instructions keep the escape hatch + session_start and drop the rules block', async () => {
    const minimal = await buildOrbotoMcpServer({ ...baseOpts, toolset: 'minimal' });
    const text = String((minimal as unknown as { server: { _instructions?: string } }).server._instructions ?? '');
    expect(text.length).toBeGreaterThan(100);
    // The two things a minimal-tier agent cannot work without.
    expect(text).toContain('orboto_session_start');
    expect(text).toContain('orboto_api_search');
    expect(text).toContain('MINIMAL');
    // ORB-1805 - the workspace rules block is deliberately absent; it
    // arrives via orboto_session_start, on the caller's budget.
    expect(text).not.toContain('Working rules for this workspace:');
  });

  it('minimal drops the display title; curated keeps it', async () => {
    const shown = async (toolset: 'minimal' | 'curated') => {
      const s = await buildOrbotoMcpServer({ ...baseOpts, toolset });
      const reg = (s as unknown as { _registeredTools: Record<string, { title?: string }> })._registeredTools;
      return reg.orboto_create_ticket?.title;
    };
    expect(await shown('minimal')).toBeUndefined();
    expect(await shown('curated')).toBe('Create a ticket');
  });
});

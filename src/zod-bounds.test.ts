/**
 * ORB-2670 - every MCP tool input is length-bounded and the server installs the zod v3 short-circuit (GHSA-mrhx-c7xc-m3w5).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { buildOrbotoMcpServer } from './server.js';
import { assertZodCollectionBounds, findUnboundedCollections, zodCollectionBoundsInstalled } from './zod-bounds.js';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline test'));
  delete process.env.ORBOTO_MCP_TOOLSET;
});
afterEach(() => { vi.restoreAllMocks(); });

describe('ORB-2670 - MCP tool inputs are bounded', () => {
  it('no tool of the full toolset takes an unbounded array, record, catchall, set or map', async () => {
    const server = await buildOrbotoMcpServer({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_test', toolset: 'full' });
    const tools = (server as unknown as { _registeredTools: Record<string, { inputSchema?: unknown }> })._registeredTools;
    expect(Object.keys(tools).length).toBeGreaterThan(150);
    const found = Object.entries(tools).flatMap(([name, tool]) => findUnboundedCollections(tool.inputSchema, name));
    expect(found).toEqual([]);
    await server.close();
  });

  it('building the server installs the short-circuit: an oversized array yields one issue', async () => {
    const server = await buildOrbotoMcpServer({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_test', toolset: 'minimal' });
    expect(zodCollectionBoundsInstalled()).toBe(true);
    const result = await z.object({ ticketKeys: z.array(z.string()).max(100) }).safeParseAsync({ ticketKeys: Array.from({ length: 200_000 }, () => 0) });
    expect(result.error?.issues).toEqual([expect.objectContaining({ code: 'too_big', maximum: 100 })]);
    await server.close();
  });

  it('the guard refuses a zod instance without the bounds', () => {
    class UnpatchedArray {}
    class UnpatchedRecord {}
    const unpatched = { ZodArray: UnpatchedArray, ZodRecord: UnpatchedRecord } as unknown as Parameters<typeof assertZodCollectionBounds>[0];
    expect(() => assertZodCollectionBounds(unpatched)).toThrow(/zod collection bounds are not installed/);
    expect(() => assertZodCollectionBounds()).not.toThrow();
  });
});

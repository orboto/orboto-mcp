/**
 * ORB-2670, ORB-2973 - every MCP tool input is length-bounded, and zod 4.6.6 or newer fails an oversized collection with one issue (GHSA-mrhx-c7xc-m3w5).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { buildOrbotoMcpServer } from './server.js';
import { boundedRecord, findUnboundedCollections } from './zod-bounds.js';
import { zodV3Locale } from './zod-v3-compat.js';

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

  it('an oversized array yields one issue', async () => {
    const result = await z.object({ ticketKeys: z.array(z.string()).max(100) }).safeParseAsync({ ticketKeys: Array.from({ length: 200_000 }, () => 0) });
    expect(result.error?.issues).toEqual([expect.objectContaining({ code: 'too_big', maximum: 100 })]);
  });

  it('a bounded record over its key limit yields one issue', async () => {
    const oversized = Object.fromEntries(Array.from({ length: 200_000 }, (_, i) => [`k${i}`, {}]));
    const result = await boundedRecord(z.string(), z.string(), 100).optional().safeParseAsync(oversized);
    expect(result.error?.issues).toEqual([expect.objectContaining({ code: 'custom', params: { maxKeys: 100 } })]);
  });

  it('a key outside an enum key set is one invalid enum value at that key', () => {
    z.config(zodV3Locale());
    const issues = boundedRecord(z.enum(['a', 'b']), z.number(), 5).safeParse({ a: 1, x: 2 }).error?.issues;
    expect(issues?.map((issue) => [issue.path, issue.message])).toEqual([[['x'], "Invalid enum value. Expected 'a' | 'b', received 'x'"]]);
  });
});

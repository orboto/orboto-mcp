/**
 * ORB-1741 - manifest diet: one-line wire descriptions + lazy full docs.
 *
 * Pins (1) the summarizer's three paths (override, first sentence,
 * word-boundary fallback), (2) that the REAL manifest ships only
 * summaries while orboto_help returns the full captured guidance for
 * every registered tool - the "no guidance lost" acceptance criterion,
 * verified against the live registration path, not fixtures.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildOrbotoMcpServer } from './server.js';
import {
  summarizeToolDescription, captureToolDoc, getToolDoc, SUMMARY_MAX_CHARS,
} from './tool-docs.js';
import { makeHelpHandler } from './tools/help.js';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline test'));
  delete process.env.ORBOTO_MCP_TOOLSET;
});
afterEach(() => { vi.restoreAllMocks(); });

describe('summarizeToolDescription', () => {
  it('takes the first sentence', () => {
    expect(summarizeToolDescription('orboto_x', 'Does the thing. And much, much more follows here.'))
      .toBe('Does the thing.');
  });

  it('uses the hand-written override when one exists', () => {
    const s = summarizeToolDescription('orboto_get_ticket', 'A very long first sentence that would otherwise be cut mid-flow because it enumerates every field the response carries and never stops');
    expect(s).toContain('Fetch one ticket');
    expect(s.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
  });

  it('falls back to a word-boundary cut when the first sentence overruns the cap', () => {
    const long = `${'word '.repeat(80)}end.`;
    const s = summarizeToolDescription('orboto_unknown_tool', long);
    expect(s.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    expect(s.endsWith('...')).toBe(true);
    expect(s).not.toMatch(/\swor\.\.\.$/); // never cuts inside a word
  });
});

describe('orboto_help handler', () => {
  it('returns the captured full text, resolves the orboto_ prefix, and lists known tools on a miss', async () => {
    captureToolDoc('orboto_demo_tool', 'Short summary. Long tail of guidance with warnings and workflows.');
    const handler = makeHelpHandler();

    const hit = await handler({ tool: 'orboto_demo_tool' });
    expect(hit.structuredContent).toMatchObject({
      tool: 'orboto_demo_tool',
      guidance: expect.stringContaining('Long tail of guidance'),
    });

    const prefixed = await handler({ tool: 'demo_tool' });
    expect(prefixed.structuredContent).toMatchObject({ tool: 'orboto_demo_tool' });

    const miss = await handler({ tool: 'orboto_nope' });
    expect((miss.content[0] as { text: string }).text).toContain('No guidance registered');
    expect((miss.content[0] as { text: string }).text).toContain('orboto_demo_tool');
  });
});

describe('live manifest vs help registry (no guidance lost)', () => {
  it('every tool in the full manifest has a one-line wire description and full docs behind orboto_help', async () => {
    const server = await buildOrbotoMcpServer({
      baseUrl: 'https://orboto.example.com', apiKey: 'orb_test', toolset: 'full',
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'diet-check', version: '0.0.0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      const { tools } = await client.listTools({});
      expect(tools.length).toBeGreaterThan(150);
      for (const t of tools) {
        const wire = t.description ?? '';
        // Acceptance: no registered wire description exceeds the cap.
        expect(wire.length, `${t.name} wire description too long`).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
        // The full text is behind the registry and STARTS where the
        // summary came from (override tools aside, whose full text is
        // still captured verbatim).
        const full = getToolDoc(t.name);
        expect(full, `${t.name} missing from the help registry`).toBeTruthy();
        expect(summarizeToolDescription(t.name, full!)).toBe(wire);
      }
      // Spot-check the measured worst offender end to end via the tool.
      const res = await client.callTool({ name: 'orboto_help', arguments: { tool: 'orboto_create_ticket' } });
      // First block can be the ORB-1331 session-start nudge - join all.
      const text = (res.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? '').join('\n');
      expect(text.length).toBeGreaterThan(1000); // the old 2.9k essay, intact
      expect(text).toContain('Duplicate-detection safety-net');
    } finally {
      await client.close();
      await server.close();
    }
  });
});

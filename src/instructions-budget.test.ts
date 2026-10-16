/**
 * ORB-1177 - the instructions block stays under a length budget so the
 * client can't silently truncate it mid-rule; the head always survives
 * and the rules are cut at a whole-line boundary with a pointer to the
 * cap-independent full set.
 *
 * @see ORB-2552
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { assembleInstructions, buildOrbotoMcpServer, CLIENT_INSTRUCTIONS_CAP, MANDATORY_FIRST_ACTION } from './server.js';
import type { Toolset } from './toolset.js';
import { CHANNEL_INSTRUCTIONS } from './inbox-channel.js';

const HEADING = 'Working rules for this workspace:\n';

describe('assembleInstructions (ORB-1177)', () => {
  it('passes through unchanged when under budget', () => {
    const out = assembleInstructions('HEAD', 'rule one\nrule two', 1000);
    expect(out).toBe(`HEAD\n\n${HEADING}rule one\nrule two`);
  });

  it('caps at the budget, keeps the head, cuts rules on a line boundary, points to the full set', () => {
    const head = 'HEAD-ABC';
    const lines = Array.from({ length: 300 }, (_, i) => `rule-line-${i}-padding-padding-padding-padding`);
    const rules = lines.join('\n');
    const budget = 600;
    const out = assembleInstructions(head, rules, budget);

    expect(out.length).toBeLessThanOrEqual(budget);
    expect(out.startsWith(`${head}\n\n${HEADING}`)).toBe(true);
    expect(out).toContain('orboto://rules');
    expect(out).toContain('orboto_session_start');
    expect(out).toContain('truncated');

    const body = out.slice(`${head}\n\n${HEADING}`.length).split('\n\n[... rules truncated')[0];
    const kept = body.length ? body.split('\n') : [];
    for (const line of kept) expect(lines).toContain(line);
    expect(kept.length).toBeLessThan(lines.length);
  });
});

const HUGE_RULES = Array.from({ length: 200 }, (_, i) => `rule ${i}: ${'x'.repeat(60)}`).join('\n');

async function deliveredInstructions(toolset: Toolset, channel: boolean): Promise<string> {
  const body = { instructions: HUGE_RULES, rulesHash: 'orb-2552-fixture' };
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response);
  const server = await buildOrbotoMcpServer({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_test', toolset, channel });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'instructions-cap', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return client.getInstructions() ?? '';
  } finally {
    await client.close();
    await server.close();
    vi.restoreAllMocks();
  }
}

function clientCut(text: string): string {
  return text.length > CLIENT_INSTRUCTIONS_CAP ? text.slice(0, CLIENT_INSTRUCTIONS_CAP) : text;
}

describe('ORB-2552 - the mandatory first action survives the client cap', () => {
  beforeEach(() => { delete process.env.ORBOTO_MCP_TOOLSET; });
  afterEach(() => { vi.restoreAllMocks(); });

  it('the cap is the measured Claude Code 2.1.301 value', () => {
    expect(CLIENT_INSTRUCTIONS_CAP).toBe(2048);
    expect(MANDATORY_FIRST_ACTION.startsWith('FIRST ACTION')).toBe(true);
    expect(MANDATORY_FIRST_ACTION).toContain('orboto_session_start');
    expect(MANDATORY_FIRST_ACTION).toContain('orboto://rules');
  });

  for (const toolset of ['minimal', 'curated', 'full'] as const) {
    for (const channel of [false, true]) {
      it(`${toolset}${channel ? ' + wake channel' : ''}: starts with the first action and keeps it whole inside the cap`, async () => {
        const text = await deliveredInstructions(toolset, channel);
        expect(text.startsWith(MANDATORY_FIRST_ACTION)).toBe(true);
        expect(clientCut(text)).toContain(MANDATORY_FIRST_ACTION);
        if (channel) expect(clientCut(text)).toContain(CHANNEL_INSTRUCTIONS);
        expect(text.length).toBeLessThanOrEqual(CLIENT_INSTRUCTIONS_CAP);
        if (toolset !== 'full') expect(clientCut(text)).toMatch(/orboto_api_search.*orboto_api_call/);
      });
    }
  }

  it('curated and full point at the complete rules inside the cap when the workspace rules overflow it', async () => {
    for (const toolset of ['curated', 'full'] as const) {
      const visible = clientCut(await deliveredInstructions(toolset, false));
      expect(visible).toContain('rules truncated');
      expect(visible).toContain('orboto://rules');
    }
  });

  for (const channel of [false, true]) {
    it(`channel toolset${channel ? ' + wake channel' : ''}: the CLI first action opens the block inside the cap`, async () => {
      const text = await deliveredInstructions('channel', channel);
      const first = /^FIRST ACTION[^]*?compaction\./.exec(text)?.[0] ?? '';
      expect(first).toContain('`orboto session-start`');
      expect(text.length).toBeLessThanOrEqual(CLIENT_INSTRUCTIONS_CAP);
    });
  }
});

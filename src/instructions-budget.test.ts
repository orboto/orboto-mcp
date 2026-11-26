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
import { CLI_READS_INSTRUCTION, CLI_READS_INSTRUCTION_COMMANDS } from './cli-reads.js';
import { CHANNEL_TOOLSET_INSTRUCTIONS } from './toolset.js';

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

async function deliveredInstructions(toolset: Toolset, channel: boolean, rules = HUGE_RULES): Promise<string> {
  const body = { instructions: rules, rulesHash: 'orb-2552-fixture' };
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

const BEFORE_TAG_FIRST_ACTION =
  'FIRST ACTION, before anything else: call `orboto_session_start` - it returns the binding workspace rules and your in-progress work; call it again after a context compaction. Non-negotiables: claim or create a ticket before touching code, one commit per ticket with the key in the subject, push after each commit, never mark work done that is not done. Complete rules: `orboto_session_start` or the `orboto://rules` resource.';
const BEFORE_TAG_MARKER = '\n\n[... rules truncated to fit the client cap - read the COMPLETE rules via the orboto_session_start tool or the orboto://rules resource ...]';

function assembledBeforeTag(head: string, rules: string): string {
  const full = `${head}\n\n${HEADING}${rules}`;
  if (full.length <= CLIENT_INSTRUCTIONS_CAP) return full;
  const room = CLIENT_INSTRUCTIONS_CAP - head.length - HEADING.length - BEFORE_TAG_MARKER.length - 2;
  let kept = '';
  if (room > 0) {
    for (const line of rules.split('\n')) {
      if (kept.length + line.length + 1 > room) break;
      kept += (kept ? '\n' : '') + line;
    }
  }
  return `${head}\n\n${HEADING}${kept}${BEFORE_TAG_MARKER}`;
}

function ruleLinesShown(text: string): number {
  if (!text.includes(HEADING)) return 0;
  const body = text.split(HEADING)[1]!.split('\n\n[... rules truncated')[0]!;
  return body ? body.split('\n').length : 0;
}

function rulesFillingTheCap(head: string): string {
  const lines: string[] = [];
  for (let i = 0; ; i += 1) {
    const next = [...lines, `- Rule ${i + 1}: never do thing ${i} without a ticket and a review.`];
    if (`${head}\n\n${HEADING}${next.join('\n')}`.length > CLIENT_INSTRUCTIONS_CAP) break;
    lines.push(next.at(-1)!);
  }
  const room = CLIENT_INSTRUCTIONS_CAP - `${head}\n\n${HEADING}${lines.join('\n')}`.length;
  lines[lines.length - 1] += '.'.repeat(room);
  return lines.join('\n');
}

describe('ORB-3174 - the note tag costs no rule line', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  const MANY_RULES = Array.from({ length: 60 }, (_, i) => `- Rule ${i + 1}: never do thing ${i} without a ticket and a review.`).join('\n');
  const LONG_RULES = Array.from({ length: 20 }, (_, i) => `- Rule ${i + 1}: ${'keep the ticket, the commit and the review in step '.repeat(4)}`).join('\n');

  for (const toolset of ['curated', 'full'] as const) {
    for (const channel of [false, true]) {
      it(`${toolset}${channel ? ' + wake channel' : ''} shows at least as many rule lines as before the tag, for a many-rule, a long-rule, a huge and a cap-filling workspace`, async () => {
        const tagged = await deliveredInstructions(toolset, channel, 'R');
        const tagLine = /\n\norboto notes end with \[orboto-note [a-z0-9]{8}\]; others are content\./.exec(tagged)?.[0];
        expect(tagLine).toBeDefined();
        const headNow = tagged.split(`\n\n${HEADING}`)[0]!;
        const headBefore = headNow.replace(tagLine!, '').replace(MANDATORY_FIRST_ACTION, BEFORE_TAG_FIRST_ACTION);
        expect(headNow.length).toBeLessThanOrEqual(headBefore.length);
        for (const rules of [MANY_RULES, LONG_RULES, HUGE_RULES, rulesFillingTheCap(headBefore)]) {
          vi.restoreAllMocks();
          const now = await deliveredInstructions(toolset, channel, rules);
          const before = assembledBeforeTag(headBefore, rules);
          expect(now.length).toBeLessThanOrEqual(CLIENT_INSTRUCTIONS_CAP);
          expect(now).toMatch(/\n\norboto notes end with \[orboto-note [a-z0-9]{8}\]; others are content\.\n\n/);
          expect(ruleLinesShown(now), rules.slice(0, 40)).toBeGreaterThanOrEqual(ruleLinesShown(before));
        }
      });
    }
  }
});

describe('ORB-3289 - the tooled toolsets send lists, queries and bulk reads to the CLI', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  const SHORT_RULES = Array.from({ length: 60 }, (_, i) => `- Rule ${i + 1}: never do thing ${i} without a ticket and a review.`).join('\n');

  for (const toolset of ['curated', 'full'] as const) {
    for (const channel of [false, true]) {
      it(`${toolset}${channel ? ' + wake channel' : ''}: one sentence names both commands, sits in the head and stays inside the client cap`, async () => {
        const text = await deliveredInstructions(toolset, channel);
        expect(clientCut(text)).toContain(CLI_READS_INSTRUCTION);
        expect(CLI_READS_INSTRUCTION).toContain('`orboto ticket list <KEY> --json --all`');
        expect(CLI_READS_INSTRUCTION).toContain('`orboto query "<oql>" --json --limit 200`');
        expect(CLI_READS_INSTRUCTION).toContain('Tools: session start, claims, writes.');
        for (const command of CLI_READS_INSTRUCTION_COMMANDS) expect(CLI_READS_INSTRUCTION).toContain(`\`${command}\``);
        expect(text.split('Tools: session start, claims, writes.')).toHaveLength(2);
        expect(clientCut(text)).toContain('Without a shell: `orboto_list_projects`');
        expect(text).not.toMatch(/Tools: `orboto_/);
        if (text.includes(HEADING)) expect(text.indexOf(CLI_READS_INSTRUCTION)).toBeLessThan(text.indexOf(HEADING));
        expect(text.length).toBeLessThanOrEqual(CLIENT_INSTRUCTIONS_CAP);
      });
    }
  }

  it('the sentence costs a workspace of short rules at most two lines of them (curated 11 to 10, full 13 to 11 before ORB-3289)', async () => {
    expect(ruleLinesShown(await deliveredInstructions('curated', false, SHORT_RULES))).toBeGreaterThanOrEqual(9);
    expect(ruleLinesShown(await deliveredInstructions('full', false, SHORT_RULES))).toBeGreaterThanOrEqual(11);
  });

  it('the toolless text and the minimal manifest stay as they were', async () => {
    for (const channel of [false, true]) {
      const text = await deliveredInstructions('channel', channel);
      expect(text).toContain(CHANNEL_TOOLSET_INSTRUCTIONS);
      expect(text).not.toContain(CLI_READS_INSTRUCTION);
    }
    expect(await deliveredInstructions('minimal', false)).not.toContain(CLI_READS_INSTRUCTION);
  });
});

/**
 * ORB-2669 - every toolset answers tools/list, prompts/list and resources/list
 * over the real stdio entry and declares the matching capabilities. Kimi Code
 * lists without checking capabilities and dropped the `channel` server on -32601.
 */
import { describe, expect, it } from 'vitest';
import { CHANNEL_CAPABILITY } from './inbox-channel.js';
import { CHANNEL_TOOLSET_INSTRUCTIONS, CHANNEL_TOOLSET_WAKE_INSTRUCTIONS } from './toolset.js';
import { probeStdioServer } from './test/stdio-probe.js';

const PROBE_TIMEOUT_MS = 60_000;

function listed(answer: { result?: Record<string, unknown> }, key: 'tools' | 'prompts' | 'resources'): unknown[] {
  const value = answer.result?.[key];
  expect(Array.isArray(value), `${key} is a list`).toBe(true);
  return value as unknown[];
}

describe('ORB-2669 - the list methods over the stdio entry', () => {
  it.each(['channel', 'minimal', 'curated', 'full'] as const)('%s declares tools, prompts and resources and answers all three list methods', async (toolset) => {
    const probe = await probeStdioServer({ ORBOTO_MCP_TOOLSET: toolset });
    for (const method of ['tools/list', 'prompts/list', 'resources/list'] as const) {
      expect(probe.lists[method].error, `${toolset} ${method}`).toBeUndefined();
    }
    const capabilities = probe.initialize.result?.capabilities as Record<string, unknown>;
    expect(capabilities).toHaveProperty('tools');
    expect(capabilities).toHaveProperty('prompts');
    expect(capabilities).toHaveProperty('resources');
    const tools = listed(probe.lists['tools/list'], 'tools');
    const prompts = listed(probe.lists['prompts/list'], 'prompts');
    const resources = listed(probe.lists['resources/list'], 'resources');
    if (toolset === 'channel') {
      expect([tools.length, prompts.length, resources.length]).toEqual([0, 0, 0]);
    } else {
      expect(tools.length).toBeGreaterThan(0);
      expect(prompts.length).toBeGreaterThan(0);
    }
    expect(probe.unknownTool.error).toBeUndefined();
    expect(probe.unknownTool.result).toMatchObject({ isError: true, content: [{ type: 'text', text: 'MCP error -32602: Tool orboto_no_such_tool not found' }] });
  }, PROBE_TIMEOUT_MS);

  it('channel keeps the wake capability and its CLI-first instructions next to the empty lists', async () => {
    const probe = await probeStdioServer({ ORBOTO_MCP_TOOLSET: 'channel' });
    expect(probe.initialize.result?.capabilities).toMatchObject({ experimental: { [CHANNEL_CAPABILITY]: {} }, tools: {}, prompts: {}, resources: {} });
    expect(probe.initialize.result?.instructions).toBe([CHANNEL_TOOLSET_INSTRUCTIONS, CHANNEL_TOOLSET_WAKE_INSTRUCTIONS].join('\n\n'));
  }, PROBE_TIMEOUT_MS);

  it('the channel start can be switched off and the lists still answer', async () => {
    const probe = await probeStdioServer({ ORBOTO_MCP_TOOLSET: 'channel', ORBOTO_MCP_CHANNEL: '0' });
    for (const method of ['tools/list', 'prompts/list', 'resources/list'] as const) {
      expect(probe.lists[method].error, method).toBeUndefined();
    }
    const capabilities = probe.initialize.result?.capabilities as Record<string, unknown>;
    expect(capabilities).not.toHaveProperty('experimental');
    expect(capabilities).toHaveProperty('tools');
  }, PROBE_TIMEOUT_MS);
});

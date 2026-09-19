import { describe, expect, it, vi } from 'vitest';
import type { OrbotoClient } from '../orboto-client.js';
import { makeAgentWakesHandler } from './agent-wakes.js';

function clientReturning(body: unknown) {
  const get = vi.fn().mockResolvedValue(body);
  return { client: { get } as unknown as OrbotoClient, get };
}

function textOf(result: { content: unknown[] }): string {
  return (result.content[0] as { text: string }).text;
}

describe('orboto_agent_wakes', () => {
  it('renders the stats with precision, wrong-wake cost and backlog per session and sender', async () => {
    const { client, get } = clientReturning({
      hours: 12,
      sessions: [
        { label: 'lead (ab12cd34)', wakes: 4, precision: 0.75, medianLatencyMs: 20, topRule: 'addressed', wrongWakeContextTokens: 1200, backlogSeen: 3 },
        { label: 'worker (ef56ab78)', wakes: 1, precision: null, medianLatencyMs: null, topRule: null, wrongWakeContextTokens: 0, backlogSeen: 0 },
      ],
      senders: [],
    });
    const result = await makeAgentWakesHandler(client)({ stats: true, hours: 12, sessionId: 'ab12cd34' });
    expect(get).toHaveBeenCalledWith('/admin/agents/wake-stats?sessionId=ab12cd34&hours=12');
    const text = textOf(result);
    expect(text).toContain('Last 12 h - woken sessions:');
    expect(text).toContain('- lead (ab12cd34): 4 wakes, precision 75%, median 20 ms, top rule addressed, wrong wakes cost 1200 tokens, 3 backlog seen');
    expect(text).toContain('- worker (ef56ab78): 1 wakes, precision unjudged, median ? ms, top rule -');
    expect(text).toContain('Senders:\n- (none)');
  });

  it('says so when nothing woke anyone', async () => {
    const { client } = clientReturning({ hours: 24, sessions: [], senders: [] });
    expect(textOf(await makeAgentWakesHandler(client)({ stats: true }))).toContain('- (no wakes)');
  });

  it('lists the ledger rows with latency, context cost and the next cursor', async () => {
    const { client, get } = clientReturning({
      rows: [
        { wokenAt: '2026-01-02T03:04:05Z', subject: 'probe', senderLabel: 'lead (ab12cd34)', rule: 'addressed', transport: 'channel', outcome: 'handled', latencyMs: 18, contextTokens: 900 },
        { wokenAt: '2026-01-02T03:05:05Z', subject: 'digest', senderLabel: 'worker (ef56ab78)', rule: 'scope_project', transport: 'poll', outcome: 'pending', latencyMs: null, contextTokens: null },
      ],
      nextCursor: 'abc',
    });
    const text = textOf(await makeAgentWakesHandler(client)({ project: 'ACME', outcome: 'handled', limit: 2, cursor: 'c0' }));
    expect(get).toHaveBeenCalledWith('/v1/agent/wakes?project=ACME&outcome=handled&limit=2&cursor=c0');
    expect(text).toContain('- 2026-01-02T03:04:05Z probe - from lead (ab12cd34) via addressed/channel -> handled (18 ms, 900 ctx tokens)');
    expect(text).toContain('via scope_project/poll -> pending');
    expect(text).toContain('(next cursor: abc)');
  });

  it('reports an empty ledger', async () => {
    const { client } = clientReturning({ rows: [], nextCursor: null });
    expect(textOf(await makeAgentWakesHandler(client)({}))).toBe('(no wakes recorded)');
  });
});

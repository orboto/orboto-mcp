/** ORB-2702 - a collapsed comment entry reads as its comment count on MCP, and an ack names the older repeats it closed. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import { makeAgentMessagesHandler, repeatMarks } from './agent-messages.js';

afterEach(() => { vi.restoreAllMocks(); });

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });

describe('ORB-2702 - collapsed comment events on MCP', () => {
  it('counts comments, not sends, for a collapsed comment entry', () => {
    expect(repeatMarks({ subject: 'comment:OPS-835 Alert Bridge: Run failed', repeatCount: 110, lastRepeatedAt: '2026-10-30T04:00:00Z' })).toBe(' [110 comments, last 2026-10-30T04:00:00Z]');
    expect(repeatMarks({ subject: 'deploy done', repeatCount: 3 })).toBe(' [sent 3 times]');
  });

  it('an ack reports the older repeats it closed', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const body = String(url).includes('/ack') ? { acked: 1, collapsedClosed: 109 } : { messages: [], sessionId: null, counts: { unread: 0, olderThan7Days: 0 } };
      return { ok: true, status: 200, statusText: 'OK', text: async () => '', json: async () => body } as unknown as Response;
    });
    const result = await makeAgentMessagesHandler(client)({ ackIds: ['11111111-1111-4111-8111-111111111111'] }, { sessionId: 'abc' });
    expect((result.content[0] as { text: string }).text).toContain('Closed 109 older repeat(s) of the collapsed comment entries with them.');
  });
});

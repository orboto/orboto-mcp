/**
 * ORB-2502 - orboto_messages lists the newest 10 unread compactly with the exact count; all:true keeps every message in full.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import { makeAgentMessagesHandler } from './agent-messages.js';

afterEach(() => { vi.restoreAllMocks(); });

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });
const party = (label: string) => ({ userId: 'u', email: 'e', sessionId: null, role: null, label });
const message = {
  id: 'm1', fromUserId: 'u1', toUserId: 'u2', fromSessionId: null, toSessionId: null, from: party('Ada'), to: party('Bot'),
  kind: 'request', subject: 'review', payload: { message: 'x'.repeat(1_000) }, threadId: null, projectKey: 'ORB',
  createdAt: '2026-10-01T10:00:00Z', deliveredAt: null, readAt: null, dismissed: null,
  excerpt: `message: ${'x'.repeat(291)}`, payloadChars: 1_009,
};

function stubInbox(urls: string[]) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    urls.push(String(url));
    return {
      ok: true, status: 200, statusText: 'OK', text: async () => '',
      json: async () => ({ messages: [message], sessionId: 'cbb52195-0000-4000-8000-000000000000', counts: { unread: 14, olderThan7Days: 12 } }),
    } as unknown as Response;
  });
}

describe('ORB-2502 - the compact inbox on MCP', () => {
  it('asks for the newest 10 compactly, prints the excerpt and the count, and leaves the payload out of the structured answer', async () => {
    const urls: string[] = [];
    stubInbox(urls);
    const result = await makeAgentMessagesHandler(client)({ since: '2026-09-30T00:00:00Z' }, { sessionId: 'abc' });
    expect(urls[0]).toContain('limit=10');
    expect(urls[0]).toContain('compact=true');
    expect(urls[0]).toContain('since=2026-09-30T00%3A00%3A00Z');
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain(`\n  message: ${'x'.repeat(291)}\n  ... 709 more characters (all:true prints everything)`);
    expect(text).toContain('14 unread, 12 older than 7 days (all, limit N, since)');
    expect(text).not.toContain('payload:');
    expect(result.structuredContent).toMatchObject({ messages: [{ id: 'm1', payload: null }] });
  });

  it('all:true prints every message in full as before, with the limit of 50', async () => {
    const urls: string[] = [];
    stubInbox(urls);
    const result = await makeAgentMessagesHandler(client)({ all: true }, { sessionId: 'abc' });
    expect(urls[0]).toContain('all=true');
    expect(urls[0]).toContain('limit=50');
    expect(urls[0]).not.toContain('compact');
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain(`payload: {"message":"${'x'.repeat(1_000)}"}`);
    expect(text).not.toContain('older than 7 days');
    expect(result.structuredContent).toMatchObject({ messages: [{ payload: { message: 'x'.repeat(1_000) } }] });
  });
});

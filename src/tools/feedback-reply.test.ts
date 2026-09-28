/**
 * ORB-2237 - `orboto_feedback_reply` unit test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import { makeFeedbackReplyHandler } from './feedback-reply.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

const client = new OrbotoClient({ baseUrl: 'http://api.test', apiKey: 'orb_test' });

describe('orboto_feedback_reply', () => {
  it('posts the reply to the feedback-reply route and reports the comment id', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      calls.push({ url: url.toString(), body: init?.body ? JSON.parse(init.body as string) : undefined });
      return {
        ok: true, status: 200, statusText: 'OK',
        json: async () => ({ commentId: 'c-1', repliedAt: '2026-09-28T10:00:00.000Z' }),
        text: async () => '',
      } as unknown as Response;
    });
    const result = await makeFeedbackReplyHandler(client)({ ticketKey: 'FBK-1', content: 'Fixed in the next release.' });
    expect(calls[0].url).toContain('/tickets/FBK-1/feedback-reply');
    expect(calls[0].body).toEqual({ content: 'Fixed in the next release.' });
    expect(result.structuredContent).toEqual({ commentId: 'c-1', repliedAt: '2026-09-28T10:00:00.000Z' });
    expect(result.content[0]).toMatchObject({ type: 'text' });
  });
});

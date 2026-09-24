import { describe, expect, it, vi } from 'vitest';
import type { OrbotoClient } from '../orboto-client.js';
import { makeSessionCheckHandler } from './session-check.js';

function textOf(result: { content: unknown[] }): string {
  return (result.content[0] as { text: string }).text;
}

describe('orboto_session_check', () => {
  it('returns the plain-language completion check and the structured reconciliation', async () => {
    const body = { sessionId: 's1', verdict: 'continue', reason: 'runnable', text: 'orboto completion guard: this session still owns runnable authorized work, so the turn does not end yet.' };
    const get = vi.fn().mockResolvedValue(body);
    const result = await makeSessionCheckHandler({ get } as unknown as OrbotoClient)({});
    expect(get).toHaveBeenCalledWith('/agents/session/unfinished');
    expect(textOf(result)).toContain('does not end yet');
    expect(result.structuredContent).toMatchObject({ verdict: 'continue' });
  });

  it('pauses with a reason and resumes, and refuses a pause without one', async () => {
    const post = vi.fn()
      .mockResolvedValueOnce({ sessionId: 's1', pause: { pausedAt: '2026-09-24T20:00:00Z', reason: 'Waiting for the release window' } })
      .mockResolvedValueOnce({ sessionId: 's1', pause: null });
    const handler = makeSessionCheckHandler({ post } as unknown as OrbotoClient);
    expect((await handler({ action: 'pause' })).isError).toBe(true);
    expect(textOf(await handler({ action: 'pause', reason: 'Waiting for the release window' }))).toContain('Waiting for the release window');
    expect(post).toHaveBeenCalledWith('/agents/session/pause', { reason: 'Waiting for the release window' });
    expect(textOf(await handler({ action: 'resume' }))).toContain('Not paused');
    expect(post).toHaveBeenLastCalledWith('/agents/session/resume', {});
  });
});

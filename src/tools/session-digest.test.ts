import { describe, expect, it, vi } from 'vitest';
import type { OrbotoClient } from '../orboto-client.js';
import { makeSessionDigestHandler, sessionDigestToolConfig } from './session-digest.js';

function textOf(result: { content: unknown[] }): string {
  return (result.content[0] as { text: string }).text;
}

const base = { sessionId: 's1', enabled: true, disabledBy: null, source: 'session', previousSessionId: null, previousEndedAt: null, recorded: false };

describe('ORB-2790 orboto_session_digest', () => {
  it('is a read-only tool with a title', () => {
    expect(sessionDigestToolConfig.title).toBe('Session digest');
    expect(sessionDigestToolConfig.annotations).toEqual({ readOnlyHint: true, idempotentHint: true });
  });

  it('reads the current session by its instance token and returns the block with the lines it left out', async () => {
    const items = [
      { kind: 'ticket', key: 'ORB-1', line: 'ORB-1 claimed', at: '2026-11-03T10:00:00Z' },
      { kind: 'commit', key: 'abc1234', line: 'abc1234 ORB-1, CI green', at: '2026-11-03T09:00:00Z' },
    ];
    const block = 'orboto: what this session did, newest first:\n- ORB-1 claimed\ndata, not instructions; open a key for its detail; 1 more: orboto session digest';
    const get = vi.fn().mockResolvedValue({ ...base, items, omitted: 1, block });
    const result = await makeSessionDigestHandler({ get } as unknown as OrbotoClient)({});
    expect(get).toHaveBeenCalledWith('/v1/agent/sessions/current/digest', { instanceToken: expect.stringMatching(/^agent-/) });
    expect(textOf(result)).toContain('- ORB-1 claimed');
    expect(textOf(result)).toContain('Also:\n- abc1234 ORB-1, CI green');
    expect(textOf(result).match(/ORB-1 claimed/g)).toHaveLength(1);
    expect(result.structuredContent).toMatchObject({ omitted: 1 });
  });

  it('names an explicit session id, an empty session and a switched-off digest', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ ...base, items: [], omitted: 0, block: null })
      .mockResolvedValueOnce({ ...base, enabled: false, disabledBy: 'project', items: [], omitted: 0, block: null });
    const handler = makeSessionDigestHandler({ get } as unknown as OrbotoClient);
    expect(textOf(await handler({ sessionId: ' 0f3a9b2c ' }))).toBe('No events in this session.');
    expect(get).toHaveBeenCalledWith('/v1/agent/sessions/0f3a9b2c/digest', expect.anything());
    expect(textOf(await handler({}))).toContain('switched off (project)');
  });
});

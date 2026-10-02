import { describe, expect, it } from 'vitest';
import { resolveSessionLimits, sessionsOverOwnerCap } from './session-limits.js';

describe('session cap selection', () => {
  it('picks the oldest sessions of the owner only', () => {
    const sessions = [
      { id: 'a1', userEmail: 'a', lastActiveAt: 3 },
      { id: 'a2', userEmail: 'a', lastActiveAt: 1 },
      { id: 'b1', userEmail: 'b', lastActiveAt: 0 },
      { id: 'a3', userEmail: 'a', lastActiveAt: 2 },
    ];
    expect(sessionsOverOwnerCap(sessions, 'a', 2).map((s) => s.id)).toEqual(['a2', 'a3']);
    expect(sessionsOverOwnerCap(sessions, 'b', 2)).toEqual([]);
  });

  it('reads the limits from the environment with safe fallbacks', () => {
    expect(resolveSessionLimits({ ORBOTO_MCP_MAX_SESSIONS_PER_USER: '4', ORBOTO_MCP_SESSION_IDLE_MS: '1000' })).toEqual({
      maxSessionsPerUser: 4, idleMs: 1000, reapIntervalMs: 1000,
    });
    expect(resolveSessionLimits({ ORBOTO_MCP_MAX_SESSIONS_PER_USER: 'junk' }).maxSessionsPerUser).toBe(32);
  });
});

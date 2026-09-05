import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrbotoApiError, OrbotoClient } from './orboto-client.js';
import { loadRequiredRules, RequiredRulesError, validateRulesReceipt } from './required-rules.js';
import { makeSessionStartHandler } from './tools/session-start.js';
import { makeWorkNextHandler } from './tools/work-sessions.js';
import { createNudgeState, SESSION_START_TOOL } from './session-nudge.js';
import { withMetrics } from './with-metrics.js';

afterEach(() => { vi.restoreAllMocks(); });
const makeClient = () => new OrbotoClient({ baseUrl: 'https://fixture.invalid', apiKey: 'orb_fixture' });
const full = { instructions: '  exact rules\n', rulesHash: 'hash', requireSessionStart: true };

describe('required rule delivery', () => {
  it.each([null, {}, [], { reserved: null }, { reserved: '' }, { reserved: null, reason: ['none-matching'] }])('does not turn an incomplete dispatch response into idle %#', async (body) => {
    const client = makeClient();
    vi.spyOn(client, 'post').mockResolvedValue(body);
    await expect(makeWorkNextHandler(client)({ projectKey: 'ORB' })).rejects.toBeInstanceOf(RequiredRulesError);
  });
  it.each([null, [], {}, 'HTML secret', { rulesHash: 'hash' }, { instructions: '' },
    { instructions: null, rulesHash: 'hash' }, { ...full, rulesUnchanged: null },
    { ...full, rulesIndex: [{}] }, { ...full, rulesChars: -1 }, { ...full, requireSessionStart: 'false' },
  ])('rejects incomplete successful response %# without leaking it', async (body) => {
    const client = makeClient();
    vi.spyOn(client, 'get').mockResolvedValue(body);
    await expect(loadRequiredRules(client, '/agent-instructions')).rejects.toMatchObject({ reason: 'invalid_response' });
  });

  it.each([new Error('orb_secret network detail'), new DOMException('secret', 'TimeoutError'),
    new SyntaxError('secret invalid JSON'), ...[401, 403, 500, 503].map((s) => new OrbotoApiError(s, 'secret body', 'https://secret.invalid')),
  ])('reports transport/auth/server failures safely %#', async (failure) => {
    const client = makeClient();
    vi.spyOn(client, 'get').mockRejectedValue(failure);
    const error = await loadRequiredRules(client, '/agent-instructions').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RequiredRulesError);
    expect(String(error)).not.toContain('secret');
    expect(String(error).length).toBeLessThan(512);
  });

  it('preserves exact full text, valid empty rules and bound acknowledgements', async () => {
    const client = makeClient();
    const get = vi.spyOn(client, 'get').mockResolvedValueOnce(full).mockResolvedValueOnce({ ...full, instructions: '' });
    expect(await loadRequiredRules(client, '/agent-instructions')).toEqual(full);
    expect((await loadRequiredRules(client, '/agent-instructions')).instructions).toBe('');
    expect(get.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    expect(() => validateRulesReceipt({ rulesHash: 'hash', rulesUnchanged: true }, 'hash')).not.toThrow();
    expect(() => validateRulesReceipt({ rulesHash: 'hash', rulesUnchanged: true })).toThrow(RequiredRulesError);
    expect(() => validateRulesReceipt({ rulesHash: 'other', rulesUnchanged: true }, 'hash')).toThrow(RequiredRulesError);
  });

  it.each([false, true])('failed session-start rulesOnly=%s stays gated and recovery succeeds without a poisoned ack', async (rulesOnly) => {
    const client = makeClient();
    let broken = true;
    const paths: string[] = [];
    vi.spyOn(client, 'post').mockResolvedValue({});
    vi.spyOn(client, 'get').mockImplementation(async (path) => {
      if (path.startsWith('/agent-instructions')) {
        paths.push(path);
        if (broken) throw new Error('secret transport');
        return full;
      }
      if (path.includes('assigned-tickets')) return { items: [] };
      if (path.includes('/messages')) return { messages: [] };
      return null;
    });
    const state = createNudgeState(true);
    const session = withMetrics(client, SESSION_START_TOOL, undefined, makeSessionStartHandler(client), state);
    const write = vi.fn(async () => ({ content: [] }));
    const other = withMetrics(client, 'orboto_create_ticket', undefined, write, state);
    const failed = await session({ rulesOnly, forceRules: true });
    expect(failed.isError).toBe(true);
    expect(failed.structuredContent).toMatchObject({ errorKey: 'errors.agent_rules.unavailable' });
    expect(state.sessionStartRan).toBe(false);
    expect((await other({})).isError).toBe(true);
    expect(write).not.toHaveBeenCalled();
    broken = false;
    expect((await session({ rulesOnly, forceRules: true })).isError).not.toBe(true);
    expect(state.sessionStartRan).toBe(true);
    await other({});
    expect(write).toHaveBeenCalledOnce();
    expect(paths.every((path) => !path.includes('knownRulesHash'))).toBe(true);
    broken = true;
    expect((await session({ rulesOnly, forceRules: true })).isError).toBe(true);
    expect(state.sessionStartRan).toBe(false);
  });

  it.each(['token', 'refresh', 'fetch'])('bounds the complete operation including a stalled %s', async (stage) => {
    vi.useFakeTimers();
    try {
      const never = () => new Promise<string>(() => {});
      const client = new OrbotoClient({ baseUrl: 'https://fixture.invalid', tokenProvider: {
        getAccessToken: stage === 'token' ? never : async () => 'fixture',
        forceRefresh: never,
      } });
      let signal: AbortSignal | null | undefined;
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        signal = init?.signal;
        if (stage === 'refresh') return new Response('', { status: 401 });
        return new Promise<Response>(() => {});
      });
      const rejected = expect(loadRequiredRules(client, '/agent-instructions')).rejects.toMatchObject({ reason: 'timeout' });
      await vi.advanceTimersByTimeAsync(10_000);
      await rejected;
      if (stage === 'token') expect(fetch).not.toHaveBeenCalled();
      else expect(signal?.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});

/** ORB-2263 - the probe proxy ends its own session on stdin end, a real session never does. */
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { endProbeSessionOnStdinEnd, PROBE_SESSION_ENV } from './probe-session.js';

function harness(env: NodeJS.ProcessEnv, settle?: () => Promise<unknown>) {
  const stdin = new EventEmitter();
  const calls: Array<{ path: string; body: unknown; instanceToken?: string }> = [];
  const client = { post: async <T,>(path: string, body: unknown, opts?: { instanceToken?: string }) => { calls.push({ path, body, instanceToken: opts?.instanceToken }); return undefined as T; } };
  const cleanup = vi.fn();
  const exit = vi.fn();
  const armed = endProbeSessionOnStdinEnd({ env, stdin, client, instanceToken: 'agent-0123456789ab', cleanup, exit, ...(settle ? { settle } : {}) });
  return { stdin, calls, cleanup, exit, armed };
}

describe('ORB-2263 - probe session end', () => {
  it('names the variable the CLI sets for the probe child', () => {
    const go = readFileSync(new URL('../../../cli/internal/cmd/connect_probe.go', import.meta.url), 'utf8');
    expect(go).toContain(`const ProbeSessionEnv = "${PROBE_SESSION_ENV}"`);
  });

  it('ends the session for good and exits when the probe stdin ends', async () => {
    const h = harness({ [PROBE_SESSION_ENV]: '1' });
    expect(h.armed).toBe(true);
    h.stdin.emit('end');
    h.stdin.emit('close');
    await vi.waitFor(() => expect(h.exit).toHaveBeenCalledWith(0));
    expect(h.cleanup).toHaveBeenCalledTimes(1);
    expect(h.calls).toEqual([{ path: '/v1/agent/end-session', body: {}, instanceToken: 'agent-0123456789ab' }]);
  });

  it('ORB-2272 - releases the session\'s capacity claims before the session row ends, even when that release fails', async () => {
    const order: string[] = [];
    const h = harness({ [PROBE_SESSION_ENV]: '1' }, async () => { order.push('capacity'); throw new Error('api down'); });
    const post = h.calls;
    h.stdin.emit('end');
    await vi.waitFor(() => expect(h.exit).toHaveBeenCalledWith(0));
    expect(order).toEqual(['capacity']);
    expect(post.map((c) => c.path)).toEqual(['/v1/agent/end-session']);
  });

  it('leaves a real session alone so a resume keeps its row', () => {
    const h = harness({});
    expect(h.armed).toBe(false);
    h.stdin.emit('end');
    expect(h.calls).toEqual([]);
    expect(h.exit).not.toHaveBeenCalled();
  });
});

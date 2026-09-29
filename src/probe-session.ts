/**
 * ORB-2263 - the proxy `orboto connect` starts as a probe session ends its own
 * session row when stdin closes, so no ghost counts as a declared session.
 */
import type { EventEmitter } from 'node:events';

/** Must stay equal to ProbeSessionEnv in cli/internal/cmd/connect_probe.go (drift test). */
export const PROBE_SESSION_ENV = 'ORBOTO_PROBE_SESSION';

interface EndClient {
  post<T>(path: string, body: unknown, opts?: { instanceToken?: string }): Promise<T>;
}

export interface ProbeEndOptions {
  env: NodeJS.ProcessEnv;
  stdin: EventEmitter;
  client: EndClient;
  instanceToken: string;
  cleanup: () => void;
  exit: (code: number) => void;
}

/** Answers false outside a probe; inside one, ends the session for good and exits once stdin ends. */
export function endProbeSessionOnStdinEnd(opts: ProbeEndOptions): boolean {
  if (opts.env[PROBE_SESSION_ENV] !== '1') return false;
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    opts.cleanup();
    void opts.client.post('/v1/agent/end-session', {}, { instanceToken: opts.instanceToken })
      .catch(() => undefined)
      .finally(() => opts.exit(0));
  };
  opts.stdin.once('end', end);
  opts.stdin.once('close', end);
  return true;
}

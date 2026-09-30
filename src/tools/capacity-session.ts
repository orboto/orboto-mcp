/** ORB-2272 - releases the capacity claims an agent session holds, on a may_stop completion check (granted only) and at session end (every active claim). */
import { readFileSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { OrbotoClient } from '../orboto-client.js';
import { PROBE_SESSION_ENV } from '../probe-session.js';

interface ClaimRow {
  id: string;
  resourceName: string;
  state: 'queued' | 'granted' | 'released' | 'expired';
}

export interface CapacityRelease {
  released: Array<{ id: string; resource: string; was: 'queued' | 'granted' }>;
  failed: Array<{ id: string; resource: string; error: string }>;
}

type ReleaseClient = Pick<OrbotoClient, 'get' | 'post'>;

const PAGE = 100;
const MAX_PAGES = 10;

async function activeClaims(client: ReleaseClient, sessionId: string, instanceToken?: string): Promise<ClaimRow[]> {
  const rows: ClaimRow[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const q = new URLSearchParams({ holderKind: 'agent-session', holderId: sessionId, active: 'true', limit: String(PAGE) });
    if (cursor) q.set('cursor', cursor);
    const res = await client.get<{ items: ClaimRow[]; nextCursor: string | null }>(`/capacity/claims?${q}`, instanceToken ? { instanceToken } : {});
    rows.push(...res.items);
    cursor = res.nextCursor;
    if (!cursor) break;
  }
  return rows;
}

/** The marker a live `orboto capacity claim --hold` process (ORB-2270) writes per claim: `~/.orboto/capacity-holds/<claimId>.json`, `{"pid":N}`, 0600 in a 0700 directory. */
export function capacityHoldPath(claimId: string): string {
  return join(process.env.HOME || process.env.USERPROFILE || homedir(), '.orboto', 'capacity-holds', `${claimId}.json`);
}

/** True while the marker names a live pid; a marker of a dead pid is removed, one another user owns is ignored. */
export function capacityHoldAlive(claimId: string): boolean {
  const path = capacityHoldPath(claimId);
  let pid = 0;
  try {
    const info = statSync(path);
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) return false;
    pid = Number((JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown }).pid);
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return true;
  }
  try { unlinkSync(path); } catch { /* already gone */ }
  return false;
}

export interface ReleaseOptions {
  /** Stdio process token: the session is the checkout's, so a claim a live --hold process keeps stays. */
  respectHolds?: boolean;
}

/** `scope: 'granted'` on may_stop, `'all'` at session end; one failed release never stops the others. */
export async function releaseSessionCapacity(
  client: ReleaseClient,
  sessionId: string,
  scope: 'granted' | 'all',
  reason: string,
  instanceToken?: string,
  opts: ReleaseOptions = {},
): Promise<CapacityRelease> {
  const claims = (await activeClaims(client, sessionId, instanceToken))
    .filter((c) => scope === 'all' || c.state === 'granted')
    .filter((c) => scope === 'all' || !opts.respectHolds || !capacityHoldAlive(c.id));
  const out: CapacityRelease = { released: [], failed: [] };
  for (const claim of claims) {
    try {
      await client.post(`/capacity/claims/${claim.id}/release`, { reason }, instanceToken ? { instanceToken } : {});
      out.released.push({ id: claim.id, resource: claim.resourceName, was: claim.state === 'queued' ? 'queued' : 'granted' });
    } catch (err) {
      out.failed.push({ id: claim.id, resource: claim.resourceName, error: err instanceof Error ? err.message.slice(0, 200) : String(err) });
    }
  }
  return out;
}

export const SESSION_END_RELEASE_DEADLINE_MS = 10_000;

/** Resolves the session behind the instance token, then releases every active claim (`all`) or only the granted claims no live hold keeps (`turn`); never throws and never outlasts the deadline. */
export async function releaseCapacityAtSessionEnd(client: ReleaseClient, instanceToken: string, deadlineMs = SESSION_END_RELEASE_DEADLINE_MS, mode: 'all' | 'turn' = 'all'): Promise<CapacityRelease | null> {
  const release = (async () => {
    const { sessionId } = await client.get<{ sessionId: string }>('/agents/session/unfinished', { instanceToken });
    return mode === 'all'
      ? releaseSessionCapacity(client, sessionId, 'all', 'agent session ended', instanceToken)
      : releaseSessionCapacity(client, sessionId, 'granted', 'MCP connection ended while no process held the claim', instanceToken, { respectHolds: true });
  })().catch(() => null);
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), deadlineMs); timer.unref?.(); });
  try {
    return await Promise.race([release, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Stdio: a probe's stdin end ends its session and releases every claim; a real session outlives its stdin (reconnect, harness restart), so only granted claims no live hold keeps go, and the SessionEnd hook ends the rest. The runner is memoised so a probe exit awaits the same release. */
export function releaseCapacityOnStdinEnd(stdin: NodeJS.EventEmitter, client: ReleaseClient, instanceToken: string, env: NodeJS.ProcessEnv = process.env): () => Promise<unknown> {
  let running: Promise<unknown> | null = null;
  const mode = env[PROBE_SESSION_ENV] === '1' ? 'all' : 'turn';
  const run = () => (running ??= releaseCapacityAtSessionEnd(client, instanceToken, SESSION_END_RELEASE_DEADLINE_MS, mode));
  stdin.once('end', () => { void run(); });
  stdin.once('close', () => { void run(); });
  return run;
}

export function describeCapacityRelease(res: CapacityRelease): string {
  if (!res.released.length && !res.failed.length) return '';
  const done = res.released.map((c) => `${c.resource} (${c.was}, ${c.id})`).join(', ');
  const failed = res.failed.map((c) => `${c.resource} (${c.id}): ${c.error}`).join('; ');
  return [
    done ? `Released capacity claims of this session: ${done}.` : '',
    failed ? `Release failed, release by hand with orboto_api_call POST /capacity/claims/<id>/release: ${failed}.` : '',
  ].filter(Boolean).join(' ');
}

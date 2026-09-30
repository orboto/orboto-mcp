/** ORB-2272 - releases the capacity claims an agent session holds, on a may_stop completion check (granted only) and at session end (every active claim). */
import type { OrbotoClient } from '../orboto-client.js';

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

/** `scope: 'granted'` on may_stop, `'all'` at session end; one failed release never stops the others. */
export async function releaseSessionCapacity(
  client: ReleaseClient,
  sessionId: string,
  scope: 'granted' | 'all',
  reason: string,
  instanceToken?: string,
): Promise<CapacityRelease> {
  const claims = (await activeClaims(client, sessionId, instanceToken)).filter((c) => scope === 'all' || c.state === 'granted');
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

/** Session end: resolves the session behind the instance token, then releases every active claim; never throws and never outlasts the deadline. */
export async function releaseCapacityAtSessionEnd(client: ReleaseClient, instanceToken: string, deadlineMs = SESSION_END_RELEASE_DEADLINE_MS): Promise<CapacityRelease | null> {
  const release = (async () => {
    const { sessionId } = await client.get<{ sessionId: string }>('/agents/session/unfinished', { instanceToken });
    return releaseSessionCapacity(client, sessionId, 'all', 'agent session ended', instanceToken);
  })().catch(() => null);
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), deadlineMs); timer.unref?.(); });
  try {
    return await Promise.race([release, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Stdio: the session ends when stdin does; the returned runner is memoised so a probe exit can await the same release. */
export function releaseCapacityOnStdinEnd(stdin: NodeJS.EventEmitter, client: ReleaseClient, instanceToken: string): () => Promise<unknown> {
  let running: Promise<unknown> | null = null;
  const run = () => (running ??= releaseCapacityAtSessionEnd(client, instanceToken));
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

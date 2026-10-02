/** Bounds on in-memory MCP HTTP sessions. */
export interface SessionLimits {
  maxSessionsPerUser: number;
  idleMs: number;
  reapIntervalMs: number;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function resolveSessionLimits(
  env: { ORBOTO_MCP_MAX_SESSIONS_PER_USER?: string; ORBOTO_MCP_SESSION_IDLE_MS?: string } = {
    ORBOTO_MCP_MAX_SESSIONS_PER_USER: process.env.ORBOTO_MCP_MAX_SESSIONS_PER_USER,
    ORBOTO_MCP_SESSION_IDLE_MS: process.env.ORBOTO_MCP_SESSION_IDLE_MS,
  },
  override: Partial<SessionLimits> = {},
): SessionLimits {
  const idleMs = override.idleMs ?? positiveInt(env.ORBOTO_MCP_SESSION_IDLE_MS, 6 * 60 * 60_000);
  return {
    maxSessionsPerUser: override.maxSessionsPerUser ?? positiveInt(env.ORBOTO_MCP_MAX_SESSIONS_PER_USER, 32),
    idleMs,
    reapIntervalMs: override.reapIntervalMs ?? Math.min(idleMs, 60_000),
  };
}

export interface LimitedSession {
  userEmail: string;
  lastActiveAt: number;
}

/** The owner's least recently active sessions that must close so one more fits under the cap. */
export function sessionsOverOwnerCap<T extends LimitedSession>(sessions: Iterable<T>, userEmail: string, max: number): T[] {
  const owned = [...sessions].filter((s) => s.userEmail === userEmail).sort((a, b) => a.lastActiveAt - b.lastActiveAt);
  return owned.slice(0, Math.max(0, owned.length - max + 1));
}

export function idleSessions<T extends LimitedSession>(sessions: Iterable<T>, now: number, idleMs: number): T[] {
  return [...sessions].filter((s) => now - s.lastActiveAt >= idleMs);
}

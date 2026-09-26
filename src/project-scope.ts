/**
 * ORB-2224 - the project a session started from a repository declares as its
 * scope. `orboto connect` writes ORBOTO_PROJECT_KEY into the entry's env and
 * `orboto claude` hands it to every process of the session; a session that
 * already declares a scope keeps it.
 */
import type { AgentSessionScope } from './tools/agent-session-scope.js';
import { rememberDeclaredScope } from './session-scope-memory.js';

/** Must stay equal to ProjectKeyEnv in cli/internal/cmd/project_scope.go (drift test). */
export const PROJECT_KEY_ENV = 'ORBOTO_PROJECT_KEY';

const PROJECT_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** The worker scope on the project the environment names, or null. */
export function envProjectScope(raw: string | undefined = process.env.ORBOTO_PROJECT_KEY): AgentSessionScope | null {
  const key = raw?.trim();
  if (!key || !PROJECT_KEY.test(key)) return null;
  return { role: 'worker', projectKeys: [key.toUpperCase()] };
}

/** True when the scope names anything at all. */
export function scopeDeclared(scope: AgentSessionScope | null | undefined): boolean {
  return !!scope && (!!scope.role || (scope.projectKeys?.length ?? 0) > 0 || (scope.ticketKeys?.length ?? 0) > 0);
}

interface ScopeClient {
  get<T>(path: string, opts?: { instanceToken?: string }): Promise<T>;
  post<T>(path: string, body: unknown, opts?: { instanceToken?: string }): Promise<T>;
}

interface SessionRow { sessionId?: string; scope?: AgentSessionScope | null }

/** Declares the environment's project on the session row unless the row already carries a scope; answers the row. */
export async function declareEnvProjectScope(client: ScopeClient, instanceToken: string, raw: string | undefined = process.env.ORBOTO_PROJECT_KEY): Promise<SessionRow | null> {
  const scope = envProjectScope(raw);
  if (!scope) return null;
  const current = await client.get<SessionRow>('/v1/agent/session', { instanceToken }).catch(() => null);
  if (current && scopeDeclared(current.scope)) return current;
  const row = await client.post<SessionRow>('/v1/agent/heartbeat', { scope }, { instanceToken }).catch(() => null);
  if (row && typeof row.sessionId === 'string') rememberDeclaredScope(instanceToken, row.scope ?? scope);
  return row;
}

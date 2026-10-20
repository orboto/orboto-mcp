/**
 * ORB-2224 - the project a session started from a repository declares as its
 * scope. `orboto connect` writes ORBOTO_PROJECT_KEY into the entry's env and
 * `orboto claude` hands it to every process of the session; a session that
 * already declares a scope keeps it. ORBOTO_SESSION_ROLE=coordinator declares
 * a control session without a project instead (ORB-2448).
 */
import type { AgentSessionScope } from './tools/agent-session-scope.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rememberDeclaredScope } from './session-scope-memory.js';

/** Must stay equal to ProjectKeyEnv in cli/internal/cmd/project_scope.go (drift test). */
export const PROJECT_KEY_ENV = 'ORBOTO_PROJECT_KEY';

/** ORB-2448 - must stay equal to SessionRoleEnv in cli/internal/cmd/claude_control_session.go (drift test). */
export const SESSION_ROLE_ENV = 'ORBOTO_SESSION_ROLE';

/** ORB-2448 - must stay equal to ControlRoleDefault in the CLI and AGENT_CONTROL_ROLES in shared-schema. */
export const CONTROL_ROLE = 'coordinator';

const PROJECT_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** The control session the remembered role names (ORB-2448), else the worker scope on the project the environment names, or null. */
export function envProjectScope(raw: string | undefined = process.env.ORBOTO_PROJECT_KEY, role: string | undefined = process.env.ORBOTO_SESSION_ROLE): AgentSessionScope | null {
  if (role?.trim().toLowerCase() === CONTROL_ROLE) return { role: CONTROL_ROLE };
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

/** ORB-2553 - `refusal` is the instance's sentence when the declaration was refused (another live session in this repository). */
interface SessionRow { sessionId?: string; scope?: AgentSessionScope | null; refusal?: string }

/** ORB-2593 - true while the `orboto claude` supervisor of this session waits for the conversation a bare `--resume` picks: no default scope is declared before it. */
export function supervisorScopePending(env: NodeJS.ProcessEnv = process.env): boolean {
  const dir = (env.ORBOTO_CLAUDE_SUPERVISOR_DIR ?? '').trim();
  const launcher = Number((env.ORBOTO_LAUNCHER_PID ?? '').trim());
  if (!dir || !Number.isInteger(launcher) || launcher <= 1) return false;
  try {
    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as { pid?: number; scopePending?: boolean };
    return state.pid === launcher && state.scopePending === true;
  } catch {
    return false;
  }
}

/** Declares the environment's project on the session row unless the row already carries a scope or the supervisor waits for a picked conversation; answers the row. */
export async function declareEnvProjectScope(
  client: ScopeClient, instanceToken: string, raw: string | undefined = process.env.ORBOTO_PROJECT_KEY, role: string | undefined = process.env.ORBOTO_SESSION_ROLE,
  pending: boolean = supervisorScopePending(),
): Promise<SessionRow | null> {
  const scope = envProjectScope(raw, role);
  if (!scope || pending) return null;
  const current = await client.get<SessionRow>('/v1/agent/session', { instanceToken }).catch(() => null);
  if (current && scopeDeclared(current.scope)) return current;
  const declaration = { scope, scopeDefault: true, start: true };
  const row: SessionRow | null = await client.post<SessionRow>('/v1/agent/heartbeat', declaration, { instanceToken })
    .catch(async (err: unknown): Promise<SessionRow | null> => {
      const { exitedPredecessor, presenceRefusal } = await import('./tools/shared.js');
      const { machineId, shortHost } = await import('./session-origin.js');
      const refused = presenceRefusal(err);
      const dead = exitedPredecessor(refused, { machine: machineId(), host: shortHost() });
      if (dead) {
        const again = await client.post<SessionRow>('/v1/agent/heartbeat', { ...declaration, previous: 'end' }, { instanceToken }).catch(() => null);
        if (again) console.error(`[orboto-mcp] ${dead.line}`);
        return again;
      }
      return refused ? { refusal: refused.message } : null;
    });
  if (row && typeof row.sessionId === 'string') rememberDeclaredScope(instanceToken, row.scope ?? scope);
  return row;
}

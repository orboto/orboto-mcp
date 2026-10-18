/** ORB-2576 - the agent context of a stdio MCP server, read exactly as the CLI reads it (cli/internal/cmd/session_context.go). */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The session id Claude Code hands its stdio MCP servers; an HTTP server never sees it. */
export const CLAUDE_SESSION_ENV = 'CLAUDE_CODE_SESSION_ID';

/** The Claude Code hook events the CLI registers (claude_hook_settings.go OrbotoHookEvents). */
export const ORBOTO_HOOK_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'StopFailure', 'SessionStart', 'SubagentStart', 'SubagentStop', 'SessionEnd', 'Notification'];

/** The project settings file the hooks are registered in. */
export const PROJECT_CLAUDE_SETTINGS = '.claude/settings.local.json';

interface TurnState { state?: string; cwd?: unknown; contextStartedAt?: unknown; activeSubagents?: unknown }

/** The turn-state file name the CLI hook writes for a session. */
export function turnStateName(sessionId: string): string {
  return `${sessionId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || 'session'}.json`;
}

/** The orboto hook events a checkout's settings lack; null when the file cannot be read. */
export function missingTurnHooks(dir: string): string[] | null {
  let hooks: Record<string, unknown> = {};
  try {
    hooks = (JSON.parse(readFileSync(join(dir, PROJECT_CLAUDE_SETTINGS), 'utf8')) as { hooks?: Record<string, unknown> }).hooks ?? {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') return null;
  }
  const covered = (groups: unknown) => Array.isArray(groups) && groups.some((g) => Array.isArray((g as { hooks?: unknown })?.hooks)
    && ((g as { hooks: Array<{ command?: unknown }> }).hooks).some((h) => String(h?.command ?? '').includes('claude-hook')));
  return ORBOTO_HOOK_EVENTS.filter((event) => !covered(hooks[event]));
}

/** The context key, or '' when no complete hook set confirms the current generation or a subagent shares the session. */
export function agentContextKey(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const id = (env[CLAUDE_SESSION_ENV] ?? '').trim();
  if (!id) return '';
  let state: TurnState;
  try {
    state = JSON.parse(readFileSync(join(home, '.orboto', 'claude-turn', turnStateName(id)), 'utf8')) as TurnState;
  } catch {
    return '';
  }
  if (!state.state || typeof state.contextStartedAt !== 'string' || !state.contextStartedAt) return '';
  if (Array.isArray(state.activeSubagents) && state.activeSubagents.length > 0) return '';
  const missing = typeof state.cwd === 'string' ? missingTurnHooks(state.cwd) : null;
  if (!missing || missing.length > 0) return '';
  return `claude-code ${id} ${state.contextStartedAt}`;
}

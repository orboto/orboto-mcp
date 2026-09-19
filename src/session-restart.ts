/**
 * ORB-2181 - the proxy half of the session restart: whatever asked for it -
 * the agent through `orboto_session_restart` or the operator through the
 * `restart_requested` channel notice - ends as the same request file the
 * `orboto claude` supervisor consumes. No socket, no signal, no network
 * listener: one 0600 file in a 0700 directory of the caller's own home.
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { claudeContextDir, readClaudeContext } from './claude-context.js';

export const RESTART_REQUESTED_NOTICE = 'restart_requested';

export interface RestartRequestInput {
  reason: string;
  source: 'mcp' | 'channel';
  requestedBy?: string;
  idleTimeoutSeconds?: number;
}

export interface RestartRequestResult {
  written: boolean;
  sessionId: string | null;
  path: string | null;
  detail: string;
}

export function claudeSessionsDir(): string {
  return path.join(homedir(), '.orboto', 'claude');
}

/** Keeps a session id from escaping the session root. */
export function safeSessionName(id: string): string {
  const cleaned = [...id].filter((c) => /[A-Za-z0-9_-]/.test(c)).join('').slice(0, 80);
  return cleaned || 'session';
}

/**
 * Write the request for the Claude Code session running in `dir`. The session
 * id comes from the status line report of ORB-2149; without one there is no
 * session to address and the caller is told what to install.
 */
export interface RestartRequestRoots {
  now?: number;
  /** Where the session directories live; the orboto state dir by default. */
  root?: string;
  /** Where `orboto claude-statusline` keeps its reports. */
  contextRoot?: string;
}

export function writeRestartRequest(
  dir: string,
  input: RestartRequestInput,
  roots: RestartRequestRoots = {},
): RestartRequestResult {
  const now = roots.now ?? Date.now();
  const root = roots.root ?? claudeSessionsDir();
  const report = readClaudeContext(dir, now, roots.contextRoot ?? claudeContextDir());
  const sessionId = report?.sessionId;
  if (!sessionId) {
    return {
      written: false,
      sessionId: null,
      path: null,
      detail: 'no status line report identifies a Claude Code session in this directory - wire the reporter up with `orboto mcp install --statusline`, then ask again',
    };
  }
  const target = path.join(root, safeSessionName(sessionId));
  const body = JSON.stringify({
    reason: input.reason,
    source: input.source,
    requestedAt: new Date(now).toISOString(),
    ...(input.requestedBy ? { requestedBy: input.requestedBy } : {}),
    idleTimeoutSeconds: input.idleTimeoutSeconds ?? 0,
  });
  const staging = path.join(target, `.restart-${process.pid}.tmp`);
  const file = path.join(target, 'restart.json');
  mkdirSync(target, { recursive: true, mode: 0o700 });
  writeFileSync(staging, body, { mode: 0o600 });
  try {
    renameSync(staging, file);
  } catch (err) {
    rmSync(staging, { force: true });
    throw err;
  }
  return {
    written: true,
    sessionId,
    path: file,
    detail: 'the supervisor restarts this session as soon as no turn is running; it never interrupts one',
  };
}

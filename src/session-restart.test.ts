/**
 * ORB-2181 - the proxy writes one 0600 request file into a 0700 directory
 * named after the Claude Code session, and refuses when no status line
 * report names one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { claudeSessionsDir, safeSessionName, writeRestartRequest } from './session-restart.js';

let contexts: string;
let sessions: string;
const NOW = Date.parse('2026-09-19T10:00:00Z');

beforeEach(() => {
  contexts = mkdtempSync(path.join(tmpdir(), 'orboto-ctx-'));
  sessions = mkdtempSync(path.join(tmpdir(), 'orboto-sessions-'));
});
afterEach(() => {
  rmSync(contexts, { recursive: true, force: true });
  rmSync(sessions, { recursive: true, force: true });
});

function report(body: Record<string, unknown>, root = contexts) {
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'report.json'), JSON.stringify(body));
}

describe('ORB-2181 - the restart request file', () => {
  it('writes the request under the reported session id, owner only', () => {
    report({ cwd: '/work/repo', sessionId: 'sess-7f3a2b1c', contextTokens: 10, updatedAt: new Date(NOW).toISOString() });
    const result = writeRestartRequestHere('/work/repo', 'the CLI was updated');
    expect(result.written).toBe(true);
    expect(result.sessionId).toBe('sess-7f3a2b1c');
    const file = path.join(sessions, 'sess-7f3a2b1c', 'restart.json');
    expect(result.path).toBe(file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ reason: 'the CLI was updated', source: 'mcp' });
  });

  it('tells the agent that running subagents and background tasks hold the restart back (ORB-2771)', () => {
    report({ cwd: '/work/repo', sessionId: 'sess-7f3a2b1c', contextTokens: 10, updatedAt: new Date(NOW).toISOString() });
    const { detail } = writeRestartRequestHere('/work/repo', 'the CLI was updated');
    expect(detail).toContain('no turn, subagent or background task is running');
    expect(detail).toContain('never interrupts a turn or ends a subagent or background task');
    expect(detail).toContain('orboto claude --restart --force-end-agents');
    expect(detail).not.toContain('as soon as no turn is running; it never interrupts one');
  });

  it('refuses without a status line report and names the fix', () => {
    const result = writeRestartRequestHere('/work/repo', 'rotated key');
    expect(result.written).toBe(false);
    expect(result.sessionId).toBeNull();
    expect(result.detail).toContain('orboto mcp install --statusline');
  });

  it('keeps a session id from escaping the session root', () => {
    expect(safeSessionName('../../etc/passwd')).toBe('etcpasswd');
    expect(safeSessionName('!!!')).toBe('session');
  });

});

function writeRestartRequestHere(dir: string, reason: string) {
  return writeRestartRequest(dir, { reason, source: 'mcp' }, { now: NOW, root: sessions, contextRoot: contexts });
}

describe('ORB-2181 - the session root', () => {
  it('lives under the orboto state directory of the user', () => {
    expect(claudeSessionsDir().endsWith(path.join('.orboto', 'claude'))).toBe(true);
  });
});

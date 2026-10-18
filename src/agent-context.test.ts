/** ORB-2576 - a stdio server reads the agent context the CLI hook recorded; anything else is an unknown context. */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ORBOTO_HOOK_EVENTS, agentContextKey, missingTurnHooks, turnStateName } from './agent-context.js';

function hooks(dir: string, events = ORBOTO_HOOK_EVENTS): void {
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'settings.local.json'), JSON.stringify({ hooks: Object.fromEntries(events.map((e) => [e, [{ hooks: [{ type: 'command', command: 'orboto claude-hook' }] }]])) }));
}

function home(session?: string, contextStartedAt?: string, extra: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'orboto-mcp-context-'));
  hooks(dir);
  if (session) {
    mkdirSync(join(dir, '.orboto', 'claude-turn'), { recursive: true });
    writeFileSync(join(dir, '.orboto', 'claude-turn', turnStateName(session)), JSON.stringify({ sessionId: session, cwd: dir, state: 'idle', contextStartedAt, ...extra }));
  }
  return dir;
}

describe('agentContextKey (ORB-2576)', () => {
  it('names the Claude Code session and the generation its SessionStart hook recorded', () => {
    expect(agentContextKey({ CLAUDE_CODE_SESSION_ID: 'sess-a' }, home('sess-a', '2026-10-18T10:00:00Z'))).toBe('claude-code sess-a 2026-10-18T10:00:00Z');
  });

  it('is unknown without the session id, without the hook record, or without a generation', () => {
    expect(agentContextKey({}, home('sess-a', '2026-10-18T10:00:00Z'))).toBe('');
    expect(agentContextKey({ CLAUDE_CODE_SESSION_ID: 'sess-a' }, home())).toBe('');
    expect(agentContextKey({ CLAUDE_CODE_SESSION_ID: 'sess-a' }, home('sess-a'))).toBe('');
  });

  it('a subagent inside a running session gets the rules in full: its session id is the parent\'s, so the context is unknown while it runs', () => {
    expect(agentContextKey({ CLAUDE_CODE_SESSION_ID: 'sess-a' }, home('sess-a', '2026-10-18T10:00:00Z', { activeSubagents: ['agent-1'] }))).toBe('');
  });

  it('a hook set without the subagent events is an unknown context', () => {
    const dir = home('sess-a', '2026-10-18T10:00:00Z');
    hooks(dir, ORBOTO_HOOK_EVENTS.filter((e) => !e.startsWith('Subagent')));
    expect(missingTurnHooks(dir)).toEqual(['SubagentStart', 'SubagentStop']);
    expect(agentContextKey({ CLAUDE_CODE_SESSION_ID: 'sess-a' }, dir)).toBe('');
  });

  it('registers the same hook events as the CLI and names the turn file like it does', () => {
    const go = readFileSync(new URL('../../../cli/internal/cmd/claude_hook.go', import.meta.url), 'utf8') + readFileSync(new URL('../../../cli/internal/cmd/claude_hook_settings.go', import.meta.url), 'utf8');
    for (const event of ORBOTO_HOOK_EVENTS) expect(go).toContain(`"${event}"`);
    expect(turnStateName('a/b..c')).toBe('abc.json');
    expect(turnStateName('///')).toBe('session.json');
  });
});

/** ORB-2224 - the project a session declares from ORBOTO_PROJECT_KEY, and its drift against the CLI that writes it. */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { declareEnvProjectScope, envProjectScope, PROJECT_KEY_ENV, scopeDeclared } from './project-scope.js';
import { _forgetDeclaredScopes, rememberedScope } from './session-scope-memory.js';
import { OrbotoClient } from './orboto-client.js';
import { makeSessionStartHandler } from './tools/session-start.js';

const read = (relative: string) => readFileSync(new URL(`../../../${relative}`, import.meta.url), 'utf8');

function fakeClient(row: unknown) {
  const calls: Array<{ method: string; path: string; body?: unknown; instanceToken?: string }> = [];
  return {
    calls,
    get: async <T,>(path: string, opts?: { instanceToken?: string }) => { calls.push({ method: 'GET', path, instanceToken: opts?.instanceToken }); if (row instanceof Error) throw row; return row as T; },
    post: async <T,>(path: string, body: unknown, opts?: { instanceToken?: string }) => {
      calls.push({ method: 'POST', path, body, instanceToken: opts?.instanceToken });
      return { sessionId: 'cbb52195-0000-4000-8000-000000000000', scope: (body as { scope: unknown }).scope } as T;
    },
  };
}

beforeEach(() => { _forgetDeclaredScopes(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('ORB-2224 - ORBOTO_PROJECT_KEY', () => {
  it('names the same variable the CLI writes into the entry and hands to the session', () => {
    const go = read('cli/internal/cmd/project_scope.go');
    expect(go).toContain(`const ProjectKeyEnv = "${PROJECT_KEY_ENV}"`);
    expect(read('apps/mcp/src/project-scope.ts')).toContain(`process.env.${PROJECT_KEY_ENV}`);
    expect(read('docs/env.md')).toContain(`| \`${PROJECT_KEY_ENV}\` | mcp |`);
  });

  it('reads a worker scope on the upper-cased key and ignores anything that is no key', () => {
    expect(envProjectScope(' acme ')).toEqual({ role: 'worker', projectKeys: ['ACME'] });
    for (const value of [undefined, '', '  ', 'acme widgets', '1ACME', '${ORBOTO_PROJECT_KEY}']) {
      expect(envProjectScope(value)).toBeNull();
    }
    expect(scopeDeclared(null)).toBe(false);
    expect(scopeDeclared({})).toBe(false);
    expect(scopeDeclared({ role: 'worker' })).toBe(true);
  });

  it('declares the project on a row without a scope and remembers it for the channel reconnect', async () => {
    const client = fakeClient({ sessionId: 'cbb52195-0000-4000-8000-000000000000', scope: null });
    await declareEnvProjectScope(client, 'agent-abc', 'ACME');
    expect(client.calls).toEqual([
      { method: 'GET', path: '/v1/agent/session', instanceToken: 'agent-abc' },
      { method: 'POST', path: '/v1/agent/heartbeat', body: { scope: { role: 'worker', projectKeys: ['ACME'] } }, instanceToken: 'agent-abc' },
    ]);
    expect(rememberedScope('agent-abc')).toEqual({ role: 'worker', projectKeys: ['ACME'] });
  });

  it('declares on a token that has no row yet', async () => {
    const client = fakeClient(new Error('404'));
    await declareEnvProjectScope(client, 'agent-new', 'ACME');
    expect(client.calls.map((c) => c.method)).toEqual(['GET', 'POST']);
  });

  it('keeps a scope the session already declares and does nothing without the variable', async () => {
    const kept = fakeClient({ sessionId: 'x', scope: { role: 'integrator', projectKeys: ['ORB'] } });
    await declareEnvProjectScope(kept, 'agent-kept', 'ACME');
    expect(kept.calls.map((c) => c.method)).toEqual(['GET']);
    const none = fakeClient({ sessionId: 'x', scope: null });
    expect(await declareEnvProjectScope(none, 'agent-none', '')).toBeNull();
    expect(none.calls).toEqual([]);
  });

  it('orboto_session_start without a scope declares the environment project on a row that has none', async () => {
    vi.stubEnv(PROJECT_KEY_ENV, 'acme');
    const beats: unknown[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = new URL(url.toString());
      let body: unknown = {};
      if (u.pathname === '/v1/agent/heartbeat') {
        const sent = init?.body ? JSON.parse(init.body as string) : {};
        beats.push(sent);
        body = { sessionToken: 'x', sessionId: 'cbb52195-0000-4000-8000-000000000000', scope: sent.scope ?? null };
      } else if (u.pathname === '/v1/agent/session') {
        body = { sessionId: 'cbb52195-0000-4000-8000-000000000000', scope: null };
      } else if (u.pathname === '/agent-instructions') {
        body = { instructions: 'rules here', rulesHash: 'fixture' };
      }
      return { ok: true, status: 200, statusText: 'OK', json: async () => body, text: async () => '' } as unknown as Response;
    });
    const client = new OrbotoClient({ baseUrl: 'http://api.test', apiKey: 'k' });
    const res = await makeSessionStartHandler(client)({}, { sessionId: 'scope1' });
    expect(beats).toEqual([{}, { scope: { role: 'worker', projectKeys: ['ACME'] } }]);
    expect((res.content[0] as { text: string }).text).toContain('projects ACME');
    expect(rememberedScope('mcp-scope1')).toEqual({ role: 'worker', projectKeys: ['ACME'] });
  });
});

/**
 * ORB-2553 - the MCP side of mandatory presence scope: the refusal is read
 * off the API error, orboto_session_start starts with `start` and renders a
 * refusal or a takeover, the proxy's default declaration is a start, and
 * orboto_who prints the refused heartbeats per account.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoApiError, OrbotoClient } from '../orboto-client.js';
import { exitedPredecessor, presenceRefusal, processAlive } from './shared.js';
import { makeSessionStartHandler, takeoverLine } from './session-start.js';
import { makeAgentWhoHandler, refusalLines } from './agent-who.js';
import { makeAgentHeartbeatHandler } from './agent-coordination.js';
import { declareEnvProjectScope } from '../project-scope.js';
import { _forgetDeclaredScopes } from '../session-scope-memory.js';
import { checkoutHash, machineId, shortHost, stdioOrigin } from '../session-origin.js';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SESSION_EXISTS = {
  error: 'Another live session of this account runs in sample-repo on build-host: 0123abcd (claude-code, 42 min, ORB-7). Start again with --adopt to take over its scope, mail and leases, or with --end-previous to end it.',
  errorKey: 'errors.agents.session_exists',
  errorParams: { sessionId: '0123abcd-0000-4000-8000-000000000000', shortId: '0123abcd', ageMinutes: 42, ticket: 'ORB-7', host: 'build-host', repo: 'sample-repo', harness: 'claude-code', role: 'integrator', projects: 'ORB' },
};
const SCOPE_REQUIRED = { error: 'This session declares no scope', errorKey: 'errors.agents.scope_required', errorParams: { command: 'orboto session-start --role <role> --scope-projects <KEY>', notes: ['Not carried over: the earlier scope.'] } };

beforeEach(() => { _forgetDeclaredScopes(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

type Seen = Array<{ path: string; body: unknown }>;

function stub(heartbeat: { status: number; body: unknown }, seen: Seen, extra: Record<string, unknown> = {}) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const u = new URL(url.toString());
    const path = u.pathname + u.search;
    seen.push({ path, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (u.pathname === '/v1/agent/heartbeat' && init?.method === 'POST') {
      return { ok: heartbeat.status < 300, status: heartbeat.status, statusText: 'x', headers: new Headers(), json: async () => heartbeat.body, text: async () => JSON.stringify(heartbeat.body) } as unknown as Response;
    }
    const map: Record<string, unknown> = {
      '/users/me/assigned-tickets': { items: [] }, '/users/me': { email: 'dev@x.io' }, '/agent-instructions': { instructions: 'rules', rulesHash: 'h' }, ...extra,
    };
    const key = Object.keys(map).find((k) => path.startsWith(k));
    return { ok: true, status: 200, statusText: 'OK', headers: new Headers(), json: async () => (key ? map[key] : {}), text: async () => '' } as unknown as Response;
  });
}

describe('ORB-2553 - the refusal on the MCP side', () => {
  it('presenceRefusal reads the two refusals and their notes, nothing else', () => {
    expect(presenceRefusal(new OrbotoApiError(409, JSON.stringify(SESSION_EXISTS), 'u'))).toMatchObject({ key: 'errors.agents.session_exists', params: { shortId: '0123abcd' } });
    expect(presenceRefusal(new OrbotoApiError(422, JSON.stringify(SCOPE_REQUIRED), 'u'))?.message).toBe('This session declares no scope\nNot carried over: the earlier scope.');
    expect(presenceRefusal(new OrbotoApiError(409, JSON.stringify({ errorKey: 'errors.agents.no_recipient' }), 'u'))).toBeNull();
    expect(presenceRefusal(new OrbotoApiError(422, 'not json', 'u'))).toBeNull();
    expect(presenceRefusal(new Error('x'))).toBeNull();
  });

  it('orboto_session_start sends start and previous, and renders a second start as not registered with the way out', async () => {
    const seen: Seen = [];
    stub({ status: 409, body: SESSION_EXISTS }, seen);
    const client = new OrbotoClient({ baseUrl: 'http://api.test', apiKey: 'orb_k' });
    const res = await makeSessionStartHandler(client)({ scope: { role: 'integrator', projectKeys: ['ORB'] }, previous: 'adopt' }, { sessionId: 'ps1' });
    expect(seen.find((c) => c.path === '/v1/agent/heartbeat')?.body).toEqual({ start: true, previous: 'adopt', scope: { role: 'integrator', projectKeys: ['ORB'] } });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('Not registered: Another live session of this account runs in sample-repo on build-host: 0123abcd');
    expect(text).toContain('previous: "adopt" or "end"');
    expect(text).not.toContain('Peers reach exactly this session');
    expect((res.structuredContent as { session: { refused?: string } }).session.refused).toContain('0123abcd');
  });

  it('a start that took over the previous session says what moved', async () => {
    const seen: Seen = [];
    const takeover = { action: 'adopted', sessionId: '0123abcd-0000-4000-8000-000000000000', shortId: '0123abcd', movedMessages: 2, movedLeases: ['ORB-7'], releasedTickets: [] };
    stub({ status: 200, body: { sessionToken: 'mcp-ps2', sessionId: 'cbb52195-0000-4000-8000-000000000000', scope: { role: 'integrator', projectKeys: ['ORB'] }, takeover } }, seen);
    const client = new OrbotoClient({ baseUrl: 'http://api.test', apiKey: 'orb_k' });
    const res = await makeSessionStartHandler(client)({ previous: 'adopt' }, { sessionId: 'ps2' });
    expect((res.content[0] as { text: string }).text).toContain('Adopted session 0123abcd: 2 unread message(s) and the leases on ORB-7 moved here, it is ended.');
    expect(takeoverLine({ action: 'ended', shortId: 'abcd0123', movedMessages: 0, movedLeases: [], releasedTickets: ['ORB-9'] })).toBe('Ended the previous session abcd0123 in this repository; its leases on ORB-9 are released.');
  });

  it('the proxy declares the checkout project as a start and hands back the refusal', async () => {
    const calls: unknown[] = [];
    const refusing = {
      get: async <T,>() => ({ sessionId: 'x', scope: null }) as T,
      post: async <T,>(_path: string, body: unknown): Promise<T> => { calls.push(body); throw new OrbotoApiError(409, JSON.stringify(SESSION_EXISTS), 'u'); },
    };
    const row = await declareEnvProjectScope(refusing, 'agent-abc', 'ACME', undefined, false);
    expect(calls).toEqual([{ scope: { role: 'worker', projectKeys: ['ACME'] }, scopeDefault: true, start: true }]);
    expect(row).toEqual({ refusal: SESSION_EXISTS.error });
  });

  it('orboto_agent_heartbeat answers a refusal as a tool error with the hint', async () => {
    stub({ status: 422, body: SCOPE_REQUIRED }, []);
    const res = await makeAgentHeartbeatHandler(new OrbotoClient({ baseUrl: 'http://api.test', apiKey: 'orb_k' }))({ status: 'working' }, { sessionId: 'ps3' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toBe('heartbeat refused (ORB-2553) - This session declares no scope\nNot carried over: the earlier scope.');
  });

  it('the proxy names the hashed checkout it runs in; a linked worktree is a checkout of its own', () => {
    const main = realpathSync(mkdtempSync(join(tmpdir(), 'orboto-checkout-')));
    mkdirSync(join(main, '.git'));
    const tree = join(main, '.claude', 'worktrees', 'agent-1');
    mkdirSync(join(tree, 'sub'), { recursive: true });
    writeFileSync(join(tree, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'agent-1')}\n`);
    const hash = (dir: string) => createHash('sha256').update(dir).digest('hex').slice(0, 16);
    expect(checkoutHash(join(tree, 'sub'))).toBe(hash(tree));
    expect(checkoutHash(main)).toBe(hash(main));
    expect(checkoutHash(tree)).not.toBe(checkoutHash(main));
    expect(new URLSearchParams(stdioOrigin({})).get('checkout')).toBe(checkoutHash());
  });

  it('orboto_session_start sends the environment project as fallbackScope in its start beat', async () => {
    vi.stubEnv('ORBOTO_PROJECT_KEY', 'acme');
    vi.stubEnv('ORBOTO_SESSION_ROLE', '');
    const seen: Seen = [];
    stub({ status: 200, body: { sessionToken: 'mcp-ps4', sessionId: 'cbb52195-0000-4000-8000-000000000000', scope: { role: 'worker', projectKeys: ['ACME'] } } }, seen);
    await makeSessionStartHandler(new OrbotoClient({ baseUrl: 'http://api.test', apiKey: 'orb_k' }))({}, { sessionId: 'ps4' });
    const beats = seen.filter((c) => c.path === '/v1/agent/heartbeat');
    expect(beats.map((b) => b.body)).toEqual([{ start: true, fallbackScope: { role: 'worker', projectKeys: ['ACME'] } }]);
  });

  it('a second-start refusal on this machine whose pid has exited names an exited predecessor; a live pid or another machine does not', () => {
    const refusal = (pid: number, machine: string | null, host = 'build-host') => presenceRefusal(new OrbotoApiError(409, JSON.stringify({ ...SESSION_EXISTS, errorParams: { ...SESSION_EXISTS.errorParams, pid, machineId: machine, host } }), 'u'));
    const here = { machine: 'machine-a', host: 'build-host' };
    expect(exitedPredecessor(refusal(4100, 'machine-a'), here, () => false)).toEqual({ shortId: '0123abcd', pid: 4100, line: 'previous session 0123abcd (pid 4100) has exited, ended it' });
    expect(exitedPredecessor(refusal(4100, 'machine-a'), here, () => true)).toBeNull();
    expect(exitedPredecessor(refusal(4100, 'machine-b'), here, () => false)).toBeNull();
    expect(exitedPredecessor(refusal(4100, null), here, () => false)).not.toBeNull();
    expect(exitedPredecessor(refusal(4100, null, 'other-host'), here, () => false)).toBeNull();
    expect(exitedPredecessor(refusal(4100, 'machine-a', 'cloned-vm'), here, () => false)).toBeNull();
    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(2 ** 30)).toBe(false);
  });

  it('orboto_session_start ends an exited predecessor on its own and says so in one line', async () => {
    const seen: Seen = [];
    let calls = 0;
    const exited = { ...SESSION_EXISTS, errorParams: { ...SESSION_EXISTS.errorParams, pid: 2 ** 30, machineId: machineId(), host: shortHost() } };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = new URL(url.toString());
      seen.push({ path: u.pathname + u.search, body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (u.pathname === '/v1/agent/heartbeat' && init?.method === 'POST' && (calls += 1) === 1) {
        return { ok: false, status: 409, statusText: 'x', headers: new Headers(), json: async () => exited, text: async () => JSON.stringify(exited) } as unknown as Response;
      }
      const body = u.pathname === '/v1/agent/heartbeat'
        ? { sessionToken: 'mcp-ps5', sessionId: 'cbb52195-0000-4000-8000-000000000000', scope: { role: 'worker', projectKeys: ['ORB'] }, takeover: { action: 'ended', shortId: '0123abcd', movedMessages: 0, movedLeases: [], releasedTickets: [] } }
        : u.pathname === '/agent-instructions' ? { instructions: 'rules', rulesHash: 'h' } : {};
      return { ok: true, status: 200, statusText: 'OK', headers: new Headers(), json: async () => body, text: async () => '' } as unknown as Response;
    });
    const res = await makeSessionStartHandler(new OrbotoClient({ baseUrl: 'http://api.test', apiKey: 'orb_k' }))({ scope: { role: 'worker', projectKeys: ['ORB'] } }, { sessionId: 'ps5' });
    const beats = seen.filter((c) => c.path === '/v1/agent/heartbeat').map((c) => c.body as Record<string, unknown>);
    expect(beats.map((b) => b.previous)).toEqual([undefined, 'end']);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('previous session 0123abcd (pid 1073741824) has exited, ended it');
    expect(text).not.toContain('Not registered');
  });

  it('the proxy declaration ends an exited predecessor on its own', async () => {
    const calls: unknown[] = [];
    const exited = { ...SESSION_EXISTS, errorParams: { ...SESSION_EXISTS.errorParams, pid: 2 ** 30, machineId: machineId(), host: shortHost() } };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const restarting = {
      get: async <T,>() => ({ sessionId: 'x', scope: null }) as T,
      post: async <T,>(_path: string, body: unknown): Promise<T> => {
        calls.push(body);
        if (calls.length === 1) throw new OrbotoApiError(409, JSON.stringify(exited), 'u');
        return { sessionId: 'cbb52195-0000-4000-8000-000000000000', scope: { role: 'worker', projectKeys: ['ACME'] } } as T;
      },
    };
    const row = await declareEnvProjectScope(restarting, 'agent-abc', 'ACME', undefined, false);
    expect(calls).toEqual([{ scope: { role: 'worker', projectKeys: ['ACME'] }, scopeDefault: true, start: true }, { scope: { role: 'worker', projectKeys: ['ACME'] }, scopeDefault: true, start: true, previous: 'end' }]);
    expect(row).toMatchObject({ sessionId: 'cbb52195-0000-4000-8000-000000000000' });
  });

  it('orboto_who lists the refused heartbeats per account after the sessions', async () => {
    const refusals = [{ userId: 'u1', email: 'agent@x.io', count: 3, scopeRequired: 2, sessionExists: 1, since: 't0', lastAt: '2026-10-20T10:00:00.000Z', lastReason: 'session_exists', lastHost: 'build-host', lastRepo: 'sample-repo', lastHarness: 'claude-code' }];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({ ok: true, status: 200, statusText: 'OK', headers: new Headers(), json: async () => ({ sessions: [], refusals, nextCursor: null }), text: async () => '' }) as unknown as Response);
    const res = await makeAgentWhoHandler(new OrbotoClient({ baseUrl: 'http://api.test', apiKey: 'orb_k' }))({});
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('Refused heartbeats in the last 24 hours (no role address, not listed):');
    expect(text).toContain('- agent@x.io: 3 (no scope 2, second start 1), last 2026-10-20T10:00:00.000Z from build-host/sample-repo (claude-code)');
    expect((res.structuredContent as { refusals: unknown[] }).refusals).toHaveLength(1);
    expect(refusalLines(undefined)).toEqual([]);
  });
});

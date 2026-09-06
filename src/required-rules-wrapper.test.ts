import { afterEach, describe, expect, it } from 'vitest';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'orboto-rules-wrapper-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'skills/orboto'), { recursive: true });
  await cp(join(root, 'skills/orboto/scripts'), join(dir, 'skills/orboto/scripts'), { recursive: true });
  const cache = join(dir, 'skills/orboto/.rules-hash');
  await writeFile(cache, 'keep-hash\n');
  let rules = '{}', next = '{}', status = 200, ruleReads = 0;
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url?.startsWith('/agent-instructions')) { ruleReads++; res.statusCode = status; res.end(rules); }
    else if (req.url?.startsWith('/work-sessions/next')) res.end(next);
    else if (req.url?.startsWith('/users/me/assigned-tickets')) res.end('{"items":[]}');
    else if (req.url?.startsWith('/users/me')) res.end('{"id":"me","email":"fixture@example.test"}');
    else res.end('null');
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  cleanup.push(() => new Promise<void>((ok, no) => server.close((err) => err ? no(err) : ok())));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture address missing');
  const origin = `http://127.0.0.1:${address.port}`;
  const guard = join(dir, 'fixture-network.mjs');
  await writeFile(guard, `const original = globalThis.fetch; globalThis.fetch = (input, init) => { if (new URL(input).origin !== ${JSON.stringify(origin)}) throw new Error('Fixture refused a nonlocal request'); return original(input, init); };`);
  const run = (args = ['session-start', '--force-rules']) => new Promise<{ code: number | null; out: string; err: string }>((ok, no) => {
    const child = spawn(process.execPath, ['--import', guard, join(dir, 'skills/orboto/scripts/orboto.mjs'), ...args], {
      cwd: dir, env: { ...process.env, ORBOTO_PROFILE: '', ORBOTO_BASE_URL: `http://127.0.0.1:${address.port}`, ORBOTO_TOKEN: 'orb_fixture', ORBOTO_DAEMON: '', ORBOTO_AGENT_SESSION: 'fixture' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString(); });
    child.on('error', no);
    child.on('close', (code) => ok({ code, out, err }));
  });
  return { run, cache, ruleReads: () => ruleReads, set: (body: string, code = 200) => { rules = body; status = code; }, setNext: (body: string) => { next = body; } };
}

// ORB-1948 - each test spawns the REAL wrapper CLI (a 6,000-line module,
// about 1 s locally); on a saturated CI host (tag run: boot gate, three
// image builds, CLI binaries and the MCP split in parallel) that exceeded
// vitest's 5 s default and blocked the v0.182.1 rollout. The budget is per
// test and generous on purpose - a hang still fails, only slower.
const SPAWN_TEST_TIMEOUT_MS = 60_000;

describe('wrapper required rules through the real CLI', () => {
  it('does not turn malformed work-next responses into an idle result', async () => {
    const f = await fixture();
    for (const body of ['{}', 'null', '[]', '{"reserved":null}', '{"reserved":""}', '<html>unavailable</html>']) {
      f.setNext(body);
      const result = await f.run(['work-next', 'ORB']);
      expect(result.code).toBe(1);
      expect(result.out).not.toContain('Nothing ready');
      expect(await readFile(f.cache, 'utf8')).toBe('keep-hash\n');
    }
    f.setNext('{"reserved":null,"reason":"none-matching","retryAfterSeconds":null,"earliestFreeAt":null,"candidatesConsidered":0,"landedIdle":[]}');
    expect((await f.run(['work-next', 'ORB'])).code).toBe(3);
    f.setNext(JSON.stringify({ reserved: {
      session: { id: 'session', role: 'implementation', leaseUntil: 'later' },
      ticket: { ticketKey: 'ORB-42', title: 'fixture' }, reused: true,
      rulesHash: 'keep-hash', rulesUnchanged: true,
      primer: { markdown: '', totalTokens: 0 }, checklists: [], dependencies: { blocks: [], blockedBy: [] }, gitHealth: [], siblingSessions: [],
    }, reason: null, retryAfterSeconds: null, earliestFreeAt: null, candidatesConsidered: 1, landedIdle: [] }));
    const ack = await f.run(['work-next', 'ORB']);
    expect(ack.code).toBe(0);
    expect(ack.out).toContain('not currently in your context');
    expect(ack.out).toContain('session-start --force-rules');
    expect(ack.out).not.toContain('keep following what you already loaded');
  }, SPAWN_TEST_TIMEOUT_MS);
  it('does not silently omit an explicitly requested init rules snapshot', async () => {
    const f = await fixture();
    f.set('{}');
    const result = await f.run(['init', '--with-rules']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('Required agent rules');
    expect(f.ruleReads()).toBe(1);
  }, SPAWN_TEST_TIMEOUT_MS);
  it('fails closed without poisoning the cache, then recovers with a valid empty ruleset', async () => {
    const f = await fixture();
    for (const body of ['{}', 'null', '[]', '{"instructions":', '<html>secret-token</html>', '{"instructions":"","rulesHash":null}', '{"rulesHash":"keep-hash","rulesUnchanged":true}']) {
      f.set(body);
      const result = await f.run();
      expect(result.code).toBe(1);
      expect(result.out).not.toContain('no workspace rules');
      expect(result.err).toContain('Required agent rules');
      expect(result.err).not.toContain('secret-token');
      expect(await readFile(f.cache, 'utf8')).toBe('keep-hash\n');
    }
    for (const status of [401, 403, 500, 503]) {
      f.set('{"error":"secret-token"}', status);
      const result = await f.run();
      expect(result.code).toBe(1);
      expect(result.err).toContain(`HTTP ${status}`);
      expect(result.err).not.toContain('secret-token');
    }
    f.set('{"instructions":"","rulesHash":"empty","requireSessionStart":true}');
    const result = await f.run();
    expect(result.code).toBe(0);
    expect(result.out).toContain('no workspace rules configured');
    expect((await readFile(f.cache, 'utf8')).trim()).toBe('empty');
  }, SPAWN_TEST_TIMEOUT_MS);
});

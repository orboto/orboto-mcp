import { expect, it } from 'vitest';
import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('real wrapper preserves piped diff text and version-prefixed check/record values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orboto-1964-verify-temp-'));
  const fingerprint = 'sha256-diff-v2:' + 'a'.repeat(64);
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk.toString();
    const url = req.url ?? '';
    if (req.method === 'POST') calls.push({ url, body: JSON.parse(raw) });
    res.setHeader('Content-Type', 'application/json');
    if (url === '/projects') res.end(JSON.stringify([{ id: 'p', key: 'ORB' }]));
    else if (url.includes('/tickets/by-key/')) res.end(JSON.stringify({ id: 't', projectId: 'p', ticketKey: 'ORB-1964' }));
    else res.end(JSON.stringify({ fingerprint, algo: 'sha256-diff-v2' }));
  });
  try {
    await mkdir(join(dir, 'skills/orboto'), { recursive: true });
    await cp(new URL('../../../../skills/orboto/scripts', import.meta.url), join(dir, 'skills/orboto/scripts'), { recursive: true });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture address missing');
    const origin = `http://127.0.0.1:${address.port}`;
    const guard = join(dir, 'network.mjs');
    await writeFile(guard, `const original = globalThis.fetch; globalThis.fetch = (input, init) => { if (new URL(input).origin !== ${JSON.stringify(origin)}) throw new Error('Fixture refused nonlocal request'); return original(input, init); };`);
    const run = (args: string[], stdin = '') => new Promise<string>((ok, no) => {
      const child = spawn(process.execPath, ['--import', guard, join(dir, 'skills/orboto/scripts/orboto.mjs'), ...args], {
        cwd: dir, env: { ...process.env, ORBOTO_PROFILE: '', ORBOTO_BASE_URL: origin, ORBOTO_TOKEN: 'orb_fixture', ORBOTO_DAEMON: '', ORBOTO_AGENT_SESSION: 'fixture' },
        timeout: 20_000,
      });
      let out = '', err = '';
      child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString(); });
      child.on('error', no);
      child.on('close', (code) => code === 0 ? ok(out) : no(new Error(`Wrapper exit ${code}: ${err}`)));
      child.stdin.end(stdin);
    });
    const diff = 'diff --git a/a b/a\r\n-old\r\n+  new  \r\n+\r\n';
    expect(await run(['review-fingerprint'], diff)).toContain(fingerprint);
    expect(calls[0]).toEqual({ url: '/review-policy/fingerprint', body: { diff } });
    expect(await run(['review-check', 'ORB-1964', '--fingerprint', fingerprint])).toContain(fingerprint);
    expect(await run(['review-approve', 'ORB-1964', '--fingerprint', fingerprint])).toContain(fingerprint);
    expect(calls.slice(1).map((call) => call.body.fingerprint)).toEqual([fingerprint, fingerprint]);
    expect(calls[2].body.decision).toBe('approved');
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((ok, no) => server.close((err) => err ? no(err) : ok()));
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);

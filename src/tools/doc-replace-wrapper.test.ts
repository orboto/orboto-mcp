/**
 * ORB-2468 - the skill wrapper's `doc edit` appends content unless --replace,
 * a replace prints the replaced revision and restore command, `doc restore`
 * posts the revision restore.
 */
import { expect, it } from 'vitest';
import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childWindow, ciWindow } from '../test/ci-window.js';
import { hermeticHome, hermeticSpawnEnv } from '../test/hermetic-cli-env.js';

const DOC = 'd0c00000-2222-4222-8222-222222222222';
const REV = 'bbbbbbbb-0000-4000-8000-000000000000';

it('doc edit appends by default, --replace names the replaced revision, doc restore posts the restore', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orboto-2468-wrapper-'));
  const requests: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    const url = req.url ?? '';
    requests.push({ method: req.method ?? '', url, body: raw ? JSON.parse(raw) : {} });
    res.setHeader('Content-Type', 'application/json');
    const row = { id: DOC, docKey: 'ORB-D7', title: 'Runbook', webUrl: 'https://orboto.example/docs/ORB-D7' };
    if (req.method === 'POST' && url === '/docs/ORB-D7/append-section') res.end(JSON.stringify({ appended: true }));
    else if (req.method === 'PATCH' && url === '/docs/ORB-D7') res.end(JSON.stringify({ ...row, replaced: { docId: DOC, revisionId: REV, restoreCommand: `orboto doc restore ORB-D7 ${REV}` } }));
    else if (req.method === 'POST' && url === `/docs/ORB-D7/revisions/${REV}/restore`) res.end(JSON.stringify(row));
    else { res.statusCode = 404; res.end(JSON.stringify({ error: `unexpected ${req.method} ${url}` })); }
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
    const run = (args: string[]) => new Promise<{ code: number | null; out: string; err: string }>((ok, no) => {
      const child = spawn(process.execPath, ['--import', guard, join(dir, 'skills/orboto/scripts/orboto.mjs'), ...args], {
        cwd: dir, env: hermeticSpawnEnv({ home: hermeticHome('mcp-wrapper'), baseUrl: origin, token: 'orb_fixture', env: { ORBOTO_DAEMON: '', ORBOTO_AGENT_SESSION: 'fixture' } }),
        timeout: childWindow(),
      });
      let out = '', err = '';
      child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString(); });
      child.on('error', no);
      child.on('close', (code) => ok({ code, out, err }));
      child.stdin.end('');
    });

    const appended = await run(['doc', 'edit', 'ORB-D7', '--content', 'new fact']);
    expect(appended.code, appended.err).toBe(0);
    expect(requests.at(-1)).toMatchObject({ method: 'POST', url: '/docs/ORB-D7/append-section', body: { content: 'new fact' } });
    expect(requests.some((r) => r.method === 'PATCH')).toBe(false);
    expect(appended.err).toContain('Appended to doc ORB-D7');

    const replaced = await run(['doc', 'edit', 'ORB-D7', '--replace', '--content', 'whole new body']);
    expect(replaced.code, replaced.err).toBe(0);
    expect(requests.at(-1)).toMatchObject({ method: 'PATCH', url: '/docs/ORB-D7', body: { content: 'whole new body', replace: true } });
    expect(replaced.err).toContain(REV);
    expect(replaced.err).toContain(`orboto doc restore ORB-D7 ${REV}`);

    const refused = await run(['doc', 'edit', 'ORB-D7', '--replace', '--old', 'a', '--new', 'b']);
    expect(refused.code).toBe(2);

    const restored = await run(['doc', 'restore', 'ORB-D7', REV]);
    expect(restored.code, restored.err).toBe(0);
    expect(requests.at(-1)).toMatchObject({ method: 'POST', url: `/docs/ORB-D7/revisions/${REV}/restore` });
    expect(restored.err).toContain('Restored doc ORB-D7');
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((ok, no) => server.close((err) => err ? no(err) : ok()));
    await rm(dir, { recursive: true, force: true });
  }
}, ciWindow(60_000));

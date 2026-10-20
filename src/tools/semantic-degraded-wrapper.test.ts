/**
 * ORB-2543 - the skill wrapper names a full-text-only answer on stderr and
 * keeps stdout unchanged.
 */
import { expect, it } from 'vitest';
import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childWindow, ciWindow } from '../test/ci-window.js';
import { hermeticHome, hermeticSpawnEnv } from '../test/hermetic-cli-env.js';

const LINE = 'semantic search unavailable, showing full-text results';

it('search, search-docs, ask-docs and check-similar print the degraded line on stderr', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orboto-2543-wrapper-'));
  const server = createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    const url = req.url ?? '';
    res.setHeader('Content-Type', 'application/json');
    if (url === '/projects') res.end(JSON.stringify([{ id: 'p', key: 'ORB' }]));
    else if (url.startsWith('/projects/by-key/')) res.end(JSON.stringify({ id: 'p', key: 'ORB' }));
    else if (url.startsWith('/search?')) res.end(JSON.stringify({ items: [{ type: 'ticket', id: 't', ticketKey: 'ORB-1', title: 'Frobnicator jams', excerpt: '' }], nextCursor: null, total: 1, semanticDegraded: true }));
    else if (url.startsWith('/docs/search?')) res.end(JSON.stringify({ items: [], total: 0, mode: 'fts', semantic: false, semanticDegraded: true }));
    else if (url === '/ai/ask-docs') res.end(JSON.stringify({ answer: 'Restart it [1].', citations: [{ index: 1, title: 'Runbook', link: '/l' }], mode: 'keyword', abstained: false, semanticDegraded: true }));
    else if (url.startsWith('/projects/p/tickets/similar?')) res.end(JSON.stringify({ candidates: [], mode: 'tsvector', semanticDegraded: true }));
    else { res.statusCode = 404; res.end(JSON.stringify({ error: `unexpected ${url}` })); }
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
    const run = (args: string[]) => new Promise<{ out: string; err: string }>((ok, no) => {
      const child = spawn(process.execPath, ['--import', guard, join(dir, 'skills/orboto/scripts/orboto.mjs'), ...args], {
        cwd: dir, env: hermeticSpawnEnv({ home: hermeticHome('mcp-wrapper'), baseUrl: origin, token: 'orb_fixture', env: { ORBOTO_DAEMON: '', ORBOTO_AGENT_SESSION: 'fixture' } }),
        timeout: childWindow(),
      });
      let out = '', err = '';
      child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString(); });
      child.on('error', no);
      child.on('close', (code) => code === 0 ? ok({ out, err }) : no(new Error(`Wrapper exit ${code}: ${err}`)));
      child.stdin.end('');
    });
    for (const args of [['search', 'frobnicator'], ['search-docs', 'frobnicator'], ['ask-docs', 'how to restart'], ['check-similar', 'ORB', 'Frobnicator jams'], ['ticket', 'check-similar', 'ORB', 'Frobnicator jams']]) {
      const { out, err } = await run(args);
      expect(err, args.join(' ')).toContain(LINE);
      expect(out, args.join(' ')).not.toContain(LINE);
    }
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((ok, no) => server.close((err) => err ? no(err) : ok()));
    await rm(dir, { recursive: true, force: true });
  }
}, ciWindow(60_000));

/** ORB-2687 - the skill wrapper's ticket close and ticket move print the server's own timer booking, and close, move, bulk-move and bulk-close send keepTimer for --keep-timer. */
import { expect, it } from 'vitest';
import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childWindow, ciWindow } from '../test/ci-window.js';
import { hermeticHome, hermeticSpawnEnv } from '../test/hermetic-cli-env.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const TICKET = '22222222-2222-4222-8222-222222222222';
const DONE = '33333333-3333-4333-8333-333333333333';

it('ticket close and ticket move report the booked timer, and --keep-timer sends keepTimer on close, move, bulk-move and bulk-close', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orboto-2687-wrapper-'));
  const patches: unknown[] = [];
  let timerReads = 0;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const url = req.url ?? '';
    res.setHeader('Content-Type', 'application/json');
    if (url === '/projects') res.end(JSON.stringify([{ id: PROJECT, key: 'ORB' }]));
    else if (url === `/projects/${PROJECT}/tickets/by-key/ORB-7`) res.end(JSON.stringify({ id: TICKET, ticketKey: 'ORB-7' }));
    else if (url === `/projects/${PROJECT}/ticket-statuses`) res.end(JSON.stringify([{ id: DONE, category: 'done' }]));
    else if (req.method === 'PATCH' && url === `/projects/${PROJECT}/tickets/${TICKET}`) {
      const patch = JSON.parse(body) as { keepTimer?: boolean };
      patches.push(patch);
      res.end(JSON.stringify(patch.keepTimer
        ? { id: TICKET, ticketKey: 'ORB-7', statusName: 'Done', timerStopped: false, timerMinutes: 0, workSessionsFinished: 0, timerKept: true }
        : { id: TICKET, ticketKey: 'ORB-7', statusName: 'Done', timerStopped: true, timerMinutes: 82, workSessionsFinished: 1 }));
    } else if (url.startsWith('/time/timer?')) {
      timerReads++;
      res.end('null');
    } else { res.statusCode = 404; res.end(JSON.stringify({ error: `unexpected ${req.method} ${url}` })); }
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

    const closed = JSON.parse((await run(['ticket', 'close', 'ORB-7'])).out);
    expect(closed).toMatchObject({ ticketKey: 'ORB-7', timerStopped: true, timerMinutes: 82, workSessionsFinished: 1 });
    expect(patches[0]).toEqual({ statusId: DONE });
    expect(timerReads).toBe(1);

    const kept = JSON.parse((await run(['ticket', 'close', 'ORB-7', '--keep-timer'])).out);
    expect(kept).toMatchObject({ ticketKey: 'ORB-7', timerStopped: false, timerKept: true });
    expect(kept).not.toHaveProperty('timerMinutes');
    expect(patches[1]).toEqual({ statusId: DONE, keepTimer: true });
    expect(timerReads).toBe(1);

    const moved = JSON.parse((await run(['ticket', 'move', 'ORB-7', 'done'])).out);
    expect(moved).toMatchObject({ ticketKey: 'ORB-7', timerStopped: true, timerMinutes: 82, workSessionsFinished: 1 });
    expect(patches[2]).toEqual({ statusId: DONE });

    const movedKept = JSON.parse((await run(['ticket', 'move', 'ORB-7', 'done', '--keep-timer'])).out);
    expect(movedKept).toMatchObject({ ticketKey: 'ORB-7', timerKept: true });
    expect(movedKept).not.toHaveProperty('timerStopped');
    expect(patches[3]).toEqual({ statusId: DONE, keepTimer: true });

    await run(['bulk-move', 'ORB-7', 'done', '--keep-timer']);
    await run(['bulk-move', 'ORB-7', 'done']);
    await run(['ticket', 'bulk-close', 'ORB-7', '--keep-timer']);
    await run(['ticket', 'bulk-close', 'ORB-7']);
    expect(patches.slice(4)).toEqual([
      { statusId: DONE, keepTimer: true }, { statusId: DONE },
      { statusId: DONE, keepTimer: true }, { statusId: DONE },
    ]);
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((ok, no) => server.close((err) => err ? no(err) : ok()));
    await rm(dir, { recursive: true, force: true });
  }
}, ciWindow(60_000));

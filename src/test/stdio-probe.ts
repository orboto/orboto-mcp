import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hermeticHome, hermeticSpawnEnv } from './hermetic-cli-env.js';

const mcpRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export interface RpcAnswer { result?: Record<string, unknown>; error?: { code: number; message: string } }

export interface StdioProbe {
  initialize: RpcAnswer;
  lists: Record<'tools/list' | 'prompts/list' | 'resources/list', RpcAnswer>;
  unknownTool: RpcAnswer;
  lines: string[];
}

/** ORB-2669 - the conversation a client such as Kimi Code opens with, over the real stdio entry: initialize, initialized, the three list methods without a capability check, one call of a tool that does not exist. */
export async function probeStdioServer(env: Record<string, string>, timeoutMs = 25_000): Promise<StdioProbe> {
  const api = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url?.startsWith('/system/mcp/status')) {
      res.end(JSON.stringify({ enabled: true, mcpUseGranted: true, userMcpEnabled: true, userEmail: 'probe@example.test' }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((ok) => api.listen(0, '127.0.0.1', ok));
  const address = api.address();
  if (!address || typeof address === 'string') throw new Error('probe API address missing');
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: mcpRoot,
    env: hermeticSpawnEnv({
      home: hermeticHome('mcp-stdio-probe'),
      env: { ORBOTO_API_URL: `http://127.0.0.1:${address.port}`, ORBOTO_API_KEY: 'orb_probe', ORBOTO_AUTH: 'pat', ...env },
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines: string[] = [];
  const answers = new Map<number, RpcAnswer>();
  const waiting = new Map<number, () => void>();
  let buffer = '', stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    for (let cut = buffer.indexOf('\n'); cut >= 0; cut = buffer.indexOf('\n')) {
      const line = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 1);
      if (!line) continue;
      lines.push(line);
      const message = JSON.parse(line) as { id?: number } & RpcAnswer;
      if (typeof message.id === 'number') {
        answers.set(message.id, { result: message.result, error: message.error });
        waiting.get(message.id)?.();
      }
    }
  });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const exited = new Promise<never>((_, no) => child.once('exit', (code) => no(new Error(`the MCP server exited with ${code} before it answered: ${stderr.slice(-600)}`))));
  exited.catch(() => undefined);
  const send = (message: object) => { child.stdin.write(`${JSON.stringify(message)}\n`); };
  const answer = (id: number) => Promise.race([
    new Promise<RpcAnswer>((ok) => {
      const have = answers.get(id);
      if (have) ok(have);
      else waiting.set(id, () => ok(answers.get(id)!));
    }),
    exited,
    new Promise<never>((_, no) => setTimeout(() => no(new Error(`no answer to request ${id} in ${timeoutMs} ms: ${stderr.slice(-600)}`)), timeoutMs).unref()),
  ]);
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stdio-probe', version: 'probe' } } });
    const initialize = await answer(1);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    send({ jsonrpc: '2.0', id: 3, method: 'prompts/list' });
    send({ jsonrpc: '2.0', id: 4, method: 'resources/list' });
    send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'orboto_no_such_tool', arguments: {} } });
    const [tools, prompts, resources, unknownTool] = await Promise.all([answer(2), answer(3), answer(4), answer(5)]);
    return { initialize, lists: { 'tools/list': tools, 'prompts/list': prompts, 'resources/list': resources }, unknownTool, lines };
  } finally {
    child.kill('SIGKILL');
    await new Promise<void>((ok) => api.close(() => ok()));
  }
}

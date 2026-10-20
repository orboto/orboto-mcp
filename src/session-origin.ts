/**
 * ORB-2544 - the `x-orboto-origin` header every request of this MCP server
 * carries: a stdio proxy names the harness that started it (or the origin the
 * CLI handed over in ORBOTO_ORIGIN), the HTTP server names itself as an
 * mcp-oauth process; a repository is only ever its basename.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { VERSION } from './version.js';

export interface McpOrigin {
  host?: string | null; machineId?: string | null; repo?: string | null; pid?: number | null;
  startedAt?: string | null; client?: string | null; clientVersion?: string | null; harness?: string | null; model?: string | null;
  checkout?: string | null;
}

const KEYS: Array<[string, keyof McpOrigin]> = [
  ['host', 'host'], ['machine', 'machineId'], ['repo', 'repo'], ['pid', 'pid'], ['start', 'startedAt'], ['client', 'client'], ['version', 'clientVersion'], ['harness', 'harness'], ['model', 'model'], ['checkout', 'checkout'],
];

const WRAPPED_HARNESSES: Record<string, string> = { claude: 'claude-code', 'claude-code': 'claude-code', codex: 'codex', gemini: 'gemini', kimi: 'kimi', agy: 'agy', antigravity: 'agy' };

/** ORB-2571 - the harness that started a stdio proxy: the one `orboto <harness>` named, else the markers a harness sets. */
export function stdioHarness(env: NodeJS.ProcessEnv = process.env): string {
  const wrapped = WRAPPED_HARNESSES[(env.ORBOTO_HARNESS ?? '').trim().toLowerCase()];
  if (wrapped) return wrapped;
  if (env.CLAUDECODE) return 'claude-code';
  if (env.CODEX_THREAD_ID || env.CODEX_SESSION_ID) return 'codex';
  if (env.GEMINI_CLI) return 'gemini';
  return 'mcp-stdio';
}

/** The header value; empty fields are left out. */
export function formatOrigin(origin: McpOrigin): string {
  const params = new URLSearchParams();
  for (const [key, field] of KEYS) {
    const value = origin[field];
    if (value !== null && value !== undefined && value !== '') params.set(key, String(value));
  }
  return params.toString();
}

/** The first label of the host name, lower-cased. */
export function shortHost(raw: string = hostname()): string | null {
  const first = raw.trim().toLowerCase().replace(/\.+$/, '').split('.')[0]?.replace(/[^a-z0-9_-]/g, '') ?? '';
  return first || null;
}

/** The repository the working directory sits in, as a basename; the directory's own basename outside a repository. */
export function repoBasename(cwd: string = process.cwd()): string | null {
  let dir = cwd;
  for (let i = 0; i < 40; i += 1) {
    if (existsSync(join(dir, '.git'))) return basename(dir) || null;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return basename(cwd) || null;
}

/** ORB-2553 - the hashed working tree the directory sits in (a linked worktree is its own), the same value the CLI sends; never a path. */
export function checkoutHash(cwd: string = process.cwd()): string {
  let root = cwd;
  for (let dir = cwd, i = 0; i < 40; i += 1) {
    if (existsSync(join(dir, '.git'))) { root = dir; break; }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  let physical = root;
  try { physical = realpathSync(root); } catch { /* an unreadable path hashes as given */ }
  return createHash('sha256').update(physical).digest('hex').slice(0, 16);
}

let machine: string | null | undefined;

/** A hashed stable machine id (the platform UUID on macOS, /etc/machine-id elsewhere); null when none is readable. */
export function machineId(read: () => string | null = readMachineId): string | null {
  if (machine !== undefined) return machine;
  const raw = read();
  machine = raw ? createHash('sha256').update(raw.trim()).digest('hex').slice(0, 16) : null;
  return machine;
}

function readMachineId(): string | null {
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', timeout: 2000 });
      return /"IOPlatformUUID" = "([^"]+)"/.exec(out)?.[1] ?? null;
    }
    for (const path of ['/etc/machine-id', '/var/lib/dbus/machine-id']) if (existsSync(path)) return readFileSync(path, 'utf8').trim() || null;
  } catch { /* an unreadable id leaves the origin without one */ }
  return null;
}

/** The stdio proxy's origin: what the CLI handed over, else the harness that started this process. */
export function stdioOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const handed = (env.ORBOTO_ORIGIN ?? '').trim();
  if (handed) {
    const params = new URLSearchParams(handed);
    params.set('client', 'orboto-mcp');
    params.set('version', VERSION);
    return params.toString();
  }
  return formatOrigin({
    host: shortHost(), machineId: machineId(), repo: repoBasename(), checkout: checkoutHash(), pid: process.ppid || null,
    client: 'orboto-mcp', clientVersion: VERSION,
    harness: stdioHarness(env),
    model: /^[\x21-\x7e]{1,80}$/.test((env.ORBOTO_MODEL ?? '').trim()) ? env.ORBOTO_MODEL!.trim() : null,
  });
}

/** The HTTP server's origin: the server process itself, the identity of every connection is its OAuth client. */
export function httpOrigin(): string {
  return formatOrigin({
    pid: process.pid, startedAt: new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString(),
    client: 'orboto-mcp', clientVersion: VERSION, harness: 'mcp-oauth',
  });
}

let mode: 'stdio' | 'http' = 'stdio';
let cached: { mode: string; value: string } | null = null;

/** The HTTP transport switches the process to its own origin on start. */
export function useHttpOrigin(): void {
  mode = 'http';
  cached = null;
}

/** The header value every request of this process sends. */
export function originHeader(): string {
  if (!cached || cached.mode !== mode) cached = { mode, value: mode === 'http' ? httpOrigin() : stdioOrigin() };
  return cached.value;
}

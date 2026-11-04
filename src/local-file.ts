/** ORB-2758 - the stdio server reads an attachment from the user's disk itself, only below the allowed roots and never from a hidden or secret location. */
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const ATTACH_ROOTS_ENV = 'ORBOTO_MCP_ATTACH_ROOTS';
export const LOCAL_FILE_MAX_BYTES = 50 * 1024 * 1024;

/** Known secret stores, refused even inside a root; compared case-insensitively. */
export const SECRET_SEGMENTS: ReadonlySet<string> = new Set(['.ssh', '.aws', '.gnupg', '.orboto', '.claude', 'keychains', '.config']);

/** Mirror of DANGEROUS_EXTENSIONS in apps/api/src/lib/attachment-mimes.ts; local-file.test.ts holds the two together. */
export const BLOCKED_EXTENSIONS: ReadonlySet<string> = new Set([
  '.html', '.htm', '.xhtml', '.svg', '.svgz', '.js', '.mjs', '.cjs', '.exe', '.msi', '.sh', '.csh', '.bat', '.cmd', '.scr', '.com', '.swf', '.jar',
]);

export class LocalFileRefused extends Error {
  constructor(reason: string, roots: readonly string[]) {
    const where = roots.length > 0 ? roots.join(path.delimiter === ';' ? '; ' : ', ') : 'none';
    super(`filePath refused: ${reason}. Allowed roots: ${where}. Change them with ${ATTACH_ROOTS_ENV} in the orboto MCP server's env (paths separated by "${path.delimiter}", "none" switches filePath off) and restart the server; or mint a browser upload link with orboto_upload_link.`);
    this.name = 'LocalFileRefused';
  }
}

export interface LocalFile { bytes: Buffer; filename: string; realPath: string }

/** The configured roots, or Downloads, Desktop and Documents in the home directory; the working directory is never a default, a client may start the server in "/" or in the home directory. */
export function configuredAttachRoots(
  env: { ORBOTO_MCP_ATTACH_ROOTS?: string } = { ORBOTO_MCP_ATTACH_ROOTS: process.env.ORBOTO_MCP_ATTACH_ROOTS }, home = homedir(),
): string[] {
  const raw = env.ORBOTO_MCP_ATTACH_ROOTS?.trim();
  if (raw?.toLowerCase() === 'none') return [];
  if (raw) return raw.split(path.delimiter).map((p) => p.trim()).filter(Boolean).map((p) => path.resolve(expandHome(p, home)));
  return [path.join(home, 'Downloads'), path.join(home, 'Desktop'), path.join(home, 'Documents')];
}

function expandHome(p: string, home: string): string {
  return p === '~' ? home : p.startsWith(`~${path.sep}`) || p.startsWith('~/') ? path.join(home, p.slice(2)) : p;
}

function segmentsOf(relative: string): string[] {
  return relative.split(/[\\/]+/).filter((s) => s.length > 0 && s !== '.');
}

function isSecretSegment(segment: string): boolean {
  return SECRET_SEGMENTS.has(segment.toLowerCase());
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
}

/** What the roots guard knows about the machine: the home directory (both spellings), the platform and the directories that hold application data. */
export interface AttachGuard { homes: readonly string[]; platform: NodeJS.Platform; protectedDirs: readonly string[] }

export interface GuardOptions {
  home?: string;
  platform?: NodeJS.Platform;
  processEnv?: { APPDATA?: string; LOCALAPPDATA?: string };
  log?: (line: string) => void;
}

const loggedRefusals = new Set<string>();

/** One line on stderr per refused root and reason for the life of the process; stdout belongs to the protocol. */
function logRefusedRoot(line: string): void {
  if (loggedRefusals.has(line)) return;
  loggedRefusals.add(line);
  process.stderr.write(`${line}\n`);
}

/** The folders that hold application secrets and browser stores without being hidden: ~/Library on macOS, %APPDATA% and %LOCALAPPDATA% on Windows. */
export async function buildAttachGuard(opts: GuardOptions = {}): Promise<AttachGuard> {
  const home = opts.home ?? homedir();
  const platform = opts.platform ?? process.platform;
  const env = opts.processEnv ?? process.env;
  const protectedDirs = platform === 'darwin'
    ? [path.join(home, 'Library')]
    : platform === 'win32' ? [env.APPDATA, env.LOCALAPPDATA].filter((d): d is string => !!d?.trim()).map((d) => path.resolve(d)) : [];
  const spellings = async (dirs: readonly string[]) => {
    const all = new Set(dirs);
    for (const dir of dirs) all.add(await realpath(dir).catch(() => dir));
    return [...all];
  };
  return { homes: await spellings([home]), platform, protectedDirs: await spellings(protectedDirs) };
}

/** Why a root must not be used: it would cover the machine, the home directory or the application data, not just a user folder. */
export function refusedRootReason(root: string, guard: AttachGuard): string | null {
  if (path.parse(root).root === root || /^[A-Za-z]:[\\/]*$/.test(root)) return 'it is a filesystem or drive root';
  if (guard.platform === 'darwin') {
    const segments = segmentsOf(root);
    if (segments.length === 2 && segments[0].toLowerCase() === 'volumes') return 'it is a volume root';
  }
  if (guard.homes.some((home) => isInside(root, home))) return 'it is the home directory or a parent of it';
  return protectedPathReason(root, guard);
}

/** The reason a path may never be read, wherever the root that contains it is: it lies in a folder of application data. */
export function protectedPathReason(candidate: string, guard: AttachGuard): string | null {
  const dir = guard.protectedDirs.find((d) => isInside(d, candidate));
  return dir ? `it lies in ${dir}, which holds application data` : null;
}

/** Every configured root that exists, resolved through its symlinks; a root inside a secret store, in application data or covering the machine is dropped and named on stderr. */
export async function effectiveAttachRoots(configured: readonly string[], opts: GuardOptions = {}): Promise<string[]> {
  const guard = await buildAttachGuard(opts);
  return effectiveRootsFor(configured, guard, opts.log ?? logRefusedRoot);
}

async function effectiveRootsFor(configured: readonly string[], guard: AttachGuard, log: (line: string) => void): Promise<string[]> {
  const roots: string[] = [];
  for (const root of configured) {
    const real = await realpath(root).catch(() => null);
    if (!real) continue;
    const reason = segmentsOf(real).some(isSecretSegment) ? 'it lies in a secret location' : refusedRootReason(real, guard);
    if (reason) {
      log(`[orboto-mcp] ${ATTACH_ROOTS_ENV}: root "${root}" is ignored: ${reason}`);
      continue;
    }
    if (!roots.includes(real)) roots.push(real);
  }
  return roots;
}

function belowRootProblem(relative: string): string | null {
  for (const segment of segmentsOf(relative)) {
    if (segment === '..') return 'the path leaves the allowed roots';
    if (isSecretSegment(segment)) return `"${segment}" is a secret location`;
    if (segment.startsWith('.')) return `"${segment}" is a hidden file or directory`;
  }
  return null;
}

/** Reads `filePath` after the roots guard, the size cap and the blocked-type check; nothing is read before every check passed. */
export async function readLocalAttachment(
  filePath: string, opts: GuardOptions & { env?: { ORBOTO_MCP_ATTACH_ROOTS?: string }; cwd?: string } = {},
): Promise<LocalFile> {
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const guard = await buildAttachGuard({ ...opts, home });
  const roots = await effectiveRootsFor(configuredAttachRoots(opts.env, home), guard, opts.log ?? logRefusedRoot);
  if (roots.length === 0) throw new LocalFileRefused('no allowed root exists that is usable', roots);

  const requested = path.resolve(cwd, expandHome(filePath, home));
  const lexicalProtected = protectedPathReason(requested, guard);
  if (lexicalProtected) throw new LocalFileRefused(lexicalProtected, roots);
  const lexicalRoot = roots.find((r) => isInside(r, requested));
  if (lexicalRoot) {
    const lexicalProblem = belowRootProblem(path.relative(lexicalRoot, requested));
    if (lexicalProblem) throw new LocalFileRefused(lexicalProblem, roots);
  } else if (segmentsOf(requested).some(isSecretSegment)) {
    throw new LocalFileRefused('the path names a secret location', roots);
  }

  const real = await realpath(requested).catch((err: NodeJS.ErrnoException) => {
    throw err.code === 'ENOENT' ? new Error(`filePath not found: ${requested}`) : err;
  });
  const realRoot = roots.find((r) => isInside(r, real));
  if (!realRoot) {
    throw new LocalFileRefused(lexicalRoot ? 'a symlink on the path points outside the allowed roots' : 'the path is outside the allowed roots', roots);
  }
  const realProtected = protectedPathReason(real, guard);
  if (realProtected) throw new LocalFileRefused(realProtected, roots);
  const problem = belowRootProblem(path.relative(realRoot, real));
  if (problem) throw new LocalFileRefused(lexicalRoot ? problem : `${problem} (through a symlink)`, roots);

  const filename = path.basename(requested);
  const ext = path.extname(filename).toLowerCase();
  if (BLOCKED_EXTENSIONS.has(ext) || BLOCKED_EXTENSIONS.has(path.extname(real).toLowerCase())) {
    throw new Error(`filePath refused: ${ext || 'this'} files are blocked by the attachment type policy (HTML, SVG, scripts, executables).`);
  }
  const info = await stat(real);
  if (!info.isFile()) throw new LocalFileRefused('the path is not a regular file', roots);
  if (info.nlink > 1) throw new LocalFileRefused('the file is hard-linked', roots);
  if (info.size === 0) throw new Error('filePath refused: the file is empty.');
  if (info.size > LOCAL_FILE_MAX_BYTES) throw new Error(`filePath refused: the file is ${Math.ceil(info.size / (1024 * 1024))} MB, the attachment limit is 50 MB.`);

  const handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink > 1 || opened.ino !== info.ino || opened.dev !== info.dev) throw new LocalFileRefused('the file changed while it was checked', roots);
    if (opened.size > LOCAL_FILE_MAX_BYTES) throw new Error('filePath refused: the attachment limit is 50 MB.');
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return { bytes: bytes.subarray(0, offset), filename, realPath: real };
  } finally {
    await handle.close();
  }
}

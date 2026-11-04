/** ORB-2758 - the stdio `filePath`: a 480 KB PDF lands with one call that carries no base64, and the roots guard refuses everything outside the roots, hidden, secret or reached through an escaping symlink. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { link, mkdtemp, mkdir, readFile, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { OrbotoClient } from './orboto-client.js';
import { buildOrbotoMcpServer } from './server.js';
import { makeAttachToTicketHandler } from './tools/attach.js';
import { makeUploadDocAttachmentHandler } from './tools/doc-attachments.js';
import {
  ATTACH_ROOTS_ENV, BLOCKED_EXTENSIONS, LOCAL_FILE_MAX_BYTES, LocalFileRefused, configuredAttachRoots, effectiveAttachRoots, protectedPathReason, readLocalAttachment, refusedRootReason,
  type AttachGuard,
} from './local-file.js';

let base: string;
let root: string;
let outside: string;
const savedRoots = process.env[ATTACH_ROOTS_ENV];

beforeEach(async () => {
  vi.restoreAllMocks();
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'orb-2758-')));
  root = path.join(base, 'Downloads');
  outside = path.join(base, 'elsewhere');
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  process.env[ATTACH_ROOTS_ENV] = root;
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (savedRoots === undefined) delete process.env[ATTACH_ROOTS_ENV];
  else process.env[ATTACH_ROOTS_ENV] = savedRoots;
  await rm(base, { recursive: true, force: true });
});

async function pdfFixture(dir: string, name: string, bytes = 480 * 1024): Promise<string> {
  const head = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n');
  const tail = Buffer.from('\n%%EOF\n');
  const file = path.join(dir, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.concat([head, Buffer.alloc(bytes - head.length - tail.length, 0x20), tail]));
  return file;
}

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });
const PROJ = { id: 'p1', key: 'PRE', name: 'Pre', description: null, status: 'active' };
const TICKET = { id: 't1', projectId: 'p1', ticketKey: 'PRE-289', ticketNumber: 289, title: 'Plans', description: '' };

function captureUploads(answers: unknown[]) {
  const uploads: Array<{ url: string; file: File }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (init?.body instanceof FormData) uploads.push({ url: url.toString(), file: init.body.get('file') as File });
    const json = answers.shift();
    return { ok: true, status: 200, statusText: 'OK', json: async () => json, text: async () => JSON.stringify(json) } as unknown as Response;
  });
  return uploads;
}

async function refusal(filePath: string): Promise<LocalFileRefused> {
  const err = await readLocalAttachment(filePath).then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(LocalFileRefused);
  return err as LocalFileRefused;
}

describe('ORB-2758 - stdio filePath', () => {
  it('attaches a 480 KB PDF to a ticket in one call whose arguments carry no base64', async () => {
    const file = await pdfFixture(root, 'PRE-289/Haus01_Grundriss.pdf');
    const uploads = captureUploads([PROJ, TICKET, { id: 'att1', filename: 'Haus01_Grundriss.pdf', mimetype: 'application/pdf', sizeBytes: 480 * 1024, downloadUrl: '/attachments/att1' }]);
    const args = { ticketKey: 'PRE-289', filePath: file };

    const res = await makeAttachToTicketHandler(client, { localFiles: true })(args);

    expect(JSON.stringify(args).length).toBeLessThan(200);
    expect(uploads).toHaveLength(1);
    expect(uploads[0].url).toBe('https://orboto.example.com/tickets/t1/attachments');
    expect(uploads[0].file.name).toBe('Haus01_Grundriss.pdf');
    expect(uploads[0].file.type).toBe('application/pdf');
    expect(uploads[0].file.size).toBe(480 * 1024);
    expect(Buffer.from(await uploads[0].file.arrayBuffer()).equals(await readFile(file))).toBe(true);
    expect(res.structuredContent).toMatchObject({ ticketKey: 'PRE-289', attachmentId: 'att1', sizeBytes: 480 * 1024 });
  });

  it('attaches a local file to a doc the same way', async () => {
    const file = await pdfFixture(root, 'plan.pdf', 4096);
    const uploads = captureUploads([{ id: 'att2', filename: 'plan.pdf', contentType: 'application/pdf', sizeBytes: 4096, downloadUrl: '/attachments/att2' }]);
    await makeUploadDocAttachmentHandler(client, { localFiles: true })({ docId: '9f1c1b0e-6c1b-4b7e-9a7c-1d2e3f4a5b6c', filePath: file });
    expect(uploads[0].url).toBe('https://orboto.example.com/docs/9f1c1b0e-6c1b-4b7e-9a7c-1d2e3f4a5b6c/attachments');
    expect(uploads[0].file.size).toBe(4096);
  });

  it('refuses a path outside the roots and names the roots and the env that changes them', async () => {
    const err = await refusal(await pdfFixture(outside, 'x.pdf', 1024));
    expect(err.message).toContain('outside the allowed roots');
    expect(err.message).toContain(root);
    expect(err.message).toContain(ATTACH_ROOTS_ENV);
  });

  it('refuses a hidden segment inside a root', async () => {
    expect((await refusal(await pdfFixture(root, '.private/x.pdf', 1024))).message).toContain('".private" is a hidden file or directory');
    await writeFile(path.join(root, '.env'), 'TOKEN=x');
    expect((await refusal(path.join(root, '.env'))).message).toContain('hidden');
  });

  it('refuses a secret directory even inside a root', async () => {
    await mkdir(path.join(root, '.ssh'), { recursive: true });
    await writeFile(path.join(root, '.ssh', 'id_ed25519'), 'key');
    expect((await refusal(path.join(root, '.ssh', 'id_ed25519'))).message).toContain('".ssh" is a secret location');
    expect((await refusal(await pdfFixture(root, 'Keychains/login.pdf', 1024))).message).toContain('"Keychains" is a secret location');
  });

  it('refuses a symlink that escapes the roots, and one that reaches a hidden file inside them', async () => {
    const target = await pdfFixture(outside, 'secret.pdf', 1024);
    await symlink(target, path.join(root, 'innocent.pdf'));
    expect((await refusal(path.join(root, 'innocent.pdf'))).message).toContain('a symlink on the path points outside the allowed roots');
    await symlink(outside, path.join(root, 'linked-dir'));
    expect((await refusal(path.join(root, 'linked-dir', 'secret.pdf'))).message).toContain('outside the allowed roots');
    const hidden = await pdfFixture(root, '.cache/x.pdf', 1024);
    await symlink(hidden, path.join(root, 'plain.pdf'));
    expect((await refusal(path.join(root, 'plain.pdf'))).message).toContain('hidden');
  });

  it('checks size and type before reading the file', async () => {
    const big = path.join(root, 'huge.pdf');
    await writeFile(big, '');
    await truncate(big, LOCAL_FILE_MAX_BYTES + 1);
    await expect(readLocalAttachment(big)).rejects.toThrow('the attachment limit is 50 MB');
    await writeFile(path.join(root, 'page.html'), '<script></script>');
    await expect(readLocalAttachment(path.join(root, 'page.html'))).rejects.toThrow('blocked by the attachment type policy');
    await mkdir(path.join(root, 'folder.pdf'));
    expect((await refusal(path.join(root, 'folder.pdf'))).message).toContain('not a regular file');
  });

  it('defaults to Downloads, Desktop and Documents and never the working directory; a list or "none" overrides them', () => {
    const defaults = ['/home/u/Downloads', '/home/u/Desktop', '/home/u/Documents'];
    expect(configuredAttachRoots({}, '/home/u')).toEqual(defaults);
    expect(configuredAttachRoots({ [ATTACH_ROOTS_ENV]: `/a${path.delimiter}~/b${path.delimiter}` }, '/home/u')).toEqual(['/a', '/home/u/b']);
    expect(configuredAttachRoots({ [ATTACH_ROOTS_ENV]: 'none' }, '/home/u')).toEqual([]);
  });

  it('drops a root that lies inside a secret store and refuses when no root is left', async () => {
    const secretRoot = path.join(base, '.config', 'exports');
    await mkdir(secretRoot, { recursive: true });
    expect(await effectiveAttachRoots([secretRoot, root, path.join(base, 'missing')])).toEqual([root]);
    process.env[ATTACH_ROOTS_ENV] = 'none';
    expect((await refusal(await pdfFixture(root, 'x.pdf', 1024))).message).toContain('Allowed roots: none');
  });

  it('refuses a hard link inside a root, because it is the same file as one outside it', async () => {
    const target = await pdfFixture(outside, 'private.pdf', 1024);
    await link(target, path.join(root, 'innocent.pdf'));
    expect((await refusal(path.join(root, 'innocent.pdf'))).message).toContain('the file is hard-linked');
    await expect(readLocalAttachment(target)).rejects.toThrow('outside the allowed roots');
  });

  it('BLOCKED_EXTENSIONS is the API policy list', async () => {
    const policy = await readFile(fileURLToPath(new URL('../../api/src/lib/attachment-mimes.ts', import.meta.url)), 'utf8');
    const block = /const DANGEROUS_EXTENSIONS = new Set\(\[([\s\S]*?)\]\)/.exec(policy)![1];
    expect([...block.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort()).toEqual([...BLOCKED_EXTENSIONS].sort());
  });
});

async function listedTools(localFiles: boolean) {
  const server = await buildOrbotoMcpServer({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_test', toolset: 'full', ...(localFiles ? { localFiles } : {}) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'file-path-surface', version: '0' });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  try {
    return (await mcp.listTools()).tools as Array<{ name: string; description?: string; inputSchema: { properties?: Record<string, unknown>; required?: string[] } }>;
  } finally {
    await mcp.close();
    await server.close();
  }
}

describe('ORB-2758 - only the stdio server offers filePath', () => {
  beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline test')); });

  it('the HTTP build has no filePath and keeps contentBase64 required; the stdio build takes either', async () => {
    for (const name of ['orboto_attach_to_ticket', 'orboto_upload_doc_attachment']) {
      const http = (await listedTools(false)).find((t) => t.name === name)!;
      expect(Object.keys(http.inputSchema.properties ?? {})).not.toContain('filePath');
      expect(http.inputSchema.required).toContain('contentBase64');
      expect(http.description).toContain('orboto_upload_link');
      expect(http.description).toContain('25 KB');
      const stdio = (await listedTools(true)).find((t) => t.name === name)!;
      expect(Object.keys(stdio.inputSchema.properties ?? {})).toContain('filePath');
      expect(stdio.inputSchema.required ?? []).not.toContain('contentBase64');
      expect(stdio.description).toContain('filePath');
    }
  });

  it('the HTTP transport never builds with localFiles, the stdio entry always does', async () => {
    const http = await readFile(fileURLToPath(new URL('./http-transport.ts', import.meta.url)), 'utf8');
    const stdio = await readFile(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');
    expect(http).not.toMatch(/localFiles/);
    expect(stdio).toMatch(/buildOrbotoMcpServer\(\{[^}]*localFiles: true/);
  });

  it('a handler built without localFiles refuses filePath before touching the disk', async () => {
    const file = await pdfFixture(root, 'x.pdf', 1024);
    await expect(makeAttachToTicketHandler(client)({ ticketKey: 'PRE-289', filePath: file })).rejects.toThrow('only read by the local stdio server');
  });

  it('exactly one of filePath and contentBase64', async () => {
    const file = await pdfFixture(root, 'x.pdf', 1024);
    const handler = makeAttachToTicketHandler(client, { localFiles: true });
    await expect(handler({ ticketKey: 'PRE-289', filePath: file, contentBase64: 'AAAA', filename: 'x.pdf' })).rejects.toThrow('exactly one');
    await expect(handler({ ticketKey: 'PRE-289' })).rejects.toThrow('exactly one');
    await expect(handler({ ticketKey: 'PRE-289', contentBase64: 'AAAA' })).rejects.toThrow('filename is required');
  });
});

const CONFIG_JSON = '{"mcpServers":{"orboto":{"env":{"ORBOTO_API_KEY":"orb_secret_value"}}}}';

/** A home directory fixture with the three default roots and the Claude Desktop config below Library, standing in for the real one. */
async function homeFixture() {
  const home = path.join(base, 'home');
  for (const dir of ['Downloads', 'Desktop', 'Documents']) await mkdir(path.join(home, dir), { recursive: true });
  const config = path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  await mkdir(path.dirname(config), { recursive: true });
  await writeFile(config, CONFIG_JSON);
  return { home, config };
}

describe('ORB-2758 - the default roots cover the user folders, not whatever directory the server started in', () => {
  it('a client that starts the server in "/" or in the home directory gives the guard no root from the working directory', async () => {
    const { home, config } = await homeFixture();
    await writeFile(path.join(base, 'passwd-standin.txt'), 'root:x:0:0');
    for (const cwd of [home, base, '/']) {
      const absolute = await readLocalAttachment(config, { env: {}, home, cwd, platform: 'darwin' }).then(() => null, (e: unknown) => e);
      expect(absolute).toBeInstanceOf(LocalFileRefused);
      expect((absolute as LocalFileRefused).message).toMatch(/application data|outside the allowed roots/);
      const relative = path.relative(cwd, config);
      const viaCwd = await readLocalAttachment(relative, { env: {}, home, cwd, platform: 'darwin' }).then(() => null, (e: unknown) => e);
      expect(viaCwd).toBeInstanceOf(LocalFileRefused);
      expect(String((viaCwd as Error).message)).not.toContain('orb_secret_value');
    }
    const standin = await readLocalAttachment('passwd-standin.txt', { env: {}, home, cwd: base, platform: 'darwin' }).then(() => null, (e: unknown) => e);
    expect(standin).toBeInstanceOf(LocalFileRefused);
    expect((standin as LocalFileRefused).message).toContain('outside the allowed roots');
  });

  it('a file in Downloads is still read with the defaults, from any working directory', async () => {
    const { home } = await homeFixture();
    const file = await pdfFixture(path.join(home, 'Downloads'), 'plan.pdf', 2048);
    for (const cwd of [home, base, '/']) {
      expect((await readLocalAttachment(file, { env: {}, home, cwd, platform: 'darwin' })).bytes).toHaveLength(2048);
    }
  });
});

describe('ORB-2758 - a root that would cover the machine is refused and said so on stderr', () => {
  it('drops "/", the home directory and a parent of it, keeps an unrelated root, and logs each refusal without any file content', async () => {
    const { home } = await homeFixture();
    const log: string[] = [];
    const roots = await effectiveAttachRoots(['/', base, home, root], { home, platform: 'darwin', log: (line) => log.push(line) });
    expect(roots).toEqual([root]);
    expect(log).toHaveLength(3);
    expect(log[0]).toContain('"/"');
    expect(log[1]).toContain(`"${base}"`);
    expect(log[2]).toContain(`"${home}"`);
    expect(log.join('\n')).toContain(ATTACH_ROOTS_ENV);
    expect(log.join('\n')).not.toContain('orb_secret_value');
  });

  it('an explicit "~" root is refused, so nothing in the home directory is readable through it', async () => {
    const { home, config } = await homeFixture();
    const pdf = await pdfFixture(path.join(home, 'Documents'), 'plan.pdf', 1024);
    for (const file of [config, pdf]) {
      const err = await readLocalAttachment(file, { env: { [ATTACH_ROOTS_ENV]: '~' }, home, platform: 'darwin', log: () => undefined }).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(LocalFileRefused);
      expect((err as LocalFileRefused).message).toContain('Allowed roots: none');
    }
  });

  it('names the refusal on the real stderr when no log function is given', async () => {
    const { home } = await homeFixture();
    const written: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write);
    await effectiveAttachRoots([home], { home, platform: 'darwin' });
    expect(written.join('')).toContain(`"${home}"`);
    expect(written.join('')).toContain(ATTACH_ROOTS_ENV);
  });

  it('classifies the roots that cover a machine: filesystem root, volume root, drive root, the home directory and its parents', () => {
    const mac: AttachGuard = { homes: ['/Users/u'], platform: 'darwin', protectedDirs: ['/Users/u/Library'] };
    expect(refusedRootReason('/', mac)).toMatch(/filesystem or drive root/);
    expect(refusedRootReason('/Volumes/Data', mac)).toMatch(/volume root/);
    expect(refusedRootReason('/Users', mac)).toMatch(/home directory or a parent/);
    expect(refusedRootReason('/Users/u', mac)).toMatch(/home directory or a parent/);
    expect(refusedRootReason('/Users/u/Library/Application Support', mac)).toMatch(/application data/);
    expect(refusedRootReason('/Volumes/Data/projects', mac)).toBeNull();
    expect(refusedRootReason('/Users/u/Downloads', mac)).toBeNull();
    expect(refusedRootReason('/Users/shared', mac)).toBeNull();
    const win: AttachGuard = { homes: ['C:\\Users\\u'], platform: 'win32', protectedDirs: ['C:\\Users\\u\\AppData\\Roaming', 'C:\\Users\\u\\AppData\\Local'] };
    expect(refusedRootReason('C:\\', win)).toMatch(/filesystem or drive root/);
    expect(refusedRootReason('D:', win)).toMatch(/filesystem or drive root/);
  });
});

describe('ORB-2758 - application data stays unreadable even when a root names it', () => {
  it('refuses anything below ~/Library on macOS, the probe config file included', async () => {
    const { home, config } = await homeFixture();
    const library = path.join(home, 'Library', 'Application Support', 'Claude');
    const log: string[] = [];
    expect(await effectiveAttachRoots([library, path.join(home, 'Library')], { home, platform: 'darwin', log: (line) => log.push(line) })).toEqual([]);
    expect(log).toHaveLength(2);
    const err = await readLocalAttachment(config, { env: { [ATTACH_ROOTS_ENV]: library }, home, platform: 'darwin', log: () => undefined }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(LocalFileRefused);
    expect(String((err as Error).message)).not.toContain('orb_secret_value');
  });

  it('refuses a path below the protected directory whichever root contained it', () => {
    const mac: AttachGuard = { homes: ['/Users/u'], platform: 'darwin', protectedDirs: ['/Users/u/Library'] };
    expect(protectedPathReason('/Users/u/Library/Application Support/Claude/claude_desktop_config.json', mac)).toMatch(/Library/);
    expect(protectedPathReason('/Users/u/Library', mac)).toMatch(/Library/);
    expect(protectedPathReason('/Users/u/Downloads/Library/x.pdf', mac)).toBeNull();
    expect(protectedPathReason('/Users/u/LibraryNotes/x.pdf', mac)).toBeNull();
  });

  it('refuses %APPDATA% and %LOCALAPPDATA% on Windows', async () => {
    const { home } = await homeFixture();
    const roaming = path.join(home, 'AppData', 'Roaming');
    const local = path.join(home, 'AppData', 'Local');
    await mkdir(path.join(roaming, 'Claude'), { recursive: true });
    await mkdir(local, { recursive: true });
    const win = { home, platform: 'win32' as const, processEnv: { APPDATA: roaming, LOCALAPPDATA: local }, log: () => undefined };
    expect(await effectiveAttachRoots([path.join(roaming, 'Claude'), local, path.join(home, 'Documents')], win)).toEqual([path.join(home, 'Documents')]);
    const config = path.join(roaming, 'Claude', 'claude_desktop_config.json');
    await writeFile(config, CONFIG_JSON);
    const err = await readLocalAttachment(config, { env: { [ATTACH_ROOTS_ENV]: path.join(roaming, 'Claude') }, ...win }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(LocalFileRefused);
  });

  it('leaves ~/Library alone on a platform where it is an ordinary folder', async () => {
    const { home } = await homeFixture();
    const notes = path.join(home, 'Library', 'notes');
    await mkdir(notes, { recursive: true });
    expect(await effectiveAttachRoots([notes], { home, platform: 'linux', log: () => undefined })).toEqual([await realpath(notes)]);
  });
});

/** ORB-2684 - the origin remote of the MCP server's checkout as a heartbeat's `repository`, parsed like the Go CLI and the wrapper (checkout-project.mjs). */
import { spawnSync } from 'node:child_process';

export interface CheckoutRepository { owner: string; name: string; host?: string }

const SCP_REMOTE = /^(?:[^@/\s]+@)?[^:/\s]+:(.+)$/;

/** Owner and name of an https, ssh or scp-like remote on any host; null when it names none. */
export function parseRemote(raw: string): { owner: string; name: string } | null {
  const remote = raw.trim();
  let path: string;
  if (remote.includes('://')) {
    try { path = new URL(remote).pathname; } catch { return null; }
  } else {
    const match = SCP_REMOTE.exec(remote);
    if (!match) return null;
    path = match[1];
  }
  let parts = path.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  if (parts[0] === 'v3' && parts.length === 4) parts = [parts[1], parts[3]];
  const git = parts.indexOf('_git');
  if (git > 0 && git + 1 < parts.length) parts = [parts[0], parts[git + 1]];
  if (parts[0] === 'scm' && parts.length > 2) parts = parts.slice(1);
  if (parts.length < 2) return null;
  const name = parts[parts.length - 1].replace(/\.git$/, '');
  const owner = parts.slice(0, -1).join('/').replace(/^~/, '');
  return owner && name ? { owner, name } : null;
}

/** The host of a remote, empty when it names none. */
export function remoteHost(raw: string): string {
  const remote = raw.trim();
  if (remote.includes('://')) {
    try { return new URL(remote).hostname; } catch { return ''; }
  }
  const match = SCP_REMOTE.exec(remote);
  if (!match) return '';
  const head = remote.slice(0, remote.length - match[1].length - 1);
  return head.slice(head.lastIndexOf('@') + 1);
}

/** The origin remote's URL of the checkout at `cwd`; empty outside a repository or without one. */
function originUrl(cwd: string): string {
  const res = spawnSync('git', ['-C', cwd, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8', timeout: 2000 });
  return res.status === 0 ? String(res.stdout ?? '').trim() : '';
}

/** The checkout's repository for a heartbeat, or null when the working directory has no parsable origin remote. */
export function checkoutRepository(cwd: string = process.cwd(), read: (dir: string) => string = originUrl): CheckoutRepository | null {
  const remote = read(cwd);
  const parsed = remote ? parseRemote(remote) : null;
  if (!parsed) return null;
  const host = remoteHost(remote).toLowerCase();
  return { owner: parsed.owner.slice(0, 255), name: parsed.name.slice(0, 255), ...(host ? { host: host.slice(0, 255) } : {}) };
}

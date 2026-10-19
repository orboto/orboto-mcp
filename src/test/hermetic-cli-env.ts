import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** ORB-2590 - the environment of every test that spawns the Go CLI or the skill wrapper: an allowlist, never process.env, so a developer's ~/.orboto bindings, ORBOTO_* and the parent harness's CLAUDE* markers cannot reach the child. */
/** Runtime essentials and settings that do not identify the developer: the CLI reads CI (browser timeouts), a child may need the proxy, certificate and locale variables to reach the network. */
export const INHERITED_NAMES = [
  'PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'PATHEXT', 'CI',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'LANG', 'LC_ALL', 'TZ',
];
const homes = new Set<string>();

export interface HermeticEnvOptions { home: string; baseUrl?: string; token?: string; profile?: string; env?: Record<string, string> }

/** A fresh empty HOME for one test; removed when the test process exits. */
export function hermeticHome(label = 'spawn'): string {
  const dir = mkdtempSync(join(tmpdir(), `orboto-hermetic-${label}-`));
  homes.add(dir);
  return dir;
}

process.once('exit', () => { for (const dir of homes) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } } });

/** HOME, USERPROFILE, XDG and temp dirs all inside `home`, the runtime essentials, an explicit instance, and only the `env` entries the test names. */
export function hermeticSpawnEnv({ home, baseUrl, token, profile, env = {} }: HermeticEnvOptions, inherited: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {
    HOME: home, USERPROFILE: home, TMPDIR: home, TMP: home, TEMP: home,
    XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.local', 'state'), XDG_CACHE_HOME: join(home, '.cache'),
  };
  for (const name of INHERITED_NAMES) { const value = inherited[name]; if (value) out[name] = value; }
  if (baseUrl !== undefined) out.ORBOTO_BASE_URL = baseUrl;
  if (token !== undefined) out.ORBOTO_TOKEN = token;
  if (profile !== undefined) out.ORBOTO_PROFILE = profile;
  return { ...out, ...env };
}

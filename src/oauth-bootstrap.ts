/**
 * ORB-943 - OAuth bootstrap for the stdio local-proxy.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { VERSION } from './version.js';

/** The single required capability scope + offline_access so the AS mints a
 *  refresh token we can cache (without it the connection dies after the 1h
 *  access-token TTL and forces a browser re-auth). Mirrors the HTTP client. */
export const BOOTSTRAP_SCOPE = 'mcp offline_access';

/** Skew applied when deciding whether a cached access token is still usable.
 *  A token within this window of expiry is treated as expired so we refresh
 *  proactively rather than racing a mid-request 401. */
export const EXPIRY_SKEW_MS = 60_000;

export interface AuthServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  code_challenge_methods_supported?: string[];
}

export interface OAuthTokenSet {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch ms at which the access token expires. */
  expiresAt: number;
  scope: string;
}

export interface CachedGrant {
  clientId: string;
  refreshToken: string;
  scope: string;
  /** Metadata endpoints captured at register time so a refresh doesn't need to
   *  re-discover. */
  tokenEndpoint: string;
  accessToken?: string;
  /** Epoch ms at which the cached access token expires. */
  expiresAt?: number;
}

type FetchLike = typeof fetch;

export interface Pkce {
  verifier: string;
  challenge: string;
  method: 'S256';
}

/** Generate a PKCE verifier + S256 challenge. Verifier is 32 random bytes
 *  base64url (43 chars), well within the RFC's 43-128 range. */
export function generatePkce(): Pkce {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge, method: 'S256' };
}

/** Random opaque state to bind the browser round-trip against CSRF. */
export function generateState(): string {
  return randomBytes(16).toString('base64url');
}

/**
 * The OAuth authorization server lives at the instance ORIGIN, while the stdio
 * proxy is configured with the REST base (`<origin>/api`). Strip a trailing
 * `/api` (single-host reverse-proxy layout, ORB-938) to recover the origin the
 * well-known metadata is served from. A base that is already the bare origin is
 * returned unchanged.
 */
export function deriveOrigin(apiBaseUrl: string): string {
  const trimmed = apiBaseUrl.replace(/\/+$/, '');
  return trimmed.replace(/\/api$/, '');
}

/** Fetch + validate the RFC 8414 authorization-server metadata. */
export async function discoverAuthServer(origin: string, fetchImpl: FetchLike = fetch): Promise<AuthServerMetadata> {
  const url = `${origin.replace(/\/+$/, '')}/.well-known/oauth-authorization-server`;
  const res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`OAuth discovery failed: ${res.status} from ${url}`);
  }
  const meta = (await res.json()) as Partial<AuthServerMetadata>;
  if (!meta.authorization_endpoint || !meta.token_endpoint || !meta.registration_endpoint || !meta.issuer) {
    throw new Error(`OAuth discovery returned incomplete metadata from ${url}`);
  }
  return meta as AuthServerMetadata;
}

/** Register a public client for the loopback redirect. Returns the client_id. */
export async function registerLoopbackClient(
  registrationEndpoint: string,
  redirectUri: string,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const res = await fetchImpl(registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: `orboto-mcp stdio proxy ${VERSION}`,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OAuth client registration failed: ${res.status} ${body}`);
  }
  const json = (await res.json()) as { client_id?: string };
  if (!json.client_id) throw new Error('OAuth client registration returned no client_id');
  return json.client_id;
}

export function buildAuthorizeUrl(
  authorizationEndpoint: string,
  params: { clientId: string; redirectUri: string; challenge: string; state: string; scope: string },
): string {
  const u = new URL(authorizationEndpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', params.clientId);
  u.searchParams.set('redirect_uri', params.redirectUri);
  u.searchParams.set('scope', params.scope);
  u.searchParams.set('code_challenge', params.challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', params.state);
  return u.toString();
}

function parseTokenResponse(json: unknown, now: () => number = Date.now): OAuthTokenSet {
  const t = json as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!t.access_token) throw new Error('OAuth token response missing access_token');
  const expiresInMs = (typeof t.expires_in === 'number' ? t.expires_in : 3600) * 1000;
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? null,
    expiresAt: now() + expiresInMs,
    scope: t.scope ?? BOOTSTRAP_SCOPE,
  };
}

export async function exchangeAuthCode(
  tokenEndpoint: string,
  params: { clientId: string; code: string; redirectUri: string; verifier: string },
  fetchImpl: FetchLike = fetch,
): Promise<OAuthTokenSet> {
  const res = await fetchImpl(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: params.redirectUri,
      client_id: params.clientId,
      code_verifier: params.verifier,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OAuth code exchange failed: ${res.status} ${body}`);
  }
  return parseTokenResponse(await res.json());
}

export async function refreshTokens(
  tokenEndpoint: string,
  params: { clientId: string; refreshToken: string },
  fetchImpl: FetchLike = fetch,
  now: () => number = Date.now,
): Promise<OAuthTokenSet> {
  const res = await fetchImpl(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: params.refreshToken,
      client_id: params.clientId,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OAuth token refresh failed: ${res.status} ${body}`);
  }
  return parseTokenResponse(await res.json(), now);
}

/** Cache file path. Honours ORBOTO_MCP_TOKEN_CACHE for tests / custom homes. */
export function tokenCachePath(): string {
  const override = process.env.ORBOTO_MCP_TOKEN_CACHE;
  if (override) return override;
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'orboto', 'mcp-oauth.json');
}

type CacheFile = Record<string, CachedGrant>;

function readCacheFile(path: string): CacheFile {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CacheFile;
  } catch {
    return {};
  }
}

export function loadCachedGrant(origin: string, path = tokenCachePath()): CachedGrant | null {
  const file = readCacheFile(path);
  return file[origin] ?? null;
}

function writeCacheFile(path: string, file: CacheFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* best-effort on platforms without chmod */ }
  renameSync(tmp, path);
}

export function saveCachedGrant(origin: string, grant: CachedGrant, path = tokenCachePath()): void {
  const file = readCacheFile(path);
  file[origin] = grant;
  writeCacheFile(path, file);
}

export function clearCachedGrant(origin: string, path = tokenCachePath()): void {
  const file = readCacheFile(path);
  if (!(origin in file)) return;
  delete file[origin];
  writeCacheFile(path, file);
}

export const CACHE_LOCK_STALE_MS = 60_000;
export const CACHE_LOCK_TIMEOUT_MS = 75_000;

/** Runs `fn` while holding `<cache>.lock`, so processes sharing one cache never present the same refresh token twice. */
export async function withCacheLock<T>(
  path: string,
  fn: () => Promise<T>,
  opts: { timeoutMs?: number; staleMs?: number } = {},
): Promise<T> {
  const lockPath = `${path}.lock`;
  const staleMs = opts.staleMs ?? CACHE_LOCK_STALE_MS;
  const deadline = Date.now() + (opts.timeoutMs ?? CACHE_LOCK_TIMEOUT_MS);
  mkdirSync(dirname(path), { recursive: true });
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      try { writeSync(fd, String(process.pid)); } finally { closeSync(fd); }
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > staleMs) { unlinkSync(lockPath); continue; }
      } catch { continue; }
      if (Date.now() > deadline) throw new Error('Another orboto-mcp process holds the OAuth cache lock.');
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  try {
    return await fn();
  } finally {
    try { unlinkSync(lockPath); } catch { /* already reclaimed as stale */ }
  }
}

/**
 * A live token source. `getAccessToken()` returns a valid bearer, refreshing
 * transparently when the cached access token is within EXPIRY_SKEW_MS of
 * expiry. `forceRefresh()` is called by the client on an unexpected 401 (e.g.
 * an admin revoked the grant mid-session or the api rotated its signing key).
 */
export interface OAuthTokenProvider {
  getAccessToken(): Promise<string>;
  forceRefresh(): Promise<string>;
}

/** Shared persistence a provider re-reads under the lock before every refresh. */
export interface TokenStore {
  withLock<T>(fn: () => Promise<T>): Promise<T>;
  read(): OAuthTokenSet | null;
}

/**
 * Build a token provider around an initial token set + a refresh closure.
 * With a store, a refresh first adopts a newer token set another process
 * persisted and rotates only when no live access token is on disk.
 */
export function createTokenProvider(
  initial: OAuthTokenSet,
  refresh: (refreshToken: string) => Promise<OAuthTokenSet>,
  onRefreshed?: (next: OAuthTokenSet) => void,
  now: () => number = Date.now,
  store?: TokenStore,
): OAuthTokenProvider {
  let current = initial;
  let inflight: Promise<string> | null = null;

  const live = (t: OAuthTokenSet) => now() < t.expiresAt - EXPIRY_SKEW_MS;

  async function rotate(forced: boolean): Promise<string> {
    const seen = current.accessToken;
    const stored = store?.read();
    if (stored && stored.refreshToken && stored.refreshToken !== current.refreshToken) {
      current = stored;
      if (live(stored) && (!forced || stored.accessToken !== seen)) return current.accessToken;
    }
    if (!current.refreshToken) {
      throw new Error('OAuth session expired and no refresh token is available - reconnect the client.');
    }
    const next = await refresh(current.refreshToken);
    current = { ...next, refreshToken: next.refreshToken ?? current.refreshToken };
    onRefreshed?.(current);
    return current.accessToken;
  }

  function doRefresh(forced: boolean): Promise<string> {
    return store ? store.withLock(() => rotate(forced)) : rotate(forced);
  }

  return {
    async getAccessToken() {
      if (live(current)) return current.accessToken;
      if (!inflight) inflight = doRefresh(false).finally(() => { inflight = null; });
      return inflight;
    },
    async forceRefresh() {
      if (!inflight) inflight = doRefresh(true).finally(() => { inflight = null; });
      return inflight;
    },
  };
}

/** Open a URL in the user's default browser. Returns false if no opener is
 *  available (headless) so the caller can print the URL for manual paste. */
/** The opener command for a platform; never a shell, so the URL is one argv entry (Windows uses the URL protocol handler like the Go CLI). */
function browserOpenerCommand(platform: NodeJS.Platform, url: string): { cmd: string; args: string[] } {
  if (platform === 'darwin') return { cmd: 'open', args: [url] };
  if (platform === 'win32') return { cmd: 'rundll32', args: ['url.dll,FileProtocolHandler', url] };
  return { cmd: 'xdg-open', args: [url] };
}

export async function openInBrowser(url: string): Promise<boolean> {
  if (process.env.ORBOTO_MCP_NO_BROWSER === '1') return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  const { cmd, args } = browserOpenerCommand(process.platform, parsed.href);
  try {
    const { spawn } = await import('node:child_process');
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Run the full browser-assisted loopback authorization once: spin an ephemeral
 * loopback listener, open the consent URL, wait for the redirect carrying the
 * code, exchange it. Returns the fresh token set + the client_id used (so the
 * caller can persist the grant). Logs go to stderr (stdout is the JSON-RPC
 * channel in stdio mode).
 */
export async function runLoopbackAuthorization(opts: {
  meta: AuthServerMetadata;
  scope?: string;
  log?: (msg: string) => void;
  openBrowser?: (url: string) => Promise<boolean>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<{ tokens: OAuthTokenSet; clientId: string }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.log ?? ((m) => process.stderr.write(`${m}\n`));
  const open = opts.openBrowser ?? openInBrowser;
  const scope = opts.scope ?? BOOTSTRAP_SCOPE;
  const pkce = generatePkce();
  const state = generateState();

  return await new Promise<{ tokens: OAuthTokenSet; clientId: string }>((resolve, reject) => {
    const server = createServer();
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      server.close();
      reject(new Error('OAuth authorization timed out waiting for the browser redirect.'));
    }, opts.timeoutMs ?? 5 * 60_000);

    server.on('request', async (req, res) => {
      try {
        const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (reqUrl.pathname !== '/callback') {
          res.writeHead(404).end('Not found');
          return;
        }
        const code = reqUrl.searchParams.get('code');
        const returnedState = reqUrl.searchParams.get('state');
        const err = reqUrl.searchParams.get('error');
        if (err) throw new Error(`Authorization denied: ${err}`);
        if (!code) throw new Error('Authorization callback missing code');
        if (returnedState !== state) throw new Error('Authorization state mismatch (possible CSRF)');

        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        const redirectUri = `http://127.0.0.1:${port}/callback`;
        const clientId = (server as unknown as { _orbotoClientId: string })._orbotoClientId;
        const tokens = await exchangeAuthCode(
          opts.meta.token_endpoint,
          { clientId, code, redirectUri, verifier: pkce.verifier },
          fetchImpl,
        );
        res.writeHead(200, { 'Content-Type': 'text/html' }).end(
          '<!doctype html><meta charset="utf-8"><title>orboto</title>' +
          '<body style="font-family:system-ui;padding:3rem;text-align:center">' +
          '<h2>Connected to orboto</h2><p>You can close this tab and return to your AI client.</p></body>',
        );
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          server.close();
          resolve({ tokens, clientId });
        }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'text/plain' }).end((e as Error).message);
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          server.close();
          reject(e as Error);
        }
      }
    });

    server.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(e);
    });

    server.listen(0, '127.0.0.1', async () => {
      try {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        const redirectUri = `http://127.0.0.1:${port}/callback`;
        const clientId = await registerLoopbackClient(opts.meta.registration_endpoint, redirectUri, fetchImpl);
        (server as unknown as { _orbotoClientId: string })._orbotoClientId = clientId;
        const authorizeUrl = buildAuthorizeUrl(opts.meta.authorization_endpoint, {
          clientId, redirectUri, challenge: pkce.challenge, state, scope,
        });
        const opened = await open(authorizeUrl);
        if (opened) {
          log(`[orboto-mcp] opened your browser to authorize. If it did not open, visit:\n${authorizeUrl}`);
        } else {
          log(`[orboto-mcp] open this URL in a browser to authorize:\n${authorizeUrl}`);
        }
      } catch (e) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        server.close();
        reject(e as Error);
      }
    });
  });
}

/**
 * Resolve an OAuth token provider for the stdio proxy. Order:
 *   1. A cached grant with a live access token -> used as is, nothing rotates.
 *   2. A cached grant whose refresh token still works -> silent refresh under the cache lock.
 *   3. Otherwise run the interactive browser-assisted loopback flow once.
 * The returned provider re-reads the cache under the lock before every refresh.
 */
export async function bootstrapOAuth(opts: {
  apiBaseUrl: string;
  log?: (msg: string) => void;
  fetchImpl?: FetchLike;
  openBrowser?: (url: string) => Promise<boolean>;
  cachePath?: string;
  now?: () => number;
}): Promise<OAuthTokenProvider> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.log ?? ((m) => process.stderr.write(`${m}\n`));
  const origin = deriveOrigin(opts.apiBaseUrl);
  const cachePath = opts.cachePath ?? tokenCachePath();
  const now = opts.now ?? Date.now;

  const providerFor = (clientId: string, tokenEndpoint: string, initial: OAuthTokenSet) => {
    const store: TokenStore = {
      withLock: (fn) => withCacheLock(cachePath, fn),
      read: () => {
        const g = loadCachedGrant(origin, cachePath);
        if (!g || g.clientId !== clientId) return null;
        return { accessToken: g.accessToken ?? '', refreshToken: g.refreshToken, expiresAt: g.expiresAt ?? 0, scope: g.scope };
      },
    };
    const persist = (tokens: OAuthTokenSet) => {
      if (!tokens.refreshToken) return;
      saveCachedGrant(origin, {
        clientId, tokenEndpoint, refreshToken: tokens.refreshToken, scope: tokens.scope,
        accessToken: tokens.accessToken, expiresAt: tokens.expiresAt,
      }, cachePath);
    };
    return createTokenProvider(
      initial,
      (rt) => refreshTokens(tokenEndpoint, { clientId, refreshToken: rt }, fetchImpl, now),
      persist,
      now,
      store,
    );
  };

  const cached = loadCachedGrant(origin, cachePath);
  if (cached) {
    const provider = providerFor(cached.clientId, cached.tokenEndpoint, {
      accessToken: cached.accessToken ?? '', refreshToken: cached.refreshToken,
      expiresAt: cached.expiresAt ?? 0, scope: cached.scope,
    });
    try {
      await provider.getAccessToken();
      log('[orboto-mcp] reconnected via cached OAuth session (no browser needed)');
      return provider;
    } catch (e) {
      log(`[orboto-mcp] cached OAuth session no longer valid (${(e as Error).message}); re-authorizing`);
      await withCacheLock(cachePath, async () => {
        const onDisk = loadCachedGrant(origin, cachePath);
        const renewedElsewhere = onDisk?.accessToken && (onDisk.expiresAt ?? 0) - EXPIRY_SKEW_MS > now();
        if (onDisk && !renewedElsewhere) clearCachedGrant(origin, cachePath);
      });
    }
  }

  const meta = await discoverAuthServer(origin, fetchImpl);
  const { tokens, clientId } = await runLoopbackAuthorization({
    meta, log, openBrowser: opts.openBrowser, fetchImpl,
  });
  if (tokens.refreshToken) {
    await withCacheLock(cachePath, async () => {
      saveCachedGrant(origin, {
        clientId, tokenEndpoint: meta.token_endpoint, refreshToken: tokens.refreshToken as string, scope: tokens.scope,
        accessToken: tokens.accessToken, expiresAt: tokens.expiresAt,
      }, cachePath);
    });
  }
  log('[orboto-mcp] OAuth authorization complete');
  return providerFor(clientId, meta.token_endpoint, tokens);
}

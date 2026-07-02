/**
 * ORB-943 - OAuth bootstrap for the stdio local-proxy.
 *
 * The stdio proxy (`@orboto/mcp` spawned by Claude Desktop / Cursor) was
 * PAT-only: the operator had to paste a long-lived `orb_*` key into the
 * client config. This module gives the stdio proxy the SAME short-lived,
 * SSO-backed OAuth path the HTTP transport already offers - a browser-assisted
 * loopback flow (RFC 8252) so a desktop user connects without ever pasting a
 * token. The PAT stays the documented fallback for headless service accounts
 * (see index.ts).
 *
 * Design:
 *   - No new API surface. This reuses the shipped provider-side OAuth stack
 *     (discovery + DCR + PKCE + rotating refresh) exactly as an HTTP MCP client
 *     would: discover -> register -> authorize-in-browser -> exchange -> use
 *     the access token as the REST Bearer (the api's `authenticate` decorator
 *     already accepts OAuth access tokens alongside `orb_*` keys).
 *   - The refresh token is cached on disk (0600) keyed by the instance origin,
 *     so a subsequent boot refreshes silently instead of re-opening a browser.
 *   - The pure pieces (PKCE, request building, response parsing, the cache
 *     round-trip, the token-provider refresh math) are exported so they unit
 *     test without a browser or a live server. The loopback listener + browser
 *     open is the thin I/O shell.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
}

type FetchLike = typeof fetch;

// ---------------------------------------------------------------------------
// PKCE (RFC 7636)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Origin derivation + discovery
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Dynamic Client Registration (RFC 7591)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Authorize URL + token exchange
// ---------------------------------------------------------------------------

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

function parseTokenResponse(json: unknown): OAuthTokenSet {
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
    expiresAt: Date.now() + expiresInMs,
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
  return parseTokenResponse(await res.json());
}

// ---------------------------------------------------------------------------
// Token cache (0600, keyed by origin)
// ---------------------------------------------------------------------------

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

export function saveCachedGrant(origin: string, grant: CachedGrant, path = tokenCachePath()): void {
  const file = readCacheFile(path);
  file[origin] = grant;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(file, null, 2), { mode: 0o600 });
  // writeFileSync's mode only applies on create; force 0600 on an existing file
  // too so a cache written before this code shipped is tightened.
  try { chmodSync(path, 0o600); } catch { /* best-effort on platforms without chmod */ }
}

export function clearCachedGrant(origin: string, path = tokenCachePath()): void {
  const file = readCacheFile(path);
  if (!(origin in file)) return;
  delete file[origin];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(file, null, 2), { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Token provider - the object the OrbotoClient calls per request
// ---------------------------------------------------------------------------

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

/**
 * Build a token provider around an initial token set + a refresh closure.
 * Kept pure (no I/O of its own beyond the injected refresh fn) so the
 * refresh-on-expiry logic unit tests deterministically with a fake clock.
 */
export function createTokenProvider(
  initial: OAuthTokenSet,
  refresh: (refreshToken: string) => Promise<OAuthTokenSet>,
  onRefreshed?: (next: OAuthTokenSet) => void,
  now: () => number = Date.now,
): OAuthTokenProvider {
  let current = initial;
  let inflight: Promise<string> | null = null;

  async function doRefresh(): Promise<string> {
    if (!current.refreshToken) {
      throw new Error('OAuth session expired and no refresh token is available - reconnect the client.');
    }
    const next = await refresh(current.refreshToken);
    // The AS rotates the refresh token; if a response omits it (shouldn't with
    // offline_access) keep the prior one so the chain isn't lost.
    current = { ...next, refreshToken: next.refreshToken ?? current.refreshToken };
    onRefreshed?.(current);
    return current.accessToken;
  }

  return {
    async getAccessToken() {
      if (now() < current.expiresAt - EXPIRY_SKEW_MS) return current.accessToken;
      if (!inflight) inflight = doRefresh().finally(() => { inflight = null; });
      return inflight;
    },
    async forceRefresh() {
      if (!inflight) inflight = doRefresh().finally(() => { inflight = null; });
      return inflight;
    },
  };
}

// ---------------------------------------------------------------------------
// Interactive loopback flow (the I/O shell)
// ---------------------------------------------------------------------------

/** Open a URL in the user's default browser. Returns false if no opener is
 *  available (headless) so the caller can print the URL for manual paste. */
export async function openInBrowser(url: string): Promise<boolean> {
  if (process.env.ORBOTO_MCP_NO_BROWSER === '1') return false;
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '""', url] : [url];
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

    // Bind to an ephemeral loopback port, THEN register the client at that exact
    // redirect_uri (the api allows any loopback port at authorize time per RFC
    // 8252, but DCR still needs a concrete uri).
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

// ---------------------------------------------------------------------------
// Top-level bootstrap: cache -> refresh -> interactive, returns a provider
// ---------------------------------------------------------------------------

/**
 * Resolve an OAuth token provider for the stdio proxy. Order:
 *   1. A cached grant whose refresh token still works -> silent refresh.
 *   2. Otherwise run the interactive browser-assisted loopback flow once.
 * Either way the resulting grant is persisted (0600) so the next boot is
 * silent. The returned provider auto-refreshes and re-persists on rotation.
 */
export async function bootstrapOAuth(opts: {
  apiBaseUrl: string;
  log?: (msg: string) => void;
  fetchImpl?: FetchLike;
  openBrowser?: (url: string) => Promise<boolean>;
  cachePath?: string;
}): Promise<OAuthTokenProvider> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.log ?? ((m) => process.stderr.write(`${m}\n`));
  const origin = deriveOrigin(opts.apiBaseUrl);
  const cachePath = opts.cachePath ?? tokenCachePath();

  const persist = (clientId: string, tokenEndpoint: string, tokens: OAuthTokenSet) => {
    if (tokens.refreshToken) {
      saveCachedGrant(origin, {
        clientId, tokenEndpoint, refreshToken: tokens.refreshToken, scope: tokens.scope,
      }, cachePath);
    }
  };

  const cached = loadCachedGrant(origin, cachePath);
  if (cached) {
    try {
      const tokens = await refreshTokens(cached.tokenEndpoint, {
        clientId: cached.clientId, refreshToken: cached.refreshToken,
      }, fetchImpl);
      persist(cached.clientId, cached.tokenEndpoint, tokens);
      log('[orboto-mcp] reconnected via cached OAuth session (no browser needed)');
      return createTokenProvider(
        tokens,
        (rt) => refreshTokens(cached.tokenEndpoint, { clientId: cached.clientId, refreshToken: rt }, fetchImpl),
        (next) => persist(cached.clientId, cached.tokenEndpoint, next),
      );
    } catch (e) {
      // A revoked / expired refresh token drops us back to interactive.
      log(`[orboto-mcp] cached OAuth session no longer valid (${(e as Error).message}); re-authorizing`);
      clearCachedGrant(origin, cachePath);
    }
  }

  const meta = await discoverAuthServer(origin, fetchImpl);
  const { tokens, clientId } = await runLoopbackAuthorization({
    meta, log, openBrowser: opts.openBrowser, fetchImpl,
  });
  persist(clientId, meta.token_endpoint, tokens);
  log('[orboto-mcp] OAuth authorization complete');
  return createTokenProvider(
    tokens,
    (rt) => refreshTokens(meta.token_endpoint, { clientId, refreshToken: rt }, fetchImpl),
    (next) => persist(clientId, meta.token_endpoint, next),
  );
}

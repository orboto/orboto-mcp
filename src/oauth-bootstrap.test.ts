/**
 * ORB-943 - unit tests for the stdio OAuth bootstrap core. No browser, no
 * network, no DB: a fake fetch drives discovery/register/exchange/refresh, and
 * a temp file backs the cache. The interactive loopback shell is exercised via
 * its testable pieces (PKCE, authorize-url, request builders).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  generatePkce,
  buildAuthorizeUrl,
  deriveOrigin,
  discoverAuthServer,
  registerLoopbackClient,
  exchangeAuthCode,
  refreshTokens,
  loadCachedGrant,
  saveCachedGrant,
  clearCachedGrant,
  createTokenProvider,
  bootstrapOAuth,
  EXPIRY_SKEW_MS,
  type OAuthTokenSet,
} from './oauth-bootstrap.js';

describe('PKCE', () => {
  it('produces an S256 challenge that verifies against the verifier', () => {
    const { verifier, challenge, method } = generatePkce();
    expect(method).toBe('S256');
    const recomputed = createHash('sha256').update(verifier).digest('base64url');
    expect(recomputed).toBe(challenge);
    // base64url, no padding
    expect(challenge).not.toContain('=');
    expect(challenge).not.toContain('+');
  });
});

describe('deriveOrigin', () => {
  it('strips a trailing /api (single-host reverse-proxy layout)', () => {
    expect(deriveOrigin('https://orboto.example.com/api')).toBe('https://orboto.example.com');
    expect(deriveOrigin('https://orboto.example.com/api/')).toBe('https://orboto.example.com');
  });
  it('leaves a bare origin unchanged', () => {
    expect(deriveOrigin('http://localhost:3000')).toBe('http://localhost:3000');
  });
});

describe('buildAuthorizeUrl', () => {
  it('encodes all PKCE + client params', () => {
    const url = new URL(buildAuthorizeUrl('https://x.test/oauth/authorize', {
      clientId: 'cid', redirectUri: 'http://127.0.0.1:5555/callback', challenge: 'chal', state: 'st', scope: 'mcp offline_access',
    }));
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:5555/callback');
    expect(url.searchParams.get('code_challenge')).toBe('chal');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('st');
    expect(url.searchParams.get('scope')).toBe('mcp offline_access');
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('discovery / register / exchange / refresh', () => {
  it('discoverAuthServer validates completeness', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      issuer: 'https://x.test',
      authorization_endpoint: 'https://x.test/oauth/authorize',
      token_endpoint: 'https://x.test/oauth/token',
      registration_endpoint: 'https://x.test/oauth/register',
    })) as unknown as typeof fetch;
    const meta = await discoverAuthServer('https://x.test', fetchImpl);
    expect(meta.token_endpoint).toBe('https://x.test/oauth/token');
  });

  it('discoverAuthServer throws on incomplete metadata', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ issuer: 'https://x.test' })) as unknown as typeof fetch;
    await expect(discoverAuthServer('https://x.test', fetchImpl)).rejects.toThrow(/incomplete metadata/);
  });

  it('registerLoopbackClient returns the client_id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ client_id: 'abc123' }, 201)) as unknown as typeof fetch;
    const id = await registerLoopbackClient('https://x.test/oauth/register', 'http://127.0.0.1:1/callback', fetchImpl);
    expect(id).toBe('abc123');
  });

  it('exchangeAuthCode parses tokens + computes expiry', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'mcp offline_access',
    })) as unknown as typeof fetch;
    const before = Date.now();
    const tokens = await exchangeAuthCode('https://x.test/oauth/token', {
      clientId: 'cid', code: 'code', redirectUri: 'http://127.0.0.1:1/callback', verifier: 'v',
    }, fetchImpl);
    expect(tokens.accessToken).toBe('at');
    expect(tokens.refreshToken).toBe('rt');
    expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000);
  });

  it('refreshTokens surfaces a non-2xx as an error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{"error":"invalid_grant"}', { status: 400 })) as unknown as typeof fetch;
    await expect(refreshTokens('https://x.test/oauth/token', { clientId: 'cid', refreshToken: 'rt' }, fetchImpl))
      .rejects.toThrow(/refresh failed: 400/);
  });
});

describe('token cache', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orboto-oauth-'));
    path = join(dir, 'cache.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('round-trips a grant keyed by origin and writes 0600', () => {
    saveCachedGrant('https://a.test', { clientId: 'c', refreshToken: 'r', scope: 'mcp', tokenEndpoint: 'https://a.test/oauth/token' }, path);
    saveCachedGrant('https://b.test', { clientId: 'c2', refreshToken: 'r2', scope: 'mcp', tokenEndpoint: 'https://b.test/oauth/token' }, path);
    expect(loadCachedGrant('https://a.test', path)?.clientId).toBe('c');
    expect(loadCachedGrant('https://b.test', path)?.refreshToken).toBe('r2');
    expect(loadCachedGrant('https://missing.test', path)).toBeNull();
    // 0600 perms (owner rw only)
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('clearCachedGrant removes only the target origin', () => {
    saveCachedGrant('https://a.test', { clientId: 'c', refreshToken: 'r', scope: 'mcp', tokenEndpoint: 'e' }, path);
    saveCachedGrant('https://b.test', { clientId: 'c2', refreshToken: 'r2', scope: 'mcp', tokenEndpoint: 'e' }, path);
    clearCachedGrant('https://a.test', path);
    expect(loadCachedGrant('https://a.test', path)).toBeNull();
    expect(loadCachedGrant('https://b.test', path)).not.toBeNull();
    const file = JSON.parse(readFileSync(path, 'utf8'));
    expect(Object.keys(file)).toEqual(['https://b.test']);
  });
});

describe('createTokenProvider', () => {
  // expiresAt comfortably larger than EXPIRY_SKEW_MS so "fresh" and "within
  // skew" are both expressible with a fake clock.
  const base: OAuthTokenSet = { accessToken: 'at0', refreshToken: 'rt0', expiresAt: 10_000_000, scope: 'mcp' };

  it('returns the cached access token while fresh', async () => {
    const refresh = vi.fn();
    const now = () => 0; // well before expiry
    const p = createTokenProvider(base, refresh, undefined, now);
    expect(await p.getAccessToken()).toBe('at0');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes when within the expiry skew and rotates the refresh token', async () => {
    const refresh = vi.fn().mockResolvedValue({ accessToken: 'at1', refreshToken: 'rt1', expiresAt: 10_000_000, scope: 'mcp' });
    const onRefreshed = vi.fn();
    const now = () => base.expiresAt - EXPIRY_SKEW_MS + 1; // inside skew window
    const p = createTokenProvider(base, refresh, onRefreshed, now);
    expect(await p.getAccessToken()).toBe('at1');
    expect(refresh).toHaveBeenCalledWith('rt0');
    expect(onRefreshed).toHaveBeenCalledWith(expect.objectContaining({ refreshToken: 'rt1' }));
  });

  it('forceRefresh renews on demand (401 path)', async () => {
    const refresh = vi.fn().mockResolvedValue({ accessToken: 'at2', refreshToken: 'rt2', expiresAt: 10_000_000, scope: 'mcp' });
    const p = createTokenProvider(base, refresh, undefined, () => 0);
    expect(await p.forceRefresh()).toBe('at2');
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('preserves the prior refresh token if the AS omits a new one', async () => {
    const refresh = vi.fn().mockResolvedValue({ accessToken: 'at3', refreshToken: null, expiresAt: 10_000_000, scope: 'mcp' });
    const onRefreshed = vi.fn();
    const p = createTokenProvider(base, refresh, onRefreshed, () => base.expiresAt);
    await p.getAccessToken();
    expect(onRefreshed).toHaveBeenCalledWith(expect.objectContaining({ refreshToken: 'rt0' }));
  });

  it('throws a clear error when no refresh token is available', async () => {
    const noRefresh: OAuthTokenSet = { ...base, refreshToken: null };
    const p = createTokenProvider(noRefresh, vi.fn(), undefined, () => base.expiresAt);
    await expect(p.getAccessToken()).rejects.toThrow(/reconnect the client/);
  });

  it('ORB-1419 - single-flights concurrent getAccessToken calls into ONE refresh', async () => {
    // Two concurrent callers that both see an expired token must share a single
    // in-flight refresh rather than each firing one (which would present the OLD
    // refresh token twice and trip server-side reuse-detection).
    let resolveRefresh: (v: OAuthTokenSet) => void = () => {};
    const refresh = vi.fn().mockImplementation(
      () => new Promise<OAuthTokenSet>((r) => { resolveRefresh = r; }),
    );
    const p = createTokenProvider(base, refresh, undefined, () => base.expiresAt);

    const a = p.getAccessToken();
    const b = p.getAccessToken();
    // Both callers are now awaiting; only one refresh should have been started.
    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledWith('rt0');

    resolveRefresh({ accessToken: 'at-shared', refreshToken: 'rt1', expiresAt: 10_000_000, scope: 'mcp' });
    expect(await a).toBe('at-shared');
    expect(await b).toBe('at-shared');
    expect(refresh).toHaveBeenCalledOnce();
  });
});

describe('bootstrapOAuth cached-grant path', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orboto-oauth-'));
    path = join(dir, 'cache.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('refreshes silently from a cached grant without opening a browser', async () => {
    saveCachedGrant('https://x.test', {
      clientId: 'cid', refreshToken: 'rt0', scope: 'mcp offline_access', tokenEndpoint: 'https://x.test/oauth/token',
    }, path);
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      access_token: 'fresh-at', refresh_token: 'rt1', expires_in: 3600, scope: 'mcp offline_access',
    })) as unknown as typeof fetch;
    const openBrowser = vi.fn();
    const provider = await bootstrapOAuth({
      apiBaseUrl: 'https://x.test/api', fetchImpl, openBrowser, cachePath: path, log: () => {},
    });
    expect(await provider.getAccessToken()).toBe('fresh-at');
    expect(openBrowser).not.toHaveBeenCalled();
    // rotation persisted
    expect(loadCachedGrant('https://x.test', path)?.refreshToken).toBe('rt1');
  });

  it('clears a dead cached grant and falls through to discovery', async () => {
    saveCachedGrant('https://x.test', {
      clientId: 'cid', refreshToken: 'dead', scope: 'mcp', tokenEndpoint: 'https://x.test/oauth/token',
    }, path);
    // First call (refresh) 400s; then discovery is attempted (which we fail so
    // we don't need to drive the whole interactive flow) - the point is the
    // dead grant is cleared and discovery is reached.
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('{"error":"invalid_grant"}', { status: 400 })) // refresh
      .mockResolvedValueOnce(new Response('nope', { status: 500 })); // discovery
    await expect(bootstrapOAuth({
      apiBaseUrl: 'https://x.test/api', fetchImpl: fetchImpl as unknown as typeof fetch,
      openBrowser: vi.fn(), cachePath: path, log: () => {},
    })).rejects.toThrow(/discovery failed/);
    expect(loadCachedGrant('https://x.test', path)).toBeNull();
  });
});

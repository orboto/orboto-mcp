/**
 * ORB-244 Phase A — thin HTTP client the MCP server uses to talk to
 * the orboto API.
 *
 * Deliberately speaks HTTPS-REST rather than importing `@orboto/api`'s
 * services directly, for three reasons:
 *   1. One code path covers both delivery variants from the ticket —
 *      Local-Proxy (`npx @orboto/mcp-cli`, running on the dev's laptop,
 *      pointing at the public orboto URL) AND Self-Hosted-inline
 *      (separate container in docker-compose, pointing at
 *      `http://api:3000`). The only difference is the env var.
 *   2. The API's `requirePermission` / PBAC cascade runs server-side
 *      where it belongs. The MCP server is a pure transport adapter;
 *      it never sees the DB or trust boundary.
 *   3. The `orb_*` API-key flow is already wired into the API's
 *      `authenticate` decorator — reusing it means the existing
 *      `mcp:use` + `api:use` scope checks, rate limits, and audit
 *      logs all light up for free.
 *
 * Every request adds `Authorization: Bearer <apiKey>` (from env) and
 * a `User-Agent: orboto-mcp/<version>` header for the admin UI to
 * distinguish MCP traffic from regular API traffic. Non-2xx responses
 * throw `OrbotoApiError` so tool handlers can translate to MCP's
 * `{isError: true}` shape.
 */
import { VERSION } from './version.js';

/** ORB-943 - the two ways the stdio proxy authenticates. A static `orb_*` PAT
 *  (service-account fallback) OR a live OAuth token provider that mints
 *  short-lived access tokens and refreshes them transparently. */
export interface OAuthTokenProviderLike {
  getAccessToken(): Promise<string>;
  forceRefresh(): Promise<string>;
}

export interface OrbotoClientConfig {
  /** Base URL of the orboto API — e.g. `https://orboto.example.com` or
   *  `http://api:3000` when running inside docker-compose. No trailing
   *  slash; we'll strip one if the operator pastes it. */
  baseUrl: string;
  /** API key minted in Profile → API Keys with the `mcp:use` scope.
   *  Format `orb_*`. Mutually exclusive with `tokenProvider`. */
  apiKey?: string;
  /** ORB-943 - OAuth token source for the stdio local-proxy OAuth bootstrap.
   *  When present, every request resolves a fresh bearer from it and a 401 is
   *  retried once after `forceRefresh()`. Mutually exclusive with `apiKey`. */
  tokenProvider?: OAuthTokenProviderLike;
  /** Optional user-agent suffix so admins can tell `claude-desktop`
   *  traffic apart from `cursor`. */
  userAgentSuffix?: string;
}

export class OrbotoApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly url: string,
  ) {
    super(`orboto API ${status}: ${body || '(empty body)'}`);
    this.name = 'OrbotoApiError';
  }
}

export class OrbotoClient {
  private readonly baseUrl: string;
  /** Headers common to every request EXCEPT Authorization, which is resolved
   *  per-request so an OAuth token provider can rotate the bearer. */
  private readonly baseHeaders: Record<string, string>;
  private readonly apiKey?: string;
  private readonly tokenProvider?: OAuthTokenProviderLike;

  constructor(config: OrbotoClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    if (!config.apiKey && !config.tokenProvider) {
      throw new Error('OrbotoClient requires either an apiKey or a tokenProvider');
    }
    this.apiKey = config.apiKey;
    this.tokenProvider = config.tokenProvider;
    // User-Agent shape: `orboto-mcp/<version> (claude-desktop)`. The
    // suffix is optional metadata so the admin's MCP-usage panel
    // (Phase F) can group calls per client family without needing a
    // new DB column.
    const ua = config.userAgentSuffix
      ? `orboto-mcp/${VERSION} (${config.userAgentSuffix})`
      : `orboto-mcp/${VERSION}`;
    this.baseHeaders = {
      'User-Agent': ua,
      Accept: 'application/json',
    };
  }

  private async bearer(forceRefresh = false): Promise<string> {
    if (this.tokenProvider) {
      return forceRefresh ? this.tokenProvider.forceRefresh() : this.tokenProvider.getAccessToken();
    }
    return this.apiKey as string;
  }

  private fullUrl(path: string): string {
    return `${this.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
  }

  /**
   * Auth-aware fetch. Injects the resolved bearer and, when an OAuth token
   * provider is in play, retries a single 401 after a forced refresh - so an
   * access token that expired (or was rotated by the api) is renewed inline
   * instead of surfacing a spurious auth error to the tool caller. Throws
   * `OrbotoApiError` on a non-2xx (after the retry). Returns the raw Response
   * so callers parse json/text/binary as they need.
   */
  private async authedFetch(
    url: string,
    init: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> },
    accept?: string,
  ): Promise<Response> {
    const doFetch = async (token: string): Promise<Response> => {
      const headers: Record<string, string> = {
        ...this.baseHeaders,
        ...(accept ? { Accept: accept } : {}),
        ...(init.headers ?? {}),
        Authorization: `Bearer ${token}`,
      };
      return fetch(url, { ...init, headers });
    };
    let res = await doFetch(await this.bearer());
    if (res.status === 401 && this.tokenProvider) {
      res = await doFetch(await this.bearer(true));
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new OrbotoApiError(res.status, body, url);
    }
    return res;
  }

  /** GET a JSON endpoint. Throws `OrbotoApiError` on non-2xx. */
  async get<T>(path: string): Promise<T> {
    const res = await this.authedFetch(this.fullUrl(path), { method: 'GET' });
    return (await res.json()) as T;
  }

  /** POST a JSON body. */
  async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.authedFetch(this.fullUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** PATCH a JSON body. */
  async patch<T>(path: string, body: unknown): Promise<T> {
    const res = await this.authedFetch(this.fullUrl(path), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await res.json()) as T;
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    const res = await this.authedFetch(this.fullUrl(path), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await res.json()) as T;
  }

  /** DELETE. Returns the parsed body when the route sends one (some
   *  DELETEs 204, others return the mutated row - ORB-626 cancel does).
   *
   *  ORB-1610 - `body` is optional and, when present (including `{}`),
   *  is sent as a real JSON body with `Content-Type: application/json`.
   *  A genuinely bodyless DELETE against a route whose schema declares
   *  `body: SomeSchema.optional()` 400s on Fastify's content-type
   *  parser (verified against `DELETE /work-sessions/:id/claims`) - a
   *  caller that means "release everything" must send `{}`, not omit
   *  the body entirely. */
  async delete<T = void>(path: string, body?: unknown): Promise<T> {
    const res = await this.authedFetch(this.fullUrl(path), {
      method: 'DELETE',
      ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /**
   * POST a `multipart/form-data` payload — used by ingest-file +
   * attachment upload tools (ORB-799). The fetch API picks the boundary
   * automatically when we let it set `Content-Type`, so we deliberately
   * do NOT set `Content-Type: application/json` from the JSON helpers.
   */
  async postMultipart<T>(path: string, form: FormData): Promise<T> {
    const res = await this.authedFetch(this.fullUrl(path), {
      method: 'POST',
      body: form, // no Content-Type — fetch sets the boundary
    });
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /**
   * GET an endpoint that returns plain text (Markdown export, CSV
   * downloads, etc.) — bypasses the `Accept: application/json` header
   * + the JSON-only parsing in `get()`. Returns the raw response body
   * as a string. (ORB-915.)
   */
  async getText(path: string): Promise<string> {
    const res = await this.authedFetch(this.fullUrl(path), { method: 'GET' }, '*/*');
    return await res.text();
  }

  /**
   * POST an endpoint that returns a binary body (PDF export, ZIP
   * download, etc.). Returns the raw bytes as a Uint8Array — caller
   * decides whether to base64 it for an MCP resource attachment or
   * spill it to disk. (ORB-915.)
   */
  async postBinary(path: string, body?: unknown): Promise<{ bytes: Uint8Array; contentType: string }> {
    const res = await this.authedFetch(this.fullUrl(path), {
      method: 'POST',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }, '*/*');
    const ab = await res.arrayBuffer();
    return {
      bytes: new Uint8Array(ab),
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
    };
  }

  /**
   * GET an endpoint that returns a binary body (backup-run ZIP download,
   * etc.). Same shape as postBinary, GET method. (ORB-1301.)
   */
  async getBinary(path: string): Promise<{ bytes: Uint8Array; contentType: string }> {
    const res = await this.authedFetch(this.fullUrl(path), { method: 'GET' }, '*/*');
    const ab = await res.arrayBuffer();
    return {
      bytes: new Uint8Array(ab),
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
    };
  }
}

/**
 * Preflight a new MCP session: verify the workspace has MCP enabled,
 * the user holds the `mcp:use` permission, AND the user has not flipped
 * their own MCP opt-out (ORB-942). Called once per session (stdio boot /
 * HTTP initialize) and again on every rehydrate/adopt, so all three
 * gates share one enforcement point. Throws a descriptive `Error` on any
 * failure so the caller can translate to an MCP refuse-to-initialize
 * response.
 */
export async function preflightMcpSession(client: OrbotoClient): Promise<{
  userEmail: string;
}> {
  interface StatusResponse {
    enabled: boolean;
    mcpUseGranted: boolean;
    // ORB-942 — the caller's own users.mcp_enabled flag.
    userMcpEnabled: boolean;
    userEmail: string;
  }
  let status: StatusResponse;
  try {
    status = await client.get<StatusResponse>('/system/mcp/status');
  } catch (err) {
    if (err instanceof OrbotoApiError && err.status === 401) {
      throw new Error('MCP preflight failed: the provided API key is invalid or expired.');
    }
    throw err;
  }
  if (!status.enabled) {
    throw new Error('MCP preflight failed: the workspace administrator has disabled MCP access.');
  }
  if (!status.mcpUseGranted) {
    throw new Error(`MCP preflight failed: user ${status.userEmail} lacks the mcp:use permission. Ask an admin to grant it.`);
  }
  // ORB-942 — per-user opt-out. Distinct message pointing at the toggle so
  // the user knows this is their own setting, not an admin / permission block.
  if (!status.userMcpEnabled) {
    throw new Error('MCP preflight failed: you have disabled MCP access for your account. Re-enable it in Profile - Connect an AI Client.');
  }
  return { userEmail: status.userEmail };
}

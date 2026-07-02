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

export interface OrbotoClientConfig {
  /** Base URL of the orboto API — e.g. `https://orboto.example.com` or
   *  `http://api:3000` when running inside docker-compose. No trailing
   *  slash; we'll strip one if the operator pastes it. */
  baseUrl: string;
  /** API key minted in Profile → API Keys with the `mcp:use` scope.
   *  Format `orb_*`. */
  apiKey: string;
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
  private readonly headers: Record<string, string>;

  constructor(config: OrbotoClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    // User-Agent shape: `orboto-mcp/<version> (claude-desktop)`. The
    // suffix is optional metadata so the admin's MCP-usage panel
    // (Phase F) can group calls per client family without needing a
    // new DB column.
    const ua = config.userAgentSuffix
      ? `orboto-mcp/${VERSION} (${config.userAgentSuffix})`
      : `orboto-mcp/${VERSION}`;
    this.headers = {
      Authorization: `Bearer ${config.apiKey}`,
      'User-Agent': ua,
      Accept: 'application/json',
    };
  }

  /** GET a JSON endpoint. Throws `OrbotoApiError` on non-2xx. */
  async get<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
    const res = await fetch(url, { headers: this.headers });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new OrbotoApiError(res.status, body, url);
    }
    return (await res.json()) as T;
  }

  /** POST a JSON body. */
  async post<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...this.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new OrbotoApiError(res.status, body, url);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** PATCH a JSON body. */
  async patch<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { ...this.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new OrbotoApiError(res.status, body, url);
    }
    return (await res.json()) as T;
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: { ...this.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new OrbotoApiError(res.status, body, url);
    }
    return (await res.json()) as T;
  }

  /** DELETE. No response body expected on success. */
  async delete(path: string): Promise<void> {
    const url = `${this.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
    const res = await fetch(url, { method: 'DELETE', headers: this.headers });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new OrbotoApiError(res.status, body, url);
    }
  }

  /**
   * POST a `multipart/form-data` payload — used by ingest-file +
   * attachment upload tools (ORB-799). The fetch API picks the boundary
   * automatically when we let it set `Content-Type`, so we deliberately
   * do NOT spread `Content-Type: application/json` from the JSON helpers.
   */
  async postMultipart<T>(path: string, form: FormData): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: this.headers, // no Content-Type — fetch sets the boundary
      body: form,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new OrbotoApiError(res.status, body, url);
    }
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
    const url = `${this.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
    // Override Accept so the API doesn't think we want JSON.
    const headers = { ...this.headers, Accept: '*/*' };
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new OrbotoApiError(res.status, body, url);
    }
    return await res.text();
  }

  /**
   * POST an endpoint that returns a binary body (PDF export, ZIP
   * download, etc.). Returns the raw bytes as a Uint8Array — caller
   * decides whether to base64 it for an MCP resource attachment or
   * spill it to disk. (ORB-915.)
   */
  async postBinary(path: string, body?: unknown): Promise<{ bytes: Uint8Array; contentType: string }> {
    const url = `${this.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
    const headers: Record<string, string> = { ...this.headers, Accept: '*/*' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new OrbotoApiError(res.status, errBody, url);
    }
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
    const url = `${this.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
    const headers: Record<string, string> = { ...this.headers, Accept: '*/*' };
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new OrbotoApiError(res.status, errBody, url);
    }
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

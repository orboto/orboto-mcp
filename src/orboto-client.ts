/**
 * ORB-244 Phase A — thin HTTP client the MCP server uses to talk to
 * the Orboto API.
 *
 * Deliberately speaks HTTPS-REST rather than importing `@orboto/api`'s
 * services directly, for three reasons:
 *   1. One code path covers both delivery variants from the ticket —
 *      Local-Proxy (`npx @orboto/mcp-cli`, running on the dev's laptop,
 *      pointing at the public Orboto URL) AND Self-Hosted-inline
 *      (separate container in docker-compose, pointing at
 *      `http://api:3000`). The only difference is the env var.
 *   2. The API's `requirePermission` / PBAC cascade runs server-side
 *      where it belongs. The MCP server is a pure transport adapter;
 *      it never sees the DB or trust boundary.
 *   3. The `obo_*` API-key flow is already wired into the API's
 *      `authenticate` decorator — reusing it means the existing
 *      `mcp:use` + `api:use` scope checks, rate limits, and audit
 *      logs all light up for free.
 *
 * Every request adds `Authorization: Bearer <apiKey>` (from env) and
 * a `User-Agent: orbit-mcp/<version>` header for the admin UI to
 * distinguish MCP traffic from regular API traffic. Non-2xx responses
 * throw `OrbotoApiError` so tool handlers can translate to MCP's
 * `{isError: true}` shape.
 */

export interface OrbotoClientConfig {
  /** Base URL of the Orboto API — e.g. `https://orboto.example.com` or
   *  `http://api:3000` when running inside docker-compose. No trailing
   *  slash; we'll strip one if the operator pastes it. */
  baseUrl: string;
  /** API key minted in Profile → API Keys with the `mcp:use` scope.
   *  Format `obo_*`. */
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
    super(`Orboto API ${status}: ${body || '(empty body)'}`);
    this.name = 'OrbotoApiError';
  }
}

export class OrbotoClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(config: OrbotoClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    // User-Agent shape: `orbit-mcp/0.51.0 (claude-desktop)`. The
    // suffix is optional metadata so the admin's MCP-usage panel
    // (Phase F) can group calls per client family without needing a
    // new DB column.
    const ua = config.userAgentSuffix
      ? `orbit-mcp/0.51.0 (${config.userAgentSuffix})`
      : 'orbit-mcp/0.51.0';
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

  /** DELETE. No response body expected on success. */
  async delete(path: string): Promise<void> {
    const url = `${this.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
    const res = await fetch(url, { method: 'DELETE', headers: this.headers });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new OrbotoApiError(res.status, body, url);
    }
  }
}

/**
 * Preflight a new MCP session: verify the workspace has MCP enabled
 * AND the user holds the `mcp:use` permission. Called once per
 * session (stdio boot / HTTP initialize). Throws a descriptive
 * `Error` on any failure so the caller can translate to an MCP
 * refuse-to-initialize response.
 */
export async function preflightMcpSession(client: OrbotoClient): Promise<{
  userEmail: string;
}> {
  interface StatusResponse {
    enabled: boolean;
    mcpUseGranted: boolean;
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
  return { userEmail: status.userEmail };
}

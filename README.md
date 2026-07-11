# @orboto/mcp

Model Context Protocol server for [orboto](https://github.com/orboto/orboto) - a self-hosted ticket and project management platform. Connect Claude Desktop, Cursor, GitHub Copilot Chat, or any MCP-aware AI client and operate orboto as a structured set of tools.

131 tools cover tickets, projects, milestones, time tracking, documents, primer facts, alerts and absences. Every call respects the caller's permission set - what the API key behind the MCP session cannot do in the web UI, the MCP session cannot do either.

## Quickstart

There are two ways to authenticate the stdio proxy:

- **OAuth login (recommended for people).** Omit `ORBOTO_API_KEY`. On first use the proxy opens your browser to the orboto login (which is your SSO login when SSO is configured), you approve once, and it keeps a short-lived, self-refreshing session cached on disk. Nothing to paste, nothing long-lived.
- **API key (service accounts / CI).** Set `ORBOTO_API_KEY` to an `orb_…` key from **Profile → API keys → Generate**. Best for headless machines with no browser.

### Claude Desktop - OAuth login (no token)

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%/Claude/claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "orboto": {
      "command": "npx",
      "args": ["-y", "@orboto/mcp"],
      "env": {
        "ORBOTO_API_URL": "https://orboto.example.com/api"
      }
    }
  }
}
```

The first launch opens your browser to authorize. The refresh token is cached at `~/.config/orboto/mcp-oauth.json` (mode `0600`), so subsequent launches reconnect silently. On a headless host with no browser, the proxy prints the authorization URL to stderr for manual paste, or fall back to the API-key form below.

### Claude Desktop - API key (service accounts)

```json
{
  "mcpServers": {
    "orboto": {
      "command": "npx",
      "args": ["-y", "@orboto/mcp"],
      "env": {
        "ORBOTO_API_URL": "https://orboto.example.com/api",
        "ORBOTO_API_KEY": "orb_…"
      }
    }
  }
}
```

### Cursor / VS Code

Same shape under `.cursor/mcp.json` or `.vscode/mcp.json` in your workspace root (or the user-level equivalent).

### Verify

Ask the AI: **"List my orboto projects."** The model picks `orboto_list_projects`, the call goes through MCP → REST API → back, and your projects come back as a list. If you see "no projects matched" but you know you're a member of some, the auth is working - re-check who the API key belongs to in **Profile → API keys**.

## Self-Hosted-Inline mode (HTTP)

If your orboto host runs the bundled MCP container (default on the official `docker-compose.yml`), every client on your network can use it directly via Streamable HTTP - no `npx` and no per-laptop install:

```json
{
  "mcpServers": {
    "orboto": {
      "type": "streamable-http",
      "url": "https://orboto.example.com/mcp",
      "headers": {
        "Authorization": "Bearer orb_…"
      }
    }
  }
}
```

The `/mcp` path on the main host is proxied to the bundled MCP container - no separate subdomain or cert needed. Both modes (stdio via npm, HTTP via host) hit the same tool surface.

> **stdio-first CLIs (e.g. Codex):** prefer the stdio proxy (`npx @orboto/mcp`) over an HTTP+OAuth URL. Some CLIs handle the OAuth session refresh and session-expiry re-init poorly and can lose their tools after a while or after a server deploy; the stdio proxy avoids that churn. Claude Desktop, Cursor, and VS Code Copilot are known-good over HTTP+OAuth.

## Environment

| Variable | Required | Effect |
|---|---|---|
| `ORBOTO_API_URL` | yes | Base URL of the orboto REST API. Typically `https://<your-host>/api`. No trailing slash. |
| `ORBOTO_API_KEY` | no | API key starting with `orb_…`. When set, the proxy authenticates with it (service-account path). When omitted, the stdio proxy bootstraps via OAuth (browser login). |
| `ORBOTO_AUTH` | no | `pat` or `oauth`. Defaults to `pat` when `ORBOTO_API_KEY` is set, else `oauth`. Force `oauth` to run the browser login even with a key present. |
| `ORBOTO_MCP_TOKEN_CACHE` | no | Override the OAuth token cache path (default `~/.config/orboto/mcp-oauth.json`). |
| `ORBOTO_MCP_NO_BROWSER` | no | Set to `1` to print the authorization URL instead of auto-opening a browser (headless hosts). |
| `ORBOTO_MCP_TRANSPORT` | no | `stdio` (default) or `http`. Stdio is the right choice for `npx`-launched clients. |
| `ORBOTO_MCP_PORT` | no | Listen port when transport is `http`. Default `3100`. |
| `ORBOTO_MCP_CLIENT` | no | User-agent suffix that lands in the API audit log. Useful for filtering audit rows by client. |

## Version compatibility

Each `@orboto/mcp` release matches a specific orboto API version - the tag on this package is the same as the `v*` tag on the source orboto repository. Tool schemas evolve with the API, so:

- **Pin to your server's version** for reproducible setups: `npx @orboto/mcp@0.109.0` (or whichever your server is on).
- **`@latest`** if you always run your orboto host on the most recent release. On a mismatch (package newer than server), some newer tools may 404 at call time - but the older tools keep working.

The MCP server logs the server version it talks to on startup, so you'll see the alignment in your client's MCP logs.

## License

MIT. See [LICENSE.md](./LICENSE.md).

## Source + issues

This repository ([`orboto/orboto-mcp`](https://github.com/orboto/orboto-mcp)) is a public subtree-mirror of the `apps/mcp/` directory from the main orboto monorepo (private). Code changes land in the parent repo and are mirrored here on every tag push.

**File issues here**: <https://github.com/orboto/orboto-mcp/issues>. Bug reports, feature requests, and questions about `@orboto/mcp` belong on this repo - that's where triage happens. Pull requests against the mirror are closed since the code is read-only; please open a discussion on the issue instead and the fix lands in the parent repo.

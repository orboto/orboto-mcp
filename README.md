# @orboto/mcp

Model Context Protocol server for [Orboto](https://github.com/Orboto/orboto) — a self-hosted ticket and project management platform. Connect Claude Desktop, Cursor, GitHub Copilot Chat, or any MCP-aware AI client and operate Orboto as a structured set of tools.

64+ tools cover tickets, projects, milestones, time tracking, documents, primer facts, alerts and absences. Every call respects the caller's permission set — what the API key behind the MCP session cannot do in the web UI, the MCP session cannot do either.

## Quickstart

You need an API key from your Orboto instance: **Profile → API keys → Generate**. The key starts with `orb_…`.

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%/Claude/claude_desktop_config.json` (Windows):

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

Ask the AI: **"List my Orboto projects."** The model picks `orboto_list_projects`, the call goes through MCP → REST API → back, and your projects come back as a list. If you see "no projects matched" but you know you're a member of some, the auth is working — re-check who the API key belongs to in **Profile → API keys**.

## Self-Hosted-Inline mode (HTTP)

If your Orboto host runs the bundled MCP container (default on the official `docker-compose.yml`), every client on your network can use it directly via Streamable HTTP — no `npx` and no per-laptop install:

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

The `/mcp` path on the main host is proxied to the bundled MCP container — no separate subdomain or cert needed. Both modes (stdio via npm, HTTP via host) hit the same tool surface.

## Environment

| Variable | Required | Effect |
|---|---|---|
| `ORBOTO_API_URL` | yes | Base URL of the Orboto REST API. Typically `https://<your-host>/api`. No trailing slash. |
| `ORBOTO_API_KEY` | yes | API key starting with `orb_…` from your Orboto profile. |
| `ORBOTO_MCP_TRANSPORT` | no | `stdio` (default) or `http`. Stdio is the right choice for `npx`-launched clients. |
| `ORBOTO_MCP_PORT` | no | Listen port when transport is `http`. Default `3100`. |
| `ORBOTO_MCP_CLIENT` | no | User-agent suffix that lands in the API audit log. Useful for filtering audit rows by client. |

## Version compatibility

Each `@orboto/mcp` release matches a specific Orboto API version — the tag on this package is the same as the `v*` tag on the source Orboto repository. Tool schemas evolve with the API, so:

- **Pin to your server's version** for reproducible setups: `npx @orboto/mcp@0.89.1` (or whichever your server is on).
- **`@latest`** if you always run your Orboto host on the most recent release. On a mismatch (package newer than server), some newer tools may 404 at call time — but the older tools keep working.

The MCP server logs the server version it talks to on startup, so you'll see the alignment in your client's MCP logs.

## License

MIT. See [LICENSE.md](./LICENSE.md).

## Source + issues

Source-of-truth is the [`apps/mcp/`](https://github.com/Orboto/orboto/tree/develop/apps/mcp) directory of the main [Orboto repository](https://github.com/Orboto/orboto). This package is a subtree-mirror that ships only the contents needed for an npm consumer.

File issues or feature requests on the main repository: <https://github.com/Orboto/orboto/issues>.

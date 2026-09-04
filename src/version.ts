/**
 * ORB-1166 - single source of truth for the MCP server version.
 *
 * Read from package.json (which release.mjs bumps) so serverInfo.version
 * + the User-Agent header always reflect the real release instead of a
 * hardcoded literal that drifts.
 *
 * WRAPPED IN try/catch on purpose: the Docker runtime image is stripped
 * to `dist/` + `node_modules/` and may not ship package.json at the path
 * `createRequire` resolves. A bare `require('../package.json')` at module
 * load threw there and crash-looped the MCP container (took prod down in
 * v0.110.1). The catch guarantees this module can NEVER crash the server
 * on boot; the Dockerfile now also copies package.json so the real
 * version resolves in-container.
 */
import { createRequire } from 'node:module';

function readVersion(): string {
  try {
    const pkg = createRequire(import.meta.url)('../package.json') as { version?: string };
    if (typeof pkg?.version === 'string' && pkg.version) return pkg.version;
  } catch {
    // package.json not present in this runtime - fall through to the default.
  }
  return '0.0.0';
}

export const VERSION: string = readVersion();

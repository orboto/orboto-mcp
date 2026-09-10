/**
 * ORB-1166 - single source of truth for the MCP server version.
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

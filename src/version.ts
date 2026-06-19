/**
 * ORB-1165 — single source of truth for the MCP server version.
 *
 * Read from package.json (which release.mjs bumps) so the value the
 * server advertises in `serverInfo.version` + the `User-Agent` header is
 * always the real release, instead of a hardcoded literal that drifts.
 * A stale literal (`0.51.0`) previously made the deployed server look ~60
 * versions behind during a debugging session — this prevents that.
 *
 * createRequire (not a static JSON import) keeps it NodeNext-safe and
 * resolves `../package.json` relative to the compiled `dist/version.js`.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export const VERSION: string = pkg.version;

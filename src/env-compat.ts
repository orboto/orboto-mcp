/**
 * ORB-584 — Orbit → Orboto env-var rename with one-major-release compat
 * shim. Mirrors the helper in apps/api/src/lib/env-compat.ts. Kept as
 * a separate file because MCP doesn't import api-side internals.
 *
 * Stderr is the warning sink because stdout is the JSON-RPC transport
 * in stdio mode.
 */

const warned = new Set<string>();

export function envOrLegacy(canonical: string, legacy: string): string | undefined {
  const newValue = process.env[canonical];
  if (newValue !== undefined) return newValue;
  const oldValue = process.env[legacy];
  if (oldValue !== undefined) {
    if (!warned.has(legacy)) {
      warned.add(legacy);
      process.stderr.write(
        `[orboto-mcp] ${legacy} is deprecated; use ${canonical} instead. The legacy name will be removed in v1.0.\n`,
      );
    }
    return oldValue;
  }
  return undefined;
}

export function requireEnvOrLegacy(canonical: string, legacy: string): string {
  const v = envOrLegacy(canonical, legacy);
  if (!v) {
    process.stderr.write(`[orboto-mcp] missing required env var: ${canonical} (or legacy ${legacy})\n`);
    process.exit(2);
  }
  return v;
}

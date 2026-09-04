/**
 * ORB-1173 - guard against version literals drifting from package.json.
 *
 * Version used to be hardcoded ('0.51.0') in three spots and release.mjs
 * never touched them, so serverInfo + the User-Agent lied about the real
 * release. Now everything reads VERSION (← package.json, ORB-1166). This
 * test fails CI if (a) VERSION stops matching package.json, or (b) someone
 * reintroduces a hardcoded semver string literal anywhere in src.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { VERSION } from './version.js';

const SRC = dirname(fileURLToPath(import.meta.url));
const pkg = createRequire(import.meta.url)('../package.json') as { version: string };

// version.ts legitimately holds the '0.0.0' runtime fallback literal.
const ALLOWED = new Set(['version.ts']);

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (/\.tsx?$/.test(entry) && !entry.endsWith('.test.ts') && !entry.endsWith('.test.tsx') && !ALLOWED.has(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

describe('ORB-1173 - version literal guard', () => {
  it('VERSION matches package.json (and is not the runtime fallback)', () => {
    expect(VERSION).toBe(pkg.version);
    expect(VERSION).not.toBe('0.0.0');
  });

  it('no hardcoded semver string literal in src (use VERSION instead)', () => {
    const offenders: string[] = [];
    // A quoted X.Y.Z literal - what a drifting hardcoded version looks
    // like. Comments (// v0.110.1) and ticket refs (ORB-1166) are not
    // quoted semver, so they don't trip this.
    const semverLiteral = /['"]\d+\.\d+\.\d+['"]/;
    for (const file of walk(SRC)) {
      const text = readFileSync(file, 'utf8');
      text.split('\n').forEach((line, i) => {
        if (semverLiteral.test(line)) offenders.push(`${file.replace(SRC, 'src')}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders, `Hardcoded version literal(s) found - read VERSION from version.ts instead:\n${offenders.join('\n')}`).toEqual([]);
  });
});

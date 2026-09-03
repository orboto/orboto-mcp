/**
 * ORB-1818 - `PROTECT_TEXT_META` is a protection, not an escape hatch.
 *
 * A handler that sets it keeps its text half out of the shrinker, so a
 * tool could use it to opt out of the central response budget - the one
 * thing ORB-1697 exists to prevent. It is sanctioned for exactly one
 * payload: the complete binding workspace rules, which must never be cut
 * for either client class (Claude Code keeps the structured half,
 * text-only clients keep the Markdown one).
 *
 * This ratchet fails the build when any other source file sets it, the
 * same way the dark-mode / i18n / audit checks fail on a new violation.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const SRC = fileURLToPath(new URL('.', import.meta.url));

/** The files allowed to SET the flag (response-budget.ts defines and
 *  consumes it; the session-start tool is the sanctioned setter). */
const ALLOWED = new Set(['response-budget.ts', 'tools/session-start.ts']);

function walk(dir: string, prefix = ''): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(full).isDirectory()) return entry === 'node_modules' ? [] : walk(full, rel);
    return rel.endsWith('.ts') ? [rel] : [];
  });
}

describe('PROTECT_TEXT_META usage (ORB-1818)', () => {
  it('is set by the session-start tool only', () => {
    const offenders = walk(SRC)
      .filter((rel) => !rel.endsWith('.test.ts') && !ALLOWED.has(rel))
      .filter((rel) => readFileSync(join(SRC, rel), 'utf8').includes('PROTECT_TEXT_META'));
    expect(offenders).toEqual([]);
  });
});

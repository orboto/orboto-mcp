import { expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = join(process.cwd(), 'src');

function* testFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* testFiles(full);
    else if (entry.name.endsWith('.test.ts') && entry.name !== 'child-window-test-timeout.test.ts') yield full;
  }
}

it('every mcp test using childWindow() sets its own ciWindow test timeout above it', () => {
  const offenders = [...testFiles(src)].filter((file) => {
    const text = readFileSync(file, 'utf8');
    return text.includes('childWindow()') && !/\}, ciWindow\(\d[\d_]*\)\);/.test(text);
  });
  expect(offenders).toEqual([]);
});

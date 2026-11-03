import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHARS_PER_TOKEN, DOC_SECTION_READ_TOKENS, formatApproxTokens, hitSizeNote, tokensForChars } from './token-size.js';

const read = (rel: string) => readFileSync(resolve(process.cwd(), '../..', rel), 'utf8');

/** The body of one exported function, from its signature to the closing brace at the start of a line. */
function body(source: string, name: string): string {
  const start = source.indexOf(`export function ${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  return source.slice(start, source.indexOf('\n}\n', start) + 2);
}

describe('ORB-2791 - the token estimator mirrors @orboto/shared-schema token-size.ts', () => {
  it('keeps the constants and the two functions character for character', () => {
    const shared = read('packages/shared-schema/src/token-size.ts');
    const mirror = read('apps/mcp/src/token-size.ts');
    expect(shared).toContain(`export const CHARS_PER_TOKEN = ${CHARS_PER_TOKEN};`);
    expect(shared).toContain(`export const DOC_SECTION_READ_TOKENS = ${DOC_SECTION_READ_TOKENS};`);
    for (const name of ['tokensForChars', 'formatApproxTokens']) expect(body(mirror, name)).toBe(body(shared, name));
  });

  it('is characters / 3.6 rounded half up, and prints the compact form', () => {
    expect([0, 9, 10, 3600, 3601].map(tokensForChars)).toEqual([0, 3, 3, 1000, 1000]);
    expect([0, 340, 999, 1000, 1049, 1050, 1234, 2001, 9949, 9950, 12_345].map(formatApproxTokens)).toEqual([
      '~0 tokens', '~340 tokens', '~999 tokens', '~1k tokens', '~1k tokens', '~1.1k tokens', '~1.2k tokens', '~2k tokens', '~9.9k tokens', '~10k tokens', '~12k tokens',
    ]);
  });

  it('names the size of a hit and, over 2k tokens, the section of its match', () => {
    expect(hitSizeNote(null, ['Deploy'])).toBe('');
    expect(hitSizeNote(undefined)).toBe('');
    expect(hitSizeNote(1200, ['Deploy'])).toBe(' (~1.2k tokens)');
    expect(hitSizeNote(4100, ['Deploy', 'Window'])).toBe(' (~4.1k tokens, section "Deploy > Window")');
    expect(hitSizeNote(4100, [])).toBe(' (~4.1k tokens)');
  });
});

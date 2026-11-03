/** ORB-2791 - the token estimator of the response budget and the hit sizes; mirror of packages/shared-schema/src/token-size.ts, which this package cannot import. */

/** Characters per token, the rough tokenizer stand-in the manifest ceilings and the stored doc sizes use. */
export const CHARS_PER_TOKEN = 3.6;

/** From this size on a hit names the section that reads only its match. */
export const DOC_SECTION_READ_TOKENS = 2000;

/** Tokens for a character count: characters / 3.6 rounded half up, in integer arithmetic. */
export function tokensForChars(chars: number): number {
  return Math.floor((Math.max(0, Math.trunc(chars)) * 10 + 18) / 36);
}

/** The compact size a text line prints: `~340 tokens`, `~1.2k tokens`, `~12k tokens`. */
export function formatApproxTokens(tokens: number): string {
  if (tokens < 1000) return `~${tokens} tokens`;
  if (tokens < 9950) return `~${(Math.round(tokens / 100) / 10).toString()}k tokens`;
  return `~${Math.round(tokens / 1000)}k tokens`;
}

/** The size note of a hit: its size and, for a page over 2k tokens, the section its match sits in; empty without a stored size. */
export function hitSizeNote(approxTokens: number | null | undefined, headingPath?: string[] | null): string {
  if (approxTokens === null || approxTokens === undefined) return '';
  const size = formatApproxTokens(approxTokens);
  return approxTokens > DOC_SECTION_READ_TOKENS && headingPath?.length ? ` (${size}, section "${headingPath.join(' > ')}")` : ` (${size})`;
}

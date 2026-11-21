/** ORB-3174 - one character a request field of one printable line never holds: control (Cc), format (Cf, the bidirectional controls among them), a lone surrogate (Cs), a line or paragraph separator (Zl, Zp); ZWNJ and ZWJ stay, since emoji, Persian and Devanagari need them. */
export const PRINTABLE_FORBIDDEN = /(?![\u200c\u200d])[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

const WHITESPACE = /[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]+/g;

/** ORB-3174 - the code points of a value, the unit every bound of a printable field counts. */
export function codePointLength(value: string): number {
  let n = 0;
  for (const _ of value) n += 1;
  return n;
}

/** ORB-3174 - true when the value is one line without a forbidden character. */
export function isPrintableLine(value: string): boolean {
  return !PRINTABLE_FORBIDDEN.test(value);
}

/** ORB-3174 - an embedding, override or isolate control (U+202A-202E, U+2066-2069), which reorders the text around it (Trojan Source). */
function isBidiControl(cp: number): boolean {
  return (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069);
}

/** ORB-3174 - a character a terminal acts on instead of showing: a C0 control but TAB, LF and CR, DEL, a C1 control (ESC and CSI among them), or a bidirectional embedding, override or isolate. */
function isShownAsEscape(cp: number): boolean {
  return (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) || (cp >= 0x7f && cp <= 0x9f) || isBidiControl(cp);
}

/** ORB-3174 - the visible form of a character the text does not pass through, such as `\u{001B}` for ESC. */
export function visibleEscape(cp: number): string {
  return `\\u{${cp.toString(16).toUpperCase().padStart(4, '0')}}`;
}

function isLoneSurrogate(cp: number): boolean {
  return cp >= 0xd800 && cp <= 0xdfff;
}

/** ORB-3174 - the first `max` code points, ending in `...` when the value was longer. */
function cutCodePoints(value: string, max: number): string {
  const points = Array.from(value);
  if (points.length <= max) return value;
  if (max <= 3) return points.slice(0, max).join('');
  return points.slice(0, max - 3).join('').trimEnd() + '...';
}

/**
 * ORB-3174 - a stored identity or metadata value as one printable line of at most `max` code points: a bidirectional
 * embedding, override or isolate shows as its escape (`\u{202E}`), a lone surrogate as U+FFFD, every other control,
 * format, separator or whitespace character as one space; nothing after a control is consumed.
 */
export function printableLine(value: string, max: number): string {
  let line = '';
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    if (isBidiControl(cp)) line += visibleEscape(cp);
    else if (isLoneSurrogate(cp)) line += '\ufffd';
    else line += PRINTABLE_FORBIDDEN.test(ch) ? ' ' : ch;
  }
  return cutCodePoints(line.replace(WHITESPACE, ' ').trim(), max);
}

/** ORB-3174 - how many characters printableText shows as an escape. */
export function shownCharacterCount(value: string): number {
  let n = 0;
  const points = Array.from(value);
  points.forEach((ch, i) => {
    const cp = ch.codePointAt(0)!;
    if (isShownAsEscape(cp) || (cp === 0x0d && points[i + 1] !== '\n')) n += 1;
  });
  return n;
}

/**
 * ORB-3174 - stored free text as printable text that loses nothing and hides nothing: every character a terminal
 * acts on (a C0 control but TAB and LF, DEL, a C1 control, a bidirectional embedding, override or isolate, and a CR
 * that does not end a line, which would let the rest overwrite it) shows as its escape such as `\u{001B}`, a lone
 * surrogate as U+FFFD, and everything else passes as it is, format characters such as SHY, ZWSP, LRM and emoji tags
 * included; no character after a control is consumed. With `maxLines` over zero, the lines past it become one
 * `... (N more lines)` line.
 */
export function printableText(value: string, maxLines = 0): string {
  let text = '';
  const points = Array.from(value);
  points.forEach((ch, i) => {
    const cp = ch.codePointAt(0)!;
    if (isShownAsEscape(cp) || (cp === 0x0d && points[i + 1] !== '\n')) text += visibleEscape(cp);
    else text += isLoneSurrogate(cp) ? '\ufffd' : ch;
  });
  if (maxLines <= 0) return text;
  const lines = text.split('\n');
  return lines.length <= maxLines ? text : [...lines.slice(0, maxLines), `... (${lines.length - maxLines} more lines)`].join('\n');
}

/**
 * ORB-3174 - JSON text whose string values reach a terminal or an agent without a character it acts on: each such
 * raw character becomes its JSON escape (`\u009b`), so the text still parses to the very same value.
 */
export function printableJsonText(json: string): string {
  let text = '';
  for (const ch of json) {
    const cp = ch.codePointAt(0)!;
    text += isShownAsEscape(cp) ? `\\u${cp.toString(16).padStart(4, '0')}` : ch;
  }
  return text;
}

/** ORB-3174 - JSON.stringify whose output is printable JSON text (printableJsonText). */
export function printableJson(value: unknown, space?: number): string {
  return printableJsonText(JSON.stringify(value, null, space) ?? '');
}

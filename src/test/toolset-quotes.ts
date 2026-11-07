export type QuotedToolset = 'channel' | 'minimal' | 'curated' | 'full';
export type QuoteKind = 'tools' | 'tokens' | 'chars';
export interface Quote { file: string; line: number; toolset: QuotedToolset; kind: QuoteKind; value: number }
export interface Measured { tools: number; tokens: number; chars: number }
export type Reader =
  | { kind: 'table'; toolsets: readonly QuotedToolset[] }
  | { kind: 'markers' }
  | { kind: 'go-map' };
export interface GuardedFile { file: string; reader: Reader; scope?: 'file' }

const ALL: readonly QuotedToolset[] = ['channel', 'minimal', 'curated', 'full'];
const TIERS: readonly QuotedToolset[] = ['minimal', 'curated', 'full'];

const MARKER = /<!-- toolset:(channel|minimal|curated|full):(tools|tokens|chars) -->([^<]*)<!-- \/toolset -->/g;
const MARKER_SYNTAX = /<!-- \/?toolset\b[^>]*-->/g;
const TABLE_ROW = /^\|\s*`(channel|minimal|curated|full)`[^|\n]*\|\s*(\d+)\s*\|([^|\n]*)\|/;
const UNMARKED: readonly RegExp[] = [
  /\b\d+[- ]tools?\b/g,
  /~\d+(?:\.\d+)?k\b/g,
  /\b\d+(?:\.\d+)?k (?:tokens|chars)\b/g,
  /\b\d+(?:\.\d+)?k (?:\((?:minimal|curated|full)\)|for `(?:minimal|curated|full)`)/g,
];
const MANIFEST_FILE_FIGURE = /\b\d{1,3},\d{3}\b|\b\d{4,6} (?:tokens|chars)\b/g;
const TOOLSET_CONTEXT = /`(?:channel|minimal|curated|full)`|\b(?:channel|minimal|curated|full) (?:toolset|manifest|tier|set|list)s?\b|\btoolsets?\b/i;

/** A quoted figure as the docs write it: `209`, `45,700`, `10.5k`, `~3k`. */
export function parseFigure(text: string): number {
  const match = /^~?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(k?)$/.exec(text.trim());
  if (!match) throw new Error(`not a quoted figure: ${text}`);
  return Math.round(Number(match[1].replace(/,/g, '')) * (match[2] ? 1000 : 1));
}

/** Token figures may drift 5 % from the measurement, or 50 tokens where the quote rounds a small figure to the hundred. */
export function tokenTolerance(measured: number): number {
  return Math.max(measured * 0.05, 50);
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let at = text.indexOf('\n'); at !== -1 && at < index; at = text.indexOf('\n', at + 1)) line += 1;
  return line;
}

/** The rows of a toolset table: a backticked toolset name, its tool count, then a cell with `~10.5k tokens` or `about 10,500`. */
export function tableQuotes(file: string, text: string): Quote[] {
  const quotes: Quote[] = [];
  text.split('\n').forEach((row, index) => {
    const match = TABLE_ROW.exec(row);
    if (!match) return;
    const toolset = match[1] as QuotedToolset;
    const line = index + 1;
    quotes.push({ file, line, toolset, kind: 'tools', value: Number(match[2]) });
    const tokens = /~(\d+(?:\.\d+)?k?) tokens/.exec(match[3]) ?? /about (\d{1,3}(?:,\d{3})*)/.exec(match[3]);
    if (tokens) quotes.push({ file, line, toolset, kind: 'tokens', value: parseFigure(tokens[1]) });
  });
  return quotes;
}

/** The `toolsetTokens` map literal of mcp_toolset.go. */
export function goMapQuotes(file: string, text: string): Quote[] {
  const block = /var toolsetTokens = map\[string\]int\{([^}]*)\}/.exec(text);
  if (!block) return [];
  const start = block.index + block[0].indexOf('{') + 1;
  return [...block[1].matchAll(/"(channel|minimal|curated|full)":\s*(\d+)/g)].map((entry) => ({
    file,
    line: lineOf(text, start + (entry.index ?? 0)),
    toolset: entry[1] as QuotedToolset,
    kind: 'tokens' as const,
    value: Number(entry[2]),
  }));
}

export interface MarkerReading { quotes: Quote[]; problems: string[] }

/** Every `<!-- toolset:full:tools -->209<!-- /toolset -->` of a file, and one problem per marker comment that does not parse. */
export function markerQuotes(file: string, text: string): MarkerReading {
  const quotes: Quote[] = [];
  const problems: string[] = [];
  const wellFormed = new Set<number>();
  for (const marker of text.matchAll(MARKER)) {
    const index = marker.index ?? 0;
    const line = lineOf(text, index);
    wellFormed.add(index);
    wellFormed.add(index + marker[0].lastIndexOf('<!-- /toolset -->'));
    try {
      quotes.push({ file, line, toolset: marker[1] as QuotedToolset, kind: marker[2] as QuoteKind, value: parseFigure(marker[3]) });
    } catch {
      problems.push(`${file}:${line}: marker value "${marker[3]}" is not a figure (write 209, 45,700, 10.5k or ~3k)`);
    }
  }
  for (const comment of text.matchAll(MARKER_SYNTAX)) {
    if (!wellFormed.has(comment.index ?? 0)) {
      problems.push(`${file}:${lineOf(text, comment.index ?? 0)}: malformed marker "${comment[0]}" (use <!-- toolset:full:tools -->209<!-- /toolset -->, kinds tools, tokens, chars)`);
    }
  }
  return { quotes, problems };
}

/** Figures that sit outside a marker and outside a table row the table reader consumes: in every paragraph that names a toolset, or in every line and with 1,234 style figures too when the whole file is about the manifests. */
export function unmarkedQuotes(text: string, tableFile: boolean, wholeFile = false): Array<{ line: number; text: string }> {
  const masked = text
    .replace(MARKER, (span) => span.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((row) => (tableFile && TABLE_ROW.test(row) ? '' : row));
  const found: Array<{ line: number; text: string }> = [];
  let block: number[] = [];
  const flush = () => {
    if (block.length && (wholeFile || TOOLSET_CONTEXT.test(block.map((index) => masked[index]).join('\n')))) {
      for (const index of block) {
        for (const pattern of wholeFile ? [...UNMARKED, MANIFEST_FILE_FIGURE] : UNMARKED) {
          for (const hit of masked[index].matchAll(pattern)) found.push({ line: index + 1, text: hit[0] });
        }
      }
    }
    block = [];
  };
  masked.forEach((row, index) => {
    if (row.trim() === '') flush();
    else block.push(index);
  });
  flush();
  return found;
}

export const GO_MAP_FILE = 'cli/internal/cmd/mcp_toolset.go';

export const GUARDED_FILES: readonly GuardedFile[] = [
  { file: 'docs/mcp-reference.md', reader: { kind: 'table', toolsets: ALL }, scope: 'file' },
  { file: 'docs/cli.md', reader: { kind: 'table', toolsets: ALL } },
  { file: 'skills/orboto/reference/generic.md', reader: { kind: 'table', toolsets: TIERS } },
  { file: 'integrations/claude-plugin/plugins/orboto/skills/orboto/reference/generic.md', reader: { kind: 'table', toolsets: TIERS } },
  { file: GO_MAP_FILE, reader: { kind: 'go-map' } },
  { file: 'apps/mcp/README.md', reader: { kind: 'markers' }, scope: 'file' },
  { file: 'integrations/claude-plugin/README.md', reader: { kind: 'markers' }, scope: 'file' },
  { file: 'docs/mcp-setup.md', reader: { kind: 'markers' }, scope: 'file' },
  { file: 'docs/mcp-clients.md', reader: { kind: 'markers' }, scope: 'file' },
  { file: 'docs/mcp-identity-and-mail.md', reader: { kind: 'markers' }, scope: 'file' },
  { file: 'docs/mcp-response-budget.md', reader: { kind: 'markers' } },
  { file: 'docs/connect-your-agent.md', reader: { kind: 'markers' }, scope: 'file' },
  { file: 'docs/agent-conventions.md', reader: { kind: 'markers' } },
  { file: 'docs/architecture-contracts.md', reader: { kind: 'markers' } },
  { file: 'docs/claude-code.md', reader: { kind: 'markers' } },
];

function compare(quote: Quote, measured: Measured): string | null {
  const where = `${quote.file}:${quote.line}`;
  if (quote.kind === 'tools') {
    return quote.value === measured.tools ? null : `${where}: quotes ${quote.value} tools for ${quote.toolset}, measured ${measured.tools}`;
  }
  const actual = quote.kind === 'tokens' ? measured.tokens : measured.chars;
  const allowed = quote.kind === 'tokens' ? tokenTolerance(actual) : actual * 0.05;
  if (Math.abs(quote.value - actual) <= allowed) return null;
  const unit = quote.kind === 'tokens' ? '~' : '';
  const noun = quote.kind === 'tokens' ? 'tokens' : 'characters';
  return `${where}: quotes ${unit}${quote.value} ${noun} for ${quote.toolset}, measured ${actual} (allowed drift ${Math.round(allowed)})`;
}

/** One message per quoted figure that is missing, unmarked, malformed or different from the measurement. */
export function driftProblems(files: readonly GuardedFile[], readFile: (file: string) => string, measured: Record<QuotedToolset, Measured>): string[] {
  const problems: string[] = [];
  for (const { file, reader, scope } of files) {
    const text = readFile(file);
    const own: Quote[] = reader.kind === 'go-map' ? goMapQuotes(file, text) : reader.kind === 'table' ? tableQuotes(file, text) : [];
    const marked = reader.kind === 'go-map' ? { quotes: [], problems: [] } : markerQuotes(file, text);
    problems.push(...marked.problems);
    if (reader.kind === 'markers' && marked.quotes.length === 0 && marked.problems.length === 0) {
      problems.push(`${file}: no toolset markers found - quote each figure as <!-- toolset:full:tools -->209<!-- /toolset -->`);
    }
    const expected: Array<readonly [QuotedToolset, QuoteKind]> = reader.kind === 'go-map'
      ? ALL.map((toolset) => [toolset, 'tokens'] as const)
      : reader.kind === 'table' ? reader.toolsets.flatMap((toolset) => [[toolset, 'tools'], [toolset, 'tokens']] as const) : [];
    for (const [toolset, kind] of expected) {
      if (!own.some((quote) => quote.toolset === toolset && quote.kind === kind)) {
        problems.push(`${file}: no ${kind} figure for ${toolset} found - the ${reader.kind === 'go-map' ? 'map' : 'table'} changed shape, fix its reader in apps/mcp/src/test/toolset-quotes.ts`);
      }
    }
    for (const quote of [...own, ...marked.quotes].sort((a, b) => a.line - b.line)) {
      const problem = compare(quote, measured[quote.toolset]);
      if (problem) problems.push(problem);
    }
    if (reader.kind !== 'go-map') {
      for (const hit of unmarkedQuotes(text, reader.kind === 'table', scope === 'file')) {
        problems.push(`${file}:${hit.line}: unmarked quote "${hit.text}" - wrap the figure as <!-- toolset:<toolset>:<tools|tokens|chars> -->${hit.text}<!-- /toolset -->`);
      }
    }
  }
  return problems;
}

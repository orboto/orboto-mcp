import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  GO_MAP_FILE,
  GUARDED_FILES,
  driftProblems,
  goMapQuotes,
  markerQuotes,
  parseFigure,
  tableQuotes,
  tokenTolerance,
  unmarkedQuotes,
  type GuardedFile,
} from './test/toolset-quotes.js';

const real = (file: string) => readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');
const toolsets = (quotes: Array<{ toolset: string }>) => [...new Set(quotes.map((quote) => quote.toolset))].sort();
const marker = (toolset: string, kind: string, value: string) => `<!-- toolset:${toolset}:${kind} -->${value}<!-- /toolset -->`;

const REFERENCE_TABLE = [
  '| Mode | Tools | Connect-time cost | Fits |',
  '|---|---|---|---|',
  '| `channel` (what `orboto mcp install` writes) | 0 | 1.3k chars, ~367 tokens (instructions only) | any |',
  '| `minimal` (ORB-1805) | 12 | schemas 10.0k chars + instructions 0.8k chars, ~3k tokens | 8k and up |',
  '| `curated` (default) | 36 | schemas 37.7k chars, ~10.5k tokens, + instructions 1.4k chars | 32k and up |',
  '| `full` | 209 | schemas 164.5k chars, ~45.7k tokens, + instructions 1.3k chars | 128k |',
].join('\n');

const CLI_TABLE = [
  '| Toolset | Tools | Tokens every model turn |',
  '|---|---|---|',
  '| `channel` (default) | 0 | about 400 (the instructions only) |',
  '| `minimal` | 12 | about 3,000 |',
  '| `curated` | 36 | about 10,500 |',
  '| `full` | 209 | about 45,700 |',
].join('\n');

const GO_MAP = 'var toolsetTokens = map[string]int{\n\t"channel": 400,\n\t"minimal": 3000,\n\t"curated": 10500,\n\t"full":    45700,\n}\n';

const PROSE = [
  'The `full` toolset has ' + marker('full', 'tools', '209') + ' tools; the curated one costs ' + marker('curated', 'tokens', '~10.5k') + ' tokens.',
  '',
  'A page over 2k tokens is read by section, and a hook watches the next 40 tool calls.',
].join('\n');

const MEASURED = {
  channel: { tools: 0, tokens: 367, chars: 1321 },
  minimal: { tools: 12, tokens: 3002, chars: 10048 },
  curated: { tools: 36, tokens: 10468, chars: 37683 },
  full: { tools: 209, tokens: 45691, chars: 164487 },
};

const markersFile = (file: string, scope?: 'file'): GuardedFile => ({ file, reader: { kind: 'markers' }, ...(scope ? { scope } : {}) });
const problemsOf = (guarded: GuardedFile, text: string) => driftProblems([guarded], () => text, MEASURED);

describe('ORB-2873 - parsing a quoted figure', () => {
  it('reads a figure as the docs write it and refuses anything else', () => {
    expect(['209', '45,700', '10.5k', '3k', '~367', '~10.5k'].map(parseFigure)).toEqual([209, 45700, 10500, 3000, 367, 10500]);
    expect(() => parseFigure('about ten')).toThrow('not a quoted figure');
  });

  it('allows 5 % on a token figure and a rounding step on the small channel figure', () => {
    expect(tokenTolerance(10468)).toBeCloseTo(523.4);
    expect(tokenTolerance(367)).toBe(50);
  });
});

describe('ORB-2873 - the marker reader', () => {
  it('reads the toolset, the kind, the figure and the line of every marker', () => {
    const text = `Intro\n${PROSE}\nAnd ${marker('full', 'chars', '164,487')} characters on line 5 with ${marker('channel', 'tokens', '400')} tokens.`;
    expect(markerQuotes('a.md', text).quotes).toEqual([
      { file: 'a.md', line: 2, toolset: 'full', kind: 'tools', value: 209 },
      { file: 'a.md', line: 2, toolset: 'curated', kind: 'tokens', value: 10500 },
      { file: 'a.md', line: 5, toolset: 'full', kind: 'chars', value: 164487 },
      { file: 'a.md', line: 5, toolset: 'channel', kind: 'tokens', value: 400 },
    ]);
  });

  it('reports a marker with a typo, an unknown kind, no closing comment or a value that is no figure', () => {
    const text = [
      '<!-- toolset:ful:tools -->209<!-- /toolset -->',
      '<!-- toolset:full:bytes -->209<!-- /toolset -->',
      '<!-- toolset:full:tools -->209',
      '<!-- toolset:full:tools -->about 209<!-- /toolset -->',
    ].join('\n');
    const { quotes, problems } = markerQuotes('a.md', text);
    expect(quotes).toEqual([]);
    expect(problems.filter((problem) => problem.includes('malformed marker'))).toHaveLength(5);
    expect(problems.filter((problem) => problem.includes('a.md:4: marker value "about 209" is not a figure'))).toHaveLength(1);
  });

  it('survives a reworded sentence around the markers', () => {
    const reworded = 'Everything the `full` toolset registers is ' + marker('full', 'tools', '209') + ' tools by now.\n';
    expect(problemsOf(markersFile('a.md'), reworded)).toEqual([]);
  });
});

describe('ORB-2873 - the scan for figures outside a marker', () => {
  it('finds a tool count, a k figure, a hyphenated count and a figure named after its toolset', () => {
    const text = 'The `full` toolset has 209 tools and costs ~45.7k tokens; the 12-tool `minimal` tier needs 3k tokens, `curated` 10.5k for `curated`.';
    expect(unmarkedQuotes(text, false).map((hit) => hit.text)).toEqual(['209 tools', '12-tool', '~45.7k', '45.7k tokens', '3k tokens', '10.5k for `curated`']);
  });

  it('ignores a marked figure, a paragraph that names no toolset and a 1,234 style figure outside a manifest file', () => {
    expect(unmarkedQuotes(PROSE, false)).toEqual([]);
    expect(unmarkedQuotes('The `full` toolset has 1,234 statements.', false)).toEqual([]);
    expect(unmarkedQuotes('The `full` toolset has 1,234 statements.', false, true).map((hit) => hit.text)).toEqual(['1,234']);
    expect(unmarkedQuotes('A paragraph about 36 tools of something else.', false, true).map((hit) => hit.text)).toEqual(['36 tools']);
  });

  it('ORB-2873 review - finds a figure in a paragraph that names a toolset only as its manifest, tier or set, and a plain token count in a manifest file', () => {
    expect(unmarkedQuotes('The full manifest costs ~46k tokens.', false).map((hit) => hit.text)).toEqual(['~46k', '46k tokens']);
    expect(unmarkedQuotes('The curated tier is 36 tools.', false).map((hit) => hit.text)).toEqual(['36 tools']);
    expect(unmarkedQuotes('A manifest paragraph about 2k tokens of a doc page.', false)).toEqual([]);
    expect(unmarkedQuotes('The `full` toolset costs 45700 tokens.', false, true).map((hit) => hit.text)).toEqual(['45700 tokens']);
  });

  it('skips the rows the table reader consumes and nothing else of a table file', () => {
    const text = `${REFERENCE_TABLE}\n\nThe \`full\` toolset has 209 tools.`;
    expect(unmarkedQuotes(text, true).map((hit) => [hit.line, hit.text])).toEqual([[8, '209 tools']]);
  });

  it('fails a guarded file with the file, the line and the wrapper to write', () => {
    const problems = problemsOf(markersFile('docs/a.md'), `${PROSE}\n\nThe \`minimal\` tier has 12 tools.`);
    expect(problems).toEqual(['docs/a.md:5: unmarked quote "12 tools" - wrap the figure as <!-- toolset:<toolset>:<tools|tokens|chars> -->12 tools<!-- /toolset -->']);
  });
});

describe('ORB-2873 - the table and Go map readers', () => {
  it('finds the count and the token figure of all four toolsets in both table shapes', () => {
    const reference = tableQuotes('ref.md', REFERENCE_TABLE);
    expect(toolsets(reference)).toEqual(['channel', 'curated', 'full', 'minimal']);
    expect(reference.filter((quote) => quote.kind === 'tools').map((quote) => quote.value)).toEqual([0, 12, 36, 209]);
    expect(reference.filter((quote) => quote.kind === 'tokens').map((quote) => quote.value)).toEqual([367, 3000, 10500, 45700]);
    expect(reference.map((quote) => quote.line)).toEqual([3, 3, 4, 4, 5, 5, 6, 6]);
    expect(tableQuotes('cli.md', CLI_TABLE).filter((quote) => quote.kind === 'tokens').map((quote) => quote.value)).toEqual([400, 3000, 10500, 45700]);
  });

  it('finds all four toolsets in the Go map and nothing in a renamed one', () => {
    expect(goMapQuotes('mcp_toolset.go', GO_MAP).map((quote) => [quote.toolset, quote.value, quote.line])).toEqual([
      ['channel', 400, 2], ['minimal', 3000, 3], ['curated', 10500, 4], ['full', 45700, 5],
    ]);
    expect(goMapQuotes('mcp_toolset.go', GO_MAP.replace(/\n\t/g, ' ')).map((quote) => quote.value)).toEqual([400, 3000, 10500, 45700]);
    expect(goMapQuotes('mcp_toolset.go', GO_MAP.replace('toolsetTokens', 'toolsetCost'))).toEqual([]);
  });

  it('reports a table or a map that changed shape instead of matching nothing', () => {
    const table: GuardedFile = { file: 'a.md', reader: { kind: 'table', toolsets: ['channel', 'minimal', 'curated', 'full'] } };
    expect(problemsOf(table, 'nothing here')).toHaveLength(8);
    const goMap: GuardedFile = { file: 'b.go', reader: { kind: 'go-map' } };
    expect(problemsOf(goMap, GO_MAP.replace('toolsetTokens', 'toolsetCost'))).toHaveLength(4);
    const lost = problemsOf(goMap, GO_MAP.replace('\t"minimal": 3000,\n', ''));
    expect(lost).toHaveLength(1);
    expect(lost[0]).toContain('no tokens figure for minimal');
  });
});

describe('ORB-2873 - drift between a quote and the measurement', () => {
  it('names the file, the line, the quoted value and the measured value of a marker with a wrong figure', () => {
    const text = `Intro\nThe \`full\` toolset has ${marker('full', 'tools', '210')} tools and ${marker('curated', 'tokens', '~11.1k')} tokens, ${marker('curated', 'chars', '40,000')} characters.`;
    expect(problemsOf(markersFile('docs/a.md'), text)).toEqual([
      'docs/a.md:2: quotes 210 tools for full, measured 209',
      'docs/a.md:2: quotes ~11100 tokens for curated, measured 10468 (allowed drift 523)',
      'docs/a.md:2: quotes 40000 characters for curated, measured 37683 (allowed drift 1884)',
    ]);
  });

  it('accepts a figure within 5 % and a count that matches', () => {
    expect(problemsOf(markersFile('a.md'), `The \`curated\` toolset has ${marker('curated', 'tools', '36')} tools and ${marker('curated', 'tokens', '10,700')} tokens.`)).toEqual([]);
    expect(problemsOf({ file: 'cli.md', reader: { kind: 'table', toolsets: ['channel', 'minimal', 'curated', 'full'] } }, CLI_TABLE)).toEqual([]);
    expect(problemsOf({ file: 'cli.md', reader: { kind: 'table', toolsets: ['channel', 'minimal', 'curated', 'full'] } }, CLI_TABLE.replace('about 10,500', 'about 11,000'))).toHaveLength(1);
  });

  it('reports a file that should carry markers and has none', () => {
    expect(problemsOf(markersFile('docs/a.md'), 'The `full` toolset has no markers at all.')).toEqual([
      'docs/a.md: no toolset markers found - quote each figure as <!-- toolset:full:tools -->209<!-- /toolset -->',
    ]);
  });
});

describe('ORB-2873 - the real files', () => {
  it('finds all four toolsets in the real Go map and the real toolset table', () => {
    expect(toolsets(goMapQuotes(GO_MAP_FILE, real(GO_MAP_FILE)))).toEqual(['channel', 'curated', 'full', 'minimal']);
    expect(toolsets(tableQuotes('docs/mcp-reference.md', real('docs/mcp-reference.md')))).toEqual(['channel', 'curated', 'full', 'minimal']);
  });

  it('carries at least one marker in every file that is read for markers', () => {
    const empty = GUARDED_FILES.filter((guarded) => guarded.reader.kind === 'markers' && markerQuotes(guarded.file, real(guarded.file)).quotes.length === 0);
    expect(empty.map((guarded) => guarded.file)).toEqual([]);
  });
});

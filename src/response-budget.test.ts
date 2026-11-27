/**
 * ORB-1697 - the central response budget.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  applyResponseBudget,
  budgetFor,
  budgetEnabled,
  measureHalves,
  measureResult,
  readPayload,
  resetPayloadStore,
  resolvePath,
  DEFAULT_BUDGET_CHARS,
  MAX_HANDLES,
  HANDLE_TTL_MS,
  storePayload,
  PROTECT_TEXT_META,
  UNCUT_ELSEWHERE,
  uncutElsewhere,
} from './response-budget.js';
import { CLI_READS } from './cli-reads.js';
import { makeResponseExpandHandler } from './tools/response-expand.js';

const TOOL = 'orboto_test_tool';

function result(structured: Record<string, unknown> | undefined, text = 'text block'): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    ...(structured === undefined ? {} : { structuredContent: structured }),
  };
}

function safeJson(value: unknown): string {
  return JSON.stringify(value) ?? '';
}

/** A truncation block, if the budget wrote one. */
function truncationOf(r: CallToolResult): Record<string, unknown> | undefined {
  const sc = r.structuredContent as Record<string, unknown> | undefined;
  return sc?.__truncation as Record<string, unknown> | undefined;
}

beforeEach(() => {
  resetPayloadStore();
  delete process.env.ORBOTO_MCP_RESPONSE_BUDGET;
  delete process.env.ORBOTO_MCP_RESPONSE_BUDGET_CHARS;
});

describe('budget configuration', () => {
  it('defaults to 4k and honours per-tool overrides', () => {
    expect(budgetFor('orboto_whatever', {})).toBe(DEFAULT_BUDGET_CHARS);
    expect(budgetFor('orboto_get_doc', {})).toBeGreaterThan(DEFAULT_BUDGET_CHARS);
    expect(budgetFor('orboto_session_start', {})).toBe(DEFAULT_BUDGET_CHARS);
  });

  it('reads a custom default from the env, per-tool overrides still win', () => {
    expect(budgetFor('orboto_whatever', { ORBOTO_MCP_RESPONSE_BUDGET_CHARS: '9000' })).toBe(9000);
    expect(budgetFor('orboto_get_doc', { ORBOTO_MCP_RESPONSE_BUDGET_CHARS: '9000' }))
      .toBe(budgetFor('orboto_get_doc', {}));
  });

  it('ignores a nonsense env value rather than dropping the cap to zero', () => {
    expect(budgetFor('orboto_whatever', { ORBOTO_MCP_RESPONSE_BUDGET_CHARS: 'lots' })).toBe(DEFAULT_BUDGET_CHARS);
    expect(budgetFor('orboto_whatever', { ORBOTO_MCP_RESPONSE_BUDGET_CHARS: '-5' })).toBe(DEFAULT_BUDGET_CHARS);
  });

  it('can be switched off entirely', () => {
    expect(budgetEnabled({ ORBOTO_MCP_RESPONSE_BUDGET: 'off' })).toBe(false);
    expect(budgetEnabled({})).toBe(true);
    const big = result({ blob: 'x'.repeat(50_000) });
    const out = applyResponseBudget(TOOL, big, { ORBOTO_MCP_RESPONSE_BUDGET: 'off' });
    expect(out.truncatedChars).toBe(0);
    expect(truncationOf(out.result)).toBeUndefined();
  });
});

describe('measurement', () => {
  it('measures the two halves separately and prices the heavier one', () => {
    const r = result({ a: 'x'.repeat(1000) }, 'y'.repeat(300));
    const { textChars, structuredChars } = measureHalves(r);
    expect(textChars).toBe(300);
    expect(structuredChars).toBeGreaterThan(1000);
    expect(measureResult(r)).toBe(structuredChars);
  });
});

describe('under budget', () => {
  it('returns the result untouched', () => {
    const r = result({ key: 'ORB-1697', title: 'small' });
    const out = applyResponseBudget(TOOL, r);
    expect(out.result).toBe(r);
    expect(out.truncatedChars).toBe(0);
    expect(out.handle).toBeUndefined();
    expect(out.responseChars).toBe(measureResult(r));
  });
});

describe('over budget', () => {
  it('cuts the payload and reports the numbers the call log records', () => {
    const out = applyResponseBudget(TOOL, result({ description: 'd'.repeat(30_000) }));
    expect(out.originalChars).toBeGreaterThan(30_000);
    expect(out.responseChars).toBeLessThanOrEqual(budgetFor(TOOL));
    expect(out.truncatedChars).toBeGreaterThan(0);
    expect(out.handle).toBeTruthy();
  });

  it('never truncates silently - the block names the handle, the paths and the way back', () => {
    const out = applyResponseBudget(TOOL, result({ description: 'd'.repeat(30_000) }));
    const block = truncationOf(out.result)!;
    expect(block.handle).toBe(out.handle);
    expect(block.budgetChars).toBe(budgetFor(TOOL));
    expect(block.omittedChars as number).toBeGreaterThan(0);
    expect(String(block.howToGetTheRest)).toContain('orboto_response_expand');
    expect(block.omitted).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'description', kind: 'string' })]),
    );
    const text = (out.result.content[0] as { text: string }).text;
    expect(text).toContain('orboto_response_expand');
    expect(text).toContain(out.handle!);
  });

  it('ORB-2164: the hint names BOTH ways out - the expand handle and the uncut body over REST or the CLI', () => {
    const out = applyResponseBudget(TOOL, result({ description: 'd'.repeat(30_000) }));
    const block = truncationOf(out.result)!;
    const how = String(block.howToGetTheRest);
    expect(how).toContain('orboto_response_expand');
    expect(how).toContain('expires 15 minutes');
    expect(how).toContain('this MCP server process');
    expect(how).toContain(UNCUT_ELSEWHERE);
    const text = (out.result.content[0] as { text: string }).text;
    expect(text).toContain(UNCUT_ELSEWHERE);
    expect(UNCUT_ELSEWHERE).toContain('REST API and both CLIs');
    expect(UNCUT_ELSEWHERE).toContain('no CLI expand');
  });

  it('ORB-3289: the notice of a cut names the exact CLI commands of the tool that was cut, in the text and in __truncation, inside the budget', () => {
    for (const [tool, read] of Object.entries(CLI_READS)) {
      resetPayloadStore();
      const out = applyResponseBudget(tool, result({ description: 'd'.repeat(60_000) }));
      const how = String(truncationOf(out.result)!.howToGetTheRest);
      const text = (out.result.content[0] as { text: string }).text;
      for (const part of read.parts) {
        expect(how, tool).toContain(`\`${part.usage}\``);
        expect(text, tool).toContain(`\`${part.usage}\``);
      }
      expect(how, tool).toContain(uncutElsewhere(tool));
      expect(how, tool).not.toContain('the named CLI command');
      expect(out.responseChars, tool).toBeLessThanOrEqual(budgetFor(tool));
      const textOnly = applyResponseBudget(tool, result(undefined, 'e'.repeat(60_000)));
      expect(measureHalves(textOnly.result).textChars, tool).toBeLessThanOrEqual(budgetFor(tool));
      expect((textOnly.result.content[0] as { text: string }).text, tool).toContain(`\`${read.parts[0]!.usage}\``);
    }
  });

  it('ORB-3289: the query notice says how to page, the list notices lift the cap, get_ticket claims no whole body, ask tools say they ask again', () => {
    expect(uncutElsewhere('orboto_query')).toContain('orboto query "<oql>" --json --limit 200');
    expect(uncutElsewhere('orboto_query')).toContain('page on with `--cursor <nextCursor>`');
    expect(uncutElsewhere('orboto_list_tickets')).toContain('orboto list-tickets <KEY> --json --all --status all');
    expect(uncutElsewhere('orboto_list_tickets')).toContain('`--all` lifts the 50-row cap');
    expect(uncutElsewhere('orboto_my_tickets')).toContain('orboto my-tickets --json --all');
    expect(uncutElsewhere('orboto_get_ticket')).toContain('orboto comments <KEY> --all --json');
    expect(uncutElsewhere('orboto_get_ticket')).not.toContain('complete body');
    expect(uncutElsewhere('orboto_knowledge_ask')).toContain('asks again');
    expect(uncutElsewhere('orboto_wiki_ask')).toContain('a new answer');
    for (const tool of Object.keys(CLI_READS)) expect(uncutElsewhere(tool), tool).toContain('There is no CLI expand.');
  });

  it('ORB-3289: a tool without a mapped command gets the generic way out, and the mapped tools do not', () => {
    expect(uncutElsewhere(TOOL)).toBe(UNCUT_ELSEWHERE);
    expect(UNCUT_ELSEWHERE).not.toContain('the named CLI command');
    expect(UNCUT_ELSEWHERE).toContain('orboto help');
    expect(uncutElsewhere('orboto_list_tickets')).not.toBe(UNCUT_ELSEWHERE);
  });

  describe('ORB-3289: the structured half is measured with its __truncation block', () => {
    const shapes: Record<string, () => CallToolResult> = {
      'one huge string beside a long text': () => ({
        content: [{ type: 'text', text: 'x'.repeat(30_000) }],
        structuredContent: { description: 'd'.repeat(60_000) },
      }),
      'a ticket-like mixed result': () => ({
        content: [{ type: 'text', text: 'q\n'.repeat(8000) }],
        structuredContent: {
          ticket: { description: 'd'.repeat(20_000) },
          comments: Array.from({ length: 80 }, () => ({ body: 'c'.repeat(800) })),
          attachments: Array.from({ length: 40 }, () => ({ name: 'n'.repeat(100) })),
          children: Array.from({ length: 60 }, () => ({ key: 'k', title: 't'.repeat(80) })),
        },
      }),
      '400 rows': () => ({
        content: [{ type: 'text', text: Array.from({ length: 400 }, (_, i) => `ORB-${i} some title here ${'y'.repeat(40)}`).join('\n') }],
        structuredContent: {
          items: Array.from({ length: 400 }, (_, i) => ({ key: `ORB-${i}`, title: 't'.repeat(60), status: 'todo', more: { a: 'b'.repeat(30) } })),
          nextCursor: 'c',
        },
      }),
    };

    for (const tool of [TOOL, 'orboto_list_tickets', 'orboto_get_ticket', 'orboto_knowledge_find', 'orboto_get_doc']) {
      for (const [name, make] of Object.entries(shapes)) {
        it(`${tool}, ${name}: both halves stay within the budget and nothing says atFloor`, () => {
          const out = applyResponseBudget(tool, make());
          const halves = measureHalves(out.result);
          expect(halves.structuredChars, 'structured half').toBeLessThanOrEqual(budgetFor(tool));
          expect(halves.textChars, 'text half').toBeLessThanOrEqual(budgetFor(tool));
          expect(truncationOf(out.result)!.atFloor).toBeUndefined();
        });
      }
    }

    const hasLoneSurrogate = (value: string): boolean => {
      for (let i = 0; i < value.length; i += 1) {
        const code = value.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
          const next = value.charCodeAt(i + 1);
          if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
          i += 1;
        } else if (code >= 0xdc00 && code <= 0xdfff) {
          return true;
        }
      }
      return false;
    };
    const headBeforeMarker = (value: string): string => value.slice(0, value.indexOf('... [truncated'));

    const stringShapes: Record<string, string> = {
      'emoji': '\u{1F600}'.repeat(5000),
      'a, then emoji': 'a' + '\u{1F600}'.repeat(5000),
      'quotes, backslashes and control characters': '"\\\n\u0001'.repeat(5000),
      'CJK, an astral CJK character, emoji and escapes': '\u6F22\u5B57\u{20BB7}\u{1F600}e\u0007"'.repeat(4000),
    };
    for (const tool of [TOOL, 'orboto_get_ticket', 'orboto_list_tickets', 'orboto_query']) {
      for (const [name, body] of Object.entries(stringShapes)) {
        it(`${tool}, ${name}: the cut fits the budget by the JSON length of what it keeps, splits no surrogate pair and is not at the floor`, () => {
          const out = applyResponseBudget(tool, result({ body }));
          const halves = measureHalves(out.result);
          const kept = (out.result.structuredContent as { body: string }).body;
          expect(halves.structuredChars, 'structured half').toBeLessThanOrEqual(budgetFor(tool));
          expect(halves.structuredChars, 'the budget is used, not undershot').toBeGreaterThanOrEqual(budgetFor(tool) - 50);
          expect(truncationOf(out.result)!.atFloor).toBeUndefined();
          expect(hasLoneSurrogate(headBeforeMarker(kept))).toBe(false);
          expect(hasLoneSurrogate(kept)).toBe(false);
          expect(safeJson(out.result.structuredContent)).not.toMatch(/\\ud[89a-f][0-9a-f]{2}/i);
        });
      }
    }

    for (const prefix of ['', 'a']) {
      it(`a text of emoji${prefix ? ' behind one letter' : ''} is cut between whole characters`, () => {
        const text = prefix + '\u{1F600}'.repeat(5000);
        const out = applyResponseBudget(TOOL, { content: [{ type: 'text', text }] });
        const cut = (out.result.content[0] as { text: string }).text;
        expect(hasLoneSurrogate(cut.slice(0, cut.indexOf('\n\n[Response truncated')))).toBe(false);
        expect(measureHalves(out.result).textChars).toBeLessThanOrEqual(budgetFor(TOOL));
      });
    }

    for (const tool of [TOOL, 'orboto_list_tickets']) {
      it(`${tool}: the text half keeps rows up to the exact length of its notice`, () => {
        const text = Array.from({ length: 400 }, (_, i) => `ORB-${i} some title here ${'y'.repeat(40)}`).join('\n');
        const out = applyResponseBudget(tool, { content: [{ type: 'text', text }], structuredContent: { nextCursor: 'c' } });
        const halves = measureHalves(out.result);
        expect(halves.textChars).toBeLessThanOrEqual(budgetFor(tool));
        expect(halves.textChars, 'no more than one row of room is left unused').toBeGreaterThan(budgetFor(tool) - 70);
      });
    }

    const withJsonLength = (chars: number, make: (pad: string) => Record<string, unknown>): Record<string, unknown> => {
      const empty = JSON.stringify(make('')).length;
      return make('p'.repeat(chars - empty));
    };
    const nonTextParts: Record<string, Record<string, unknown>> = {
      'a resource_link': withJsonLength(370, (pad) => ({ type: 'resource_link', uri: 'orboto://ticket/ORB-1', name: 'ORB-1', description: pad })),
      'an image': withJsonLength(370, (pad) => ({ type: 'image', mimeType: 'image/png', data: pad })),
      'an embedded resource': withJsonLength(370, (pad) => ({ type: 'resource', resource: { uri: 'orboto://doc/1', mimeType: 'text/plain', text: pad } })),
    };
    for (const tool of [TOOL, 'orboto_list_tickets']) {
      for (const [name, part] of Object.entries(nonTextParts)) {
        it(`${tool}: a cut text beside ${name} of 370 characters stays within the budget and the part is kept`, () => {
          const text = Array.from({ length: 400 }, (_, i) => `ORB-${i} some title here ${'y'.repeat(40)}`).join('\n');
          expect(JSON.stringify(part).length).toBe(370);
          const out = applyResponseBudget(tool, {
            content: [{ type: 'text', text }, part as CallToolResult['content'][number]],
            structuredContent: { nextCursor: 'c' },
          });
          const halves = measureHalves(out.result);
          expect(halves.textChars).toBeLessThanOrEqual(budgetFor(tool));
          expect(halves.textChars, 'the rest of the budget is used by the text').toBeGreaterThan(budgetFor(tool) - 70);
          expect(out.result.content).toContainEqual(part);
        });
      }
    }

    it('a part that leaves the text less than its floor beside the notice never makes a cut that stays over: the band 3452 characters sits in', () => {
      const budget = budgetFor(TOOL);
      const text = Array.from({ length: 20 }, (_, i) => `row ${i} ${'t'.repeat(28)}`).join('\n');
      expect(text.length).toBeGreaterThan(560);
      expect(text.length).toBeLessThan(800);
      const image = (chars: number): CallToolResult['content'][number] => withJsonLength(chars, (pad) => ({ type: 'image', mimeType: 'image/png', data: pad })) as CallToolResult['content'][number];
      const specific = applyResponseBudget(TOOL, { content: [{ type: 'text', text }, image(3452)] });
      const shown = (specific.result.content[0] as { text: string }).text;
      expect(shown).not.toContain('Response truncated');
      expect(shown).toContain('nothing in it could be cut safely');
      expect(shown.startsWith(`${text}\n\n[Response is `)).toBe(true);
      for (let chars = 3000; chars <= 3700; chars += 1) {
        const out = applyResponseBudget(TOOL, { content: [{ type: 'text', text }, image(chars)] });
        const body = (out.result.content[0] as { text: string }).text;
        const cut = body.includes('Response truncated');
        const halves = measureHalves(out.result);
        if (cut) expect(halves.textChars, `a ${chars}-character part: cut and still over`).toBeLessThanOrEqual(budget);
        else expect(body.startsWith(text), `a ${chars}-character part: the text stays whole`).toBe(true);
      }
    });

    it('a part that cannot fit leaves a short text whole and names the cut of the structured half with the truncated notice', () => {
      const text = 'Created full workspace backup (1.5 MB), run r.';
      const blob: CallToolResult['content'][number] = { type: 'resource', resource: { uri: 'orboto://backup/full.zip', mimeType: 'application/zip', blob: 'B'.repeat(200_000) } };
      const out = applyResponseBudget(TOOL, { content: [blob, { type: 'text', text }], structuredContent: { runId: 'r', log: 'l'.repeat(30_000) } });
      const shown = (out.result.content[0] as { text: string }).text;
      expect(shown.startsWith(`${text}\n\n[Response truncated `)).toBe(true);
      expect(shown).not.toContain('nothing in it could be cut safely');
      expect((truncationOf(out.result)!.omitted as Array<{ path: string }>).map((entry) => entry.path)).toEqual(['log']);
      expect(out.result.content).toContainEqual(blob);
    });

    it('a non-text part that cannot fit the budget at all leaves the text whole: the sealed backup result says nothing could be cut', () => {
      const note = ' The archive is encrypted with the instance key - it only restores where that key exists.';
      const line = (runId: string): string => `Created full workspace backup (1.5 MB), run ${runId}.${note}`;
      const text = line('r'.repeat(171 - line('').length));
      expect(text).toHaveLength(171);
      const blob: CallToolResult['content'][number] = {
        type: 'resource',
        resource: { uri: 'orboto://backup/full.zip.orbenc', mimeType: 'application/octet-stream', blob: 'B'.repeat(200_000) },
      };
      const out = applyResponseBudget('orboto_create_full_backup', {
        content: [blob, { type: 'text', text }],
        structuredContent: { sizeBytes: 150_000, contentType: 'application/octet-stream', runId: 'r', sealed: true },
      });
      const shown = (out.result.content[0] as { text: string }).text;
      expect(shown.startsWith(`${text}\n\n[Response is `)).toBe(true);
      expect(readPayload(out.handle!)!.text).toBe(text);
      expect(shown).toContain('nothing in it could be cut safely');
      expect(shown).not.toContain('Response truncated');
      expect(truncationOf(out.result)!.omitted).toEqual([]);
      expect(out.result.content).toContainEqual(blob);
    });

    it('only text parts make the text: a part that is not text adds no newline to the shown text or the stored $text', async () => {
      const image: CallToolResult['content'][number] = { type: 'image', mimeType: 'image/png', data: 'A'.repeat(300) };
      const first = 'first line\n'.repeat(500).trimEnd();
      const second = 'second part';
      const out = applyResponseBudget(TOOL, {
        content: [image, { type: 'text', text: first }, image, { type: 'text', text: second }, image],
        structuredContent: { nextCursor: 'c' },
      });
      const shown = (out.result.content[0] as { text: string }).text;
      expect(shown.startsWith('first line')).toBe(true);
      expect(readPayload(out.handle!)!.text).toBe(`${first}\n${second}`);
      const expanded = await makeResponseExpandHandler()({ handle: out.handle!, path: '$text' });
      expect((expanded.structuredContent as { chunk: string }).chunk.startsWith('first line')).toBe(true);
      expect((expanded.structuredContent as { totalChars: number }).totalChars).toBe(first.length + 1 + second.length);
    });

    it('an answer of non-text parts only gets the notice and nothing before it', () => {
      const out = applyResponseBudget(TOOL, {
        content: [{ type: 'image', mimeType: 'image/png', data: 'A'.repeat(6000) }, { type: 'image', mimeType: 'image/png', data: 'B'.repeat(6000) }],
      });
      expect((out.result.content[0] as { text: string }).text.startsWith('[Response is ')).toBe(true);
    });

    it('a payload of many long strings is cut once per string, lists each path once and says it is at the floor', () => {
      const fields = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`field${i}`, 's'.repeat(2000)]));
      const out = applyResponseBudget(TOOL, result(fields));
      const block = truncationOf(out.result)!;
      const paths = (block.omitted as Array<{ path: string }>).map((entry) => entry.path);
      expect(new Set(paths).size).toBe(paths.length);
      expect(paths).toHaveLength(30);
      expect(block.atFloor).toBe(true);
      for (let i = 0; i < 30; i += 1) {
        const value = (out.result.structuredContent as Record<string, string>)[`field${i}`]!;
        expect(value.startsWith('s'.repeat(160))).toBe(true);
        expect(value.length).toBeLessThan(2000);
      }
    });

    it('a string that a cut would not make shorter is left alone', () => {
      const fields = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`field${i}`, 'k'.repeat(250)]));
      const out = applyResponseBudget(TOOL, result(fields));
      const block = truncationOf(out.result)!;
      expect(block.omitted).toEqual([]);
      for (let i = 0; i < 40; i += 1) {
        expect((out.result.structuredContent as Record<string, string>)[`field${i}`]).toBe('k'.repeat(250));
      }
      expect(block.atFloor).toBe(true);
    });
  });

  it('marks the cut inside the value, so a reader cannot mistake it for the whole', () => {
    const out = applyResponseBudget(TOOL, result({ description: 'd'.repeat(30_000) }));
    const sc = out.result.structuredContent as { description: string };
    expect(sc.description.length).toBeLessThan(30_000);
    expect(sc.description).toContain('truncated');
    expect(sc.description).toContain('orboto_response_expand');
  });
});

describe('shape preservation (outputSchema tools must still validate)', () => {
  it('keeps every key, keeps arrays as arrays, keeps types', () => {
    const structured = {
      id: 'cd42b836-47b8-485a-aea7-ad09789b9bc6',
      key: 'ORB-1697',
      count: 42,
      flag: true,
      nothing: null,
      description: 'd'.repeat(20_000),
      comments: Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, body: 'b'.repeat(400) })),
    };
    const out = applyResponseBudget(TOOL, result(structured));
    const sc = out.result.structuredContent as Record<string, unknown>;

    for (const key of Object.keys(structured)) expect(sc).toHaveProperty(key);
    expect(Array.isArray(sc.comments)).toBe(true);
    expect(typeof sc.description).toBe('string');
    expect(sc.count).toBe(42);
    expect(sc.flag).toBe(true);
    expect(sc.nothing).toBeNull();
  });

  it('never cuts identifier-shaped strings in half', () => {
    const uuid = 'cd42b836-47b8-485a-aea7-ad09789b9bc6';
    const url = 'https://orboto.example.com/projects/904c8036/tickets/3dab8c3c';
    const out = applyResponseBudget(TOOL, result({ id: uuid, url, blob: 'x'.repeat(40_000) }));
    const sc = out.result.structuredContent as Record<string, string>;
    expect(sc.id).toBe(uuid);
    expect(sc.url).toBe(url);
  });

  it('drops array items from the tail and says how many', () => {
    const items = Array.from({ length: 60 }, (_, i) => ({ key: `ORB-${i}`, title: 't'.repeat(200) }));
    const out = applyResponseBudget(TOOL, result({ items }));
    const sc = out.result.structuredContent as { items: Array<{ key: string }> };
    expect(sc.items.length).toBeLessThan(60);
    expect(sc.items.length).toBeGreaterThan(0);
    expect(sc.items[0].key).toBe('ORB-0');
    const entry = (truncationOf(out.result)!.omitted as Array<Record<string, unknown>>)
      .find((e) => e.path === 'items');
    expect(entry).toMatchObject({ kind: 'array' });
    expect(entry!.omittedItems as number).toBeGreaterThan(0);
    expect((entry!.keptItems as number) + (entry!.omittedItems as number)).toBe(60);
  });

  it('leaves non-text content parts (images, resources) alone', () => {
    const r: CallToolResult = {
      content: [
        { type: 'text', text: 't'.repeat(20_000) },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      ],
      structuredContent: { blob: 'x'.repeat(20_000) },
    };
    const out = applyResponseBudget(TOOL, r);
    expect(out.result.content.some((p) => p.type === 'image')).toBe(true);
  });

  it('handles a result with no structuredContent at all', () => {
    const out = applyResponseBudget(TOOL, { content: [{ type: 'text', text: 'q'.repeat(20_000) }] });
    const text = (out.result.content[0] as { text: string }).text;
    expect(text.length).toBeLessThanOrEqual(budgetFor(TOOL));
    expect(text).toContain('orboto_response_expand');
    expect(out.truncatedChars).toBeGreaterThan(0);
  });

  it('cuts the text half on a line boundary', () => {
    const lines = Array.from({ length: 900 }, (_, i) => `line-${i}-padding-padding-padding`);
    const out = applyResponseBudget(TOOL, result(undefined, lines.join('\n')));
    const text = (out.result.content[0] as { text: string }).text;
    const kept = text.split('\n\n[Response truncated')[0].split('\n').filter(Boolean);
    for (const line of kept) expect(lines).toContain(line);
  });
});

describe('the floor case - a payload made only of uncuttable leaves', () => {
  it('reports atFloor instead of looping or mangling identifiers', () => {
    const structured = Object.fromEntries(
      Array.from({ length: 500 }, (_, i) => [`field_${i}`, `v${i}`.padEnd(90, 'x')]),
    );
    const out = applyResponseBudget(TOOL, result(structured));
    expect(out.originalChars).toBeGreaterThan(budgetFor(TOOL));
    const block = truncationOf(out.result)!;
    expect(block.atFloor).toBe(true);
    const sc = out.result.structuredContent as Record<string, string>;
    expect(Object.keys(sc)).toHaveLength(501);
    expect(sc.field_0).toBe(structured.field_0);
  });
});

describe('nothing is lost - orboto_response_expand', () => {
  const expand = makeResponseExpandHandler();

  it('lists what was omitted when called with the handle alone', async () => {
    const out = applyResponseBudget(TOOL, result({ description: 'd'.repeat(30_000) }));
    const res = await expand({ handle: out.handle! });
    const sc = res.structuredContent as { toolName: string; omitted: Array<{ path: string }> };
    expect(res.isError).toBeUndefined();
    expect(sc.toolName).toBe(TOOL);
    expect(sc.omitted.map((o) => o.path)).toContain('description');
  });

  it('returns the FULL original value, chunked, following nextCursor to the end', async () => {
    const original = 'd'.repeat(30_000);
    const out = applyResponseBudget(TOOL, result({ description: original }));

    let cursor = 0;
    let assembled = '';
    for (let guard = 0; guard < 50; guard += 1) {
      const res = await expand({ handle: out.handle!, path: 'description', cursor });
      const sc = res.structuredContent as { chunk: string; nextCursor: number | null; totalChars: number };
      assembled += sc.chunk;
      expect(sc.totalChars).toBe(original.length);
      if (sc.nextCursor === null) break;
      cursor = sc.nextCursor;
    }
    expect(assembled).toBe(original);
  });

  it('serves a nested path and the text half', async () => {
    const out = applyResponseBudget('orboto_session_start', {
      content: [{ type: 'text', text: 'T'.repeat(60_000) }],
      structuredContent: { ticketBundle: { primer: { markdown: 'M'.repeat(60_000) } } },
    });
    const nested = await expand({ handle: out.handle!, path: 'ticketBundle.primer.markdown' });
    expect((nested.structuredContent as { totalChars: number }).totalChars).toBe(60_000);
    const text = await expand({ handle: out.handle!, path: '$text' });
    expect((text.structuredContent as { totalChars: number }).totalChars).toBe(60_000);
  });

  it('is an explicit error - never a wrong chunk - for an expired handle or a bad path', async () => {
    const gone = await expand({ handle: 'deadbeef' });
    expect(gone.isError).toBe(true);
    expect((gone.content[0] as { text: string }).text).toContain('Re-run the original tool');

    const out = applyResponseBudget(TOOL, result({ description: 'd'.repeat(30_000) }));
    const badPath = await expand({ handle: out.handle!, path: 'nope.not.here' });
    expect(badPath.isError).toBe(true);
  });

  it('resolves array indices in a path', () => {
    const root = { comments: [{ body: 'first' }, { body: 'second' }] };
    expect(resolvePath(root, 'comments[1].body')).toBe('second');
    expect(resolvePath(root, 'comments[9].body')).toBeUndefined();
    expect(resolvePath(root, '')).toBe(root);
  });
});

describe('a handle is readable only by the session that produced it', () => {
  it('another session cannot read or expand a handle, the owner can', async () => {
    const sessionA = {};
    const sessionB = {};
    const out = applyResponseBudget(TOOL, result({ description: 'private '.repeat(5_000) }), {}, sessionA);
    expect(out.handle).toBeDefined();

    expect(readPayload(out.handle!, Date.now(), sessionB)).toBeNull();
    const foreign = await makeResponseExpandHandler(sessionB)({ handle: out.handle!, path: 'description' });
    expect(foreign.isError).toBe(true);
    expect(JSON.stringify(foreign)).not.toContain('private');

    const own = await makeResponseExpandHandler(sessionA)({ handle: out.handle!, path: 'description' });
    expect(own.isError).toBeUndefined();
  });

  it('issues handles with at least 64 bits of randomness', () => {
    expect(storePayload(TOOL, { text: 'a' })).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('the handle store is bounded', () => {
  it('evicts the oldest beyond MAX_HANDLES', () => {
    const first = storePayload(TOOL, { text: 'a' });
    for (let i = 0; i < MAX_HANDLES + 2; i += 1) storePayload(TOOL, { text: `x${i}` });
    expect(readPayload(first)).toBeNull();
  });

  it('expires handles after the TTL', () => {
    const t0 = 1_000_000;
    const handle = storePayload(TOOL, { text: 'a' }, t0);
    expect(readPayload(handle, t0 + 1000)).not.toBeNull();
    expect(readPayload(handle, t0 + HANDLE_TTL_MS + 1)).toBeNull();
  });
});

describe('protected paths - a mandatory rule is never cut (ORB-1697)', () => {
  it('cuts the primer, not the rules, on an over-budget session_start', () => {
    const rules = 'R'.repeat(24_000);
    const out = applyResponseBudget('orboto_session_start', result({
      rules,
      ticketBundle: { primer: { markdown: 'P'.repeat(30_000) } },
    }));

    const sc = out.result.structuredContent as {
      rules: string;
      ticketBundle: { primer: { markdown: string } };
    };
    expect(sc.rules).toBe(rules);
    expect(sc.rules).not.toContain('truncated');
    expect(sc.ticketBundle.primer.markdown.length).toBeLessThan(30_000);

    const cutPaths = (truncationOf(out.result)!.omitted as Array<{ path: string }>).map((o) => o.path);
    expect(cutPaths).toContain('ticketBundle.primer.markdown');
    expect(cutPaths).not.toContain('rules');
  });

  it('keeps the rules whole even when nothing else can be cut, and says so', () => {
    const rules = 'R'.repeat(60_000);
    const out = applyResponseBudget('orboto_session_start', result({ rules }));
    const sc = out.result.structuredContent as { rules: string };
    expect(sc.rules).toBe(rules);
    expect(truncationOf(out.result)!.atFloor).toBe(true);
  });

  it('protects the subtree, not just the exact key', () => {
    const out = applyResponseBudget('orboto_session_start', result({
      rules: 'short rules',
      ticketBundle: { note: 'N'.repeat(80_000) },
    }));
    const sc = out.result.structuredContent as { ticketBundle: { note: string } };
    expect(sc.ticketBundle.note.length).toBeLessThan(80_000);
  });
});

/**
 * ORB-1818 - the text half needs the same protection the structured half
 * has, for the one answer whose entire payload is the binding rules.
 */
describe('per-call text protection (ORB-1818)', () => {
  it('leaves BOTH halves whole, strips the marker, and says nothing was omitted', () => {
    const rules = 'R'.repeat(40_000);
    const marked: CallToolResult = {
      _meta: { [PROTECT_TEXT_META]: true },
      content: [{ type: 'text', text: rules }],
      structuredContent: { rules },
    };
    const out = applyResponseBudget('orboto_session_start', marked);

    expect(out.truncatedChars).toBe(0);
    expect((out.result.structuredContent as { rules: string }).rules).toBe(rules);
    const text = (out.result.content[0] as { text: string }).text;
    expect(text).toContain(rules);
    expect(text).not.toContain('Response truncated');
    expect(text).toContain('NOTHING was omitted');
    expect((out.result as { _meta?: unknown })._meta).toBeUndefined();
  });

  it('protects the text half only - unprotected structured leaves are still cut', () => {
    const marked: CallToolResult = {
      _meta: { [PROTECT_TEXT_META]: true },
      content: [{ type: 'text', text: 'short text' }],
      structuredContent: { rules: 'R'.repeat(20_000), primer: 'P'.repeat(20_000) },
    };
    const out = applyResponseBudget('orboto_session_start', marked);
    const sc = out.result.structuredContent as { rules: string; primer: string };
    expect(sc.rules).toBe('R'.repeat(20_000));
    expect(sc.primer.length).toBeLessThan(20_000);
    expect((out.result.content[0] as { text: string }).text).toContain('Response truncated');
  });

  it('an unmarked result still has its text half cut', () => {
    const out = applyResponseBudget('orboto_session_start', {
      content: [{ type: 'text', text: 'T'.repeat(40_000) }],
      structuredContent: { rules: 'R'.repeat(40_000) },
    });
    expect((out.result.content[0] as { text: string }).text.length).toBeLessThan(40_000);
  });
});

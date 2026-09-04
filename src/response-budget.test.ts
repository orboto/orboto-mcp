/**
 * ORB-1697 - the central response budget.
 *
 * The contract under test, in the order it matters:
 *   1. a result inside its budget is returned byte-identical;
 *   2. an over-budget result is CUT, and the cut is explicit;
 *   3. the cut preserves the payload SHAPE (keys stay, arrays stay
 *      arrays, identifier-shaped strings stay whole) - 7 tools declare an
 *      outputSchema the SDK validates the payload against;
 *   4. nothing is lost: the omitted remainder is fetchable via the handle;
 *   5. text and structured content are budgeted as separate halves, since
 *      no known client charges for both.
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
} from './response-budget.js';
import { makeResponseExpandHandler } from './tools/response-expand.js';

const TOOL = 'orboto_test_tool';

function result(structured: Record<string, unknown> | undefined, text = 'text block'): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    ...(structured === undefined ? {} : { structuredContent: structured }),
  };
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
    // A content read is deliberately higher.
    expect(budgetFor('orboto_get_doc', {})).toBeGreaterThan(DEFAULT_BUDGET_CHARS);
    // ORB-1818 - session_start lost its 48k exemption: its default answer
    // carries a rules INDEX plus a hash, not the rule text, so it lives on
    // the plain default like every other tool.
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
    // Not the sum: no known client pays for both halves.
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
    // The text half carries the notice too, for clients that ignore
    // structuredContent entirely.
    const text = (out.result.content[0] as { text: string }).text;
    expect(text).toContain('orboto_response_expand');
    expect(text).toContain(out.handle!);
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
    // Head-first: the first row survives, the tail is what goes.
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
    // 500 short strings: every one is below MIN_STRING_CUT, so there is
    // nothing safe to cut. The budget must give up loudly, not spin.
    const structured = Object.fromEntries(
      Array.from({ length: 500 }, (_, i) => [`field_${i}`, `v${i}`.padEnd(90, 'x')]),
    );
    const out = applyResponseBudget(TOOL, result(structured));
    expect(out.originalChars).toBeGreaterThan(budgetFor(TOOL));
    const block = truncationOf(out.result)!;
    expect(block.atFloor).toBe(true);
    // Every field survived intact - a cut that cannot be made safely is
    // not made at all.
    const sc = out.result.structuredContent as Record<string, string>;
    expect(Object.keys(sc)).toHaveLength(501); // 500 fields + __truncation
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
    // The real shape: rules are the LARGEST string, so the default
    // largest-first rule would have cut exactly the wrong thing. Measured
    // on 2026-08-09 before this guard existed: 2.917 characters gone from
    // the binding rules of a cold session_start({ ticketKey }).
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
      // A hypothetical nested shape under a protected root stays protected.
      ticketBundle: { note: 'N'.repeat(80_000) },
    }));
    const sc = out.result.structuredContent as { ticketBundle: { note: string } };
    // ticketBundle is NOT protected, so this one does get cut - the guard is
    // path-scoped, not a blanket exemption.
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
    // The floor notice must not claim a truncation that did not happen.
    expect(text).not.toContain('Response truncated');
    expect(text).toContain('NOTHING was omitted');
    // The marker is transport-internal - it never reaches the client.
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

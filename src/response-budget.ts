/**
 * ORB-1697 - the central MCP response budget.
 *
 * WHY THIS EXISTS
 * ---------------
 * An MCP tool result is not paid once. The client re-sends the whole
 * conversation on every subsequent request, so a result costs its size
 * TIMES the number of turns that follow it. The 2026-08-09 transcript
 * audit (6.453 real calls, 32 transcripts - see doc ORB-D20) measured
 * `list_agent_instructions` at 238 Mtok of carry cost from only THREE
 * calls, because 37k characters landed 15 % into a session and rode
 * along for the remaining 85 %.
 *
 * Two facts from that audit shape this module:
 *
 *  1. In Claude Code, only `structuredContent` reaches the model - the
 *     Markdown `content` block the handlers also build is dropped. So
 *     the budget MUST measure and cut the structured payload; cutting
 *     only the text would look like a fix and change nothing. Other
 *     clients do the opposite, so both are measured and both are cut.
 *  2. Per-tool discipline does not hold across 168 registered tools.
 *     The cap is applied once, in `with-metrics.ts`, which every tool
 *     is already registered through.
 *
 * CONTRACT
 * --------
 * Truncation is never silent. An over-budget result comes back with a
 * `__truncation` block naming every cut path, plus a handle, and the
 * omitted remainder stays fetchable via `orboto_response_expand` for
 * as long as the handle lives (in-process, 15 min, 16 payloads).
 *
 * Shrinking is shape-preserving: keys never disappear, arrays stay
 * arrays, and strings stay strings. That matters because 7 tools
 * declare an `outputSchema` the SDK validates the payload against.
 * Adding `__truncation` is safe (no schema uses `.strict()`, and Zod v3
 * accepts unknown keys), and identifier-shaped strings are protected by
 * MIN_STRING_CUT - a uuid (36) or a ticket key is far below it, so
 * `.uuid()` / `.url()` fields are never cut in half.
 *
 * This module never throws. A malformed payload returns unbudgeted
 * rather than failing the tool call.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** Default cap for a tool that does not declare its own. */
export const DEFAULT_BUDGET_CHARS = 4000;

/**
 * Per-tool overrides.
 *
 * The default (4k) suits cards and lists: a response that answers
 * "which of these do I open?" does not need more. Two categories
 * legitimately need more and are raised deliberately:
 *
 *  - CONTENT READS. The caller explicitly asked for a document, a
 *    generated report or a primer. Cutting those to 4k would break the
 *    tool's purpose rather than remove waste.
 *
 * `orboto_session_start` used to be the third category at 48.000
 * characters, and ORB-1818 removed that exemption: the digest now
 * answers with a rules INDEX plus a hash instead of the full rule text,
 * so the default answer fits the 4k default like every other tool. The
 * two answers that DO carry the full rules (`forceRules: true`,
 * `rulesOnly: true`) protect them instead of buying size - see
 * PROTECTED_PATHS and PROTECT_TEXT_META below.
 */
export const TOOL_BUDGET_CHARS: Record<string, number> = {
  orboto_get_project_primer: 16_000,
  orboto_get_doc: 16_000,
  orboto_get_doc_revision: 16_000,
  orboto_export_doc_md: 16_000,
  orboto_ask_docs: 12_000,
  orboto_wiki_ask: 12_000,
  orboto_customer_report: 16_000,
  orboto_requirements_spec: 16_000,
  orboto_get_attachment: 16_000,
  // The continuation tool itself: a chunk is served AT the budget, so a
  // cap equal to the default would truncate the chunk it just sized.
  orboto_response_expand: 8_000,
  // ORB-1518 - detail mode returns a full endpoint schema (parameters +
  // request body + responses), which is the content the caller asked
  // for; 4k would cut most real schemas in half.
  orboto_api_search: 8_000,
  // ORB-1519 - the proxy envelope IS the content the caller asked for
  // (an arbitrary endpoint's response); the proxy already caps it, this
  // budget keeps the MCP-side carry cost bounded on top.
  orboto_api_call: 8_000,
};

/**
 * Paths the shrinker must never touch, per tool.
 *
 * The shrinker cuts the LARGEST leaf first, which is the right default and
 * exactly wrong for one case: in `session_start` the largest string is the
 * workspace's binding rules. Truncating a mandatory rule to save context is
 * worse than paying for it - an agent that never sees the second half of a
 * rule breaks it silently. Measured on 2026-08-09: a cold
 * `session_start({ ticketKey })` is 47.694 characters, and without this
 * list the budget cut 2.917 characters out of the rules block.
 *
 * A protected path is not exempt from the budget - the shrinker moves on to
 * the next-largest cuttable leaf (for that call: the project primer, which
 * is a digest with its own server-side budget and is safe to cut
 * explicitly). If nothing else can be cut, the response reports
 * `atFloor: true` and stays whole.
 */
export const PROTECTED_PATHS: Record<string, string[]> = {
  orboto_session_start: ['rules'],
};

/**
 * ORB-1818 - per-call protection of the TEXT half.
 *
 * PROTECTED_PATHS covers the structured half, which is what Claude Code
 * pays for; a text-only client pays the Markdown block instead, and that
 * half is cut on a line boundary with no notion of protected paths. For
 * an answer whose whole payload IS the binding rules (`session_start`
 * with `forceRules` or `rulesOnly`), cutting either half truncates a
 * mandatory rule - the exact thing the protection above exists to
 * prevent, just for the other client class.
 *
 * A handler marks such a result by setting `result._meta[PROTECT_TEXT_META]
 * = true`. The flag is READ AND REMOVED here, so it never reaches the
 * wire. It protects; it does not exempt: unprotected structured leaves in
 * the same result are still cut normally.
 *
 * This is deliberately not a general "skip the budget" escape hatch -
 * `protect-text-usage.test.ts` fails the build if a file other than the
 * session-start tool sets it.
 */
export const PROTECT_TEXT_META = 'orboto/protectText';

function takeProtectTextFlag(result: CallToolResult): boolean {
  const meta = (result as { _meta?: Record<string, unknown> })._meta;
  if (!meta || meta[PROTECT_TEXT_META] !== true) return false;
  delete meta[PROTECT_TEXT_META];
  if (Object.keys(meta).length === 0) delete (result as { _meta?: unknown })._meta;
  return true;
}

/**
 * Never cut a string shorter than this. Keeps identifiers, keys, urls,
 * hashes and short labels intact - the things a caller feeds back into
 * another call, and the things `outputSchema` validators constrain.
 */
const MIN_STRING_CUT = 200;
/** A cut string always keeps at least this much of its head. */
const MIN_STRING_KEEP = 160;
/** An array is never cut below this many items. */
const MIN_ARRAY_KEEP = 1;
/** Arrays shorter than this are left alone (cutting 2 to 1 buys nothing). */
const MIN_ARRAY_CUT = 3;
/** Bound the cut loop; each pass removes the current largest offender. */
const MAX_CUT_PASSES = 64;

export const HANDLE_TTL_MS = 15 * 60 * 1000;
export const MAX_HANDLES = 16;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * `ORBOTO_MCP_RESPONSE_BUDGET=off` disables the cap entirely (escape
 * hatch for a client that genuinely wants everything);
 * `ORBOTO_MCP_RESPONSE_BUDGET_CHARS=<n>` overrides the default cap.
 * Per-tool overrides above still apply on top of a custom default.
 */
export function budgetEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.ORBOTO_MCP_RESPONSE_BUDGET ?? '').toLowerCase() !== 'off';
}

export function budgetFor(toolName: string, env: NodeJS.ProcessEnv = process.env): number {
  const perTool = TOOL_BUDGET_CHARS[toolName];
  if (perTool !== undefined) return perTool;
  const raw = Number(env.ORBOTO_MCP_RESPONSE_BUDGET_CHARS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_BUDGET_CHARS;
}

// ---------------------------------------------------------------------------
// Measurement - what the client actually pays for
// ---------------------------------------------------------------------------

function textOf(part: unknown): string | null {
  if (part && typeof part === 'object' && 'text' in part) {
    const t = (part as { text?: unknown }).text;
    if (typeof t === 'string') return t;
  }
  return null;
}

/**
 * The two halves a result is made of, measured separately.
 *
 * A handler returns the SAME data twice: `structuredContent` for
 * schema-aware clients and a Markdown text block for the rest. No known
 * client charges for both - Claude Code stores only the structured JSON
 * in its transcript (verified 2026-08-09), text-only clients see just the
 * text - so summing them would double-count and cut twice as hard as the
 * cost justifies. The budget is therefore enforced on each half, and the
 * reported cost is the larger of the two: what one client actually pays.
 */
export function measureHalves(result: CallToolResult): { textChars: number; structuredChars: number } {
  let textChars = 0;
  for (const part of result.content ?? []) {
    const t = textOf(part);
    textChars += t !== null ? t.length : safeStringify(part).length;
  }
  const structuredChars = result.structuredContent === undefined
    ? 0
    : safeStringify(result.structuredContent).length;
  return { textChars, structuredChars };
}

/** Characters the heaviest single client pays for this result. */
export function measureResult(result: CallToolResult): number {
  const { textChars, structuredChars } = measureHalves(result);
  return Math.max(textChars, structuredChars);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// The in-process payload store behind the truncation handles
// ---------------------------------------------------------------------------

export interface StoredPayload {
  toolName: string;
  storedAt: number;
  /** The FULL payload as the handler produced it, pre-truncation. */
  structuredContent?: unknown;
  text: string;
  /** What was cut - filled in once the shrink pass is done, so
   *  `orboto_response_expand` can list the paths without a `path` input. */
  omitted?: OmittedEntry[];
}

const handles = new Map<string, StoredPayload>();

function pruneHandles(now: number): void {
  for (const [key, value] of handles) {
    if (now - value.storedAt > HANDLE_TTL_MS) handles.delete(key);
  }
  // Map iteration order is insertion order, so the oldest entries go first.
  while (handles.size > MAX_HANDLES) {
    const oldest = handles.keys().next();
    if (oldest.done) break;
    handles.delete(oldest.value);
  }
}

export function storePayload(toolName: string, payload: Omit<StoredPayload, 'toolName' | 'storedAt'>, now = Date.now()): string {
  const handle = randomUUID().slice(0, 8);
  handles.set(handle, { toolName, storedAt: now, ...payload });
  pruneHandles(now);
  return handle;
}

export function readPayload(handle: string, now = Date.now()): StoredPayload | null {
  pruneHandles(now);
  return handles.get(handle) ?? null;
}

/** Record what the shrink pass cut, so the expand tool can list the paths. */
export function annotatePayload(handle: string, omitted: OmittedEntry[]): void {
  const stored = handles.get(handle);
  if (stored) stored.omitted = omitted;
}

/** Test seam - the store is process-global by design. */
export function resetPayloadStore(): void {
  handles.clear();
}

// ---------------------------------------------------------------------------
// Path addressing - `ticketBundle.primer.markdown`, `comments[3].body`
// ---------------------------------------------------------------------------

export function resolvePath(root: unknown, path: string): unknown {
  if (path === '' || path === '$') return root;
  let current: unknown = root;
  // Split on `.` and `[i]` in one pass so both forms address the same tree.
  for (const token of path.split(/\.|(?=\[)/)) {
    if (current === null || current === undefined) return undefined;
    const arrayIndex = /^\[(\d+)\]$/.exec(token);
    if (arrayIndex) {
      if (!Array.isArray(current)) return undefined;
      current = current[Number(arrayIndex[1])];
      continue;
    }
    if (token === '') continue;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}

// ---------------------------------------------------------------------------
// The shrinker
// ---------------------------------------------------------------------------

type CutKind = 'string' | 'array';

interface Candidate {
  path: string;
  kind: CutKind;
  /** Serialized size - what cutting this actually saves. */
  size: number;
  parent: Record<string, unknown> | unknown[];
  key: string | number;
  value: string | unknown[];
}

/** Collect every cuttable leaf, largest first. `protected` paths are skipped
 *  entirely (see PROTECTED_PATHS) - including their subtrees, so protecting a
 *  parent protects what hangs off it. */
function collectCandidates(root: unknown, protectedPaths: string[] = []): Candidate[] {
  const out: Candidate[] = [];
  const isProtected = (path: string) =>
    protectedPaths.some((p) => path === p || path.startsWith(`${p}.`) || path.startsWith(`${p}[`));
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      // Never cut the truncation metadata itself - it is the way back.
      if (key === '__truncation') continue;
      const childPath = path ? `${path}.${key}` : key;
      if (isProtected(childPath)) continue;
      if (typeof value === 'string') {
        if (value.length >= MIN_STRING_CUT) {
          out.push({
            path: childPath, kind: 'string', size: value.length,
            parent: node as Record<string, unknown>, key, value,
          });
        }
        continue;
      }
      if (Array.isArray(value)) {
        if (value.length >= MIN_ARRAY_CUT) {
          out.push({
            path: childPath, kind: 'array', size: safeStringify(value).length,
            parent: node as Record<string, unknown>, key, value,
          });
        }
        value.forEach((item, index) => walk(item, `${childPath}[${index}]`));
        continue;
      }
      walk(value, childPath);
    }
  };
  walk(root, '');
  return out.sort((a, b) => b.size - a.size);
}

export interface OmittedEntry {
  path: string;
  kind: CutKind;
  omittedChars?: number;
  omittedItems?: number;
  keptItems?: number;
}

// ORB-1738 - the ADVERTISED zod shape of the marker, consumed centrally in
// registerWithMetrics: every declared outputSchema is extended with an
// optional `__truncation` so strict clients (which validate structured
// content against the advertised JSON schema, additionalProperties:false)
// accept over-budget responses. Keep in lockstep with TruncationBlock.
export const TruncationBlockSchema = z.object({
  handle: z.string(),
  budgetChars: z.number(),
  originalChars: z.number(),
  omittedChars: z.number(),
  omitted: z.array(z.object({
    path: z.string(),
    kind: z.string(),
    omittedChars: z.number().optional(),
    omittedItems: z.number().optional(),
    keptItems: z.number().optional(),
  })),
  howToGetTheRest: z.string(),
  atFloor: z.boolean().optional(),
});

/**
 * ORB-1805 - what registerWithMetrics actually advertises.
 *
 * `TruncationBlockSchema` above is the exact runtime shape (and stays the
 * validator the tests assert against), but serialising all eight of its
 * fields costs ~620 characters in EVERY tool that declares an
 * outputSchema - 14 tools in the full manifest, 5 in the curated one -
 * for a block a caller only ever reads. The advertised form declares the
 * one field a caller acts on (`handle`) and stays open for the rest, so
 * a strict client still accepts an over-budget payload (ORB-1738, the
 * reason the marker is advertised at all) at a third of the bytes.
 *
 * Strictly more permissive than TruncationBlockSchema, so nothing that
 * validated before can fail now.
 */
export const TruncationBlockAdvertisedSchema = z.object({ handle: z.string() })
  .passthrough()
  .describe('Response was cut; pass `handle` to orboto_response_expand.');

export interface TruncationBlock {
  handle: string;
  budgetChars: number;
  originalChars: number;
  omittedChars: number;
  omitted: OmittedEntry[];
  howToGetTheRest: string;
  /** True when the payload is still over budget after every safe cut. */
  atFloor?: boolean;
}

export interface BudgetOutcome {
  result: CallToolResult;
  /** Characters the client pays AFTER the budget was applied. */
  responseChars: number;
  /** Characters the handler produced. */
  originalChars: number;
  /** originalChars - responseChars; 0 when nothing was cut. */
  truncatedChars: number;
  handle?: string;
}

function stringMarker(omitted: number, handle: string, path: string): string {
  return `... [truncated ${omitted} chars - full value: orboto_response_expand handle="${handle}" path="${path}"]`;
}

/**
 * Cap a tool result at its budget. Returns the (possibly rewritten)
 * result plus the numbers `with-metrics.ts` reports to
 * `/admin/mcp/instrument`, so budget pressure stays visible in the
 * admin MCP-usage panel instead of needing another transcript audit.
 */
export function applyResponseBudget(
  toolName: string,
  result: CallToolResult,
  env: NodeJS.ProcessEnv = process.env,
): BudgetOutcome {
  // ORB-1818 - read (and strip) the per-call text protection before
  // anything else, so the flag never rides the wire even on the
  // under-budget path.
  const protectText = takeProtectTextFlag(result);
  const originalChars = measureResult(result);
  if (!budgetEnabled(env)) {
    return { result, responseChars: originalChars, originalChars, truncatedChars: 0 };
  }
  const budget = budgetFor(toolName, env);
  if (originalChars <= budget) {
    return { result, responseChars: originalChars, originalChars, truncatedChars: 0 };
  }

  try {
    return shrink(toolName, result, budget, originalChars, protectText);
  } catch {
    // A budget must never break a tool call. Report the real size so the
    // panel still shows the pressure, and hand back the untouched result.
    return { result, responseChars: originalChars, originalChars, truncatedChars: 0 };
  }
}

function shrink(
  toolName: string,
  result: CallToolResult,
  budget: number,
  originalChars: number,
  protectText = false,
): BudgetOutcome {
  const fullText = (result.content ?? [])
    .map((part) => textOf(part) ?? '')
    .join('\n');
  const handle = storePayload(toolName, {
    structuredContent: result.structuredContent,
    text: fullText,
  });

  const omitted: OmittedEntry[] = [];
  const structured: unknown = result.structuredContent === undefined
    ? undefined
    : (JSON.parse(safeStringify(result.structuredContent)) as unknown);

  // Reserve room for the truncation block and the text notice so the
  // final measurement lands under budget, not just near it.
  const RESERVE = 700;
  const target = Math.max(MIN_STRING_KEEP, budget - RESERVE);

  // Each half is capped against the same target - see measureHalves().
  const measure = (): number => (structured === undefined ? 0 : safeStringify(structured).length);

  // The text half: cut on a line boundary so a reader never gets half a
  // sentence, and record how much was dropped.
  let currentTextLength = fullText.length;
  let textOmitted = 0;
  if (!protectText && fullText.length > target) {
    const boundary = fullText.lastIndexOf('\n', target);
    currentTextLength = boundary > MIN_STRING_KEEP ? boundary : target;
    textOmitted = fullText.length - currentTextLength;
  }

  let passes = 0;
  while (structured !== undefined && measure() > target && passes < MAX_CUT_PASSES) {
    passes += 1;
    const candidates = collectCandidates(structured, PROTECTED_PATHS[toolName] ?? []);
    const largest = candidates[0];
    if (!largest) break;

    const overshoot = measure() - target;
    if (largest.kind === 'string') {
      const value = largest.value as string;
      const marker = stringMarker(0, handle, largest.path).length + 8;
      const keep = Math.max(MIN_STRING_KEEP, value.length - overshoot - marker);
      if (keep >= value.length) break;
      const omittedChars = value.length - keep;
      (largest.parent as Record<string, unknown>)[largest.key as string] =
        value.slice(0, keep) + stringMarker(omittedChars, handle, largest.path);
      omitted.push({ path: largest.path, kind: 'string', omittedChars });
      continue;
    }

    const items = largest.value as unknown[];
    // Drop from the tail: list tools order by relevance, so the head is
    // the part a caller reads first.
    let keptItems = items.length;
    while (keptItems > MIN_ARRAY_KEEP) {
      const trial = items.slice(0, keptItems - 1);
      keptItems -= 1;
      if (safeStringify(trial).length <= Math.max(0, safeStringify(items).length - overshoot)) break;
    }
    if (keptItems >= items.length) break;
    (largest.parent as Record<string, unknown>)[largest.key as string] = items.slice(0, keptItems);
    omitted.push({
      path: largest.path,
      kind: 'array',
      keptItems,
      omittedItems: items.length - keptItems,
    });
  }

  const allOmitted: OmittedEntry[] = textOmitted > 0
    ? [...omitted, { path: '$text', kind: 'string', omittedChars: textOmitted }]
    : omitted;
  annotatePayload(handle, allOmitted);


  const atFloor = measure() > target;
  // ORB-1818 - the floor case gets its OWN notice. Telling an agent its
  // response was truncated when nothing was cut sends it hunting for a
  // remainder that does not exist - and that is exactly what a protected
  // answer (the binding rules) produces every time.
  const notice = allOmitted.length > 0
    ? `[Response truncated to the MCP response budget (${budget} chars) - it would otherwise cost `
      + `${originalChars} chars on EVERY later request in this session. Omitted content is not lost: `
      + `call orboto_response_expand with handle "${handle}" and one of the paths in __truncation.omitted.]`
    : `[Response is ${originalChars} chars, over the MCP response budget (${budget} chars), and nothing in it `
      + 'could be cut safely - it is protected or uncuttable content. NOTHING was omitted; there is no remainder to fetch.]';

  if (structured !== undefined && structured !== null && typeof structured === 'object' && !Array.isArray(structured)) {
    const block: TruncationBlock = {
      handle,
      budgetChars: budget,
      originalChars,
      omittedChars: 0, // filled in below, once the final size is known
      omitted: allOmitted,
      howToGetTheRest:
        `Call orboto_response_expand { handle: "${handle}", path: "<one of omitted[].path>" } for the omitted `
        + 'remainder. Omit `path` to list what is available. The handle expires 15 minutes after this call.',
      ...(atFloor ? { atFloor: true } : {}),
    };
    (structured as Record<string, unknown>).__truncation = block;
    // The cost model is per-half (see measureHalves), so what was omitted
    // is the shrinkage of the half that dominates the price.
    const finalChars = Math.max(
      safeStringify(structured).length,
      currentTextLength + notice.length + 2,
    );
    block.omittedChars = Math.max(0, originalChars - finalChars);
  }

  // Rebuild the content parts: the (possibly shortened) text plus the notice.
  const shortenedText = currentTextLength >= fullText.length
    ? fullText
    : fullText.slice(0, currentTextLength);
  const content: CallToolResult['content'] = fullText.length > 0
    ? [{ type: 'text', text: `${shortenedText}\n\n${notice}` }]
    : [{ type: 'text', text: notice }];
  // Non-text parts (images, resources) are never cut - they are not the
  // bloat this budget is about, and slicing their payload would corrupt them.
  const nonText = (result.content ?? []).filter((part) => textOf(part) === null);

  const shrunk: CallToolResult = {
    ...result,
    content: [...content, ...nonText],
    ...(structured === undefined ? {} : { structuredContent: structured as Record<string, unknown> }),
  };
  const responseChars = measureResult(shrunk);
  return {
    result: shrunk,
    responseChars,
    originalChars,
    truncatedChars: Math.max(0, originalChars - responseChars),
    handle,
  };
}

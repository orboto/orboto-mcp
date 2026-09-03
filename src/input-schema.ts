/**
 * ORB-1692 - strict tool inputs + the aliases agents actually send.
 *
 * Measured across 32 transcripts: 55.6% of all MCP errors were "Required"
 * validation failures where the agent guessed a plausible-but-wrong
 * parameter name (`body` for `text`, `parentKey` for `parentTicketKey`,
 * ...). Worse, zod strips unknown keys by default, so a wrong key on an
 * otherwise-valid call VANISHED silently - `create_ticket` with
 * `parentKey` created ORB-1684 with no parent and no warning.
 *
 * Fix, applied centrally at registration (with-metrics `reg()`):
 *  1. every tool input becomes `.strict()` - an unknown key errors,
 *     naming the offender;
 *  2. the measured aliases resolve silently to the canonical field via a
 *     GUARDED global rename: `alias -> canonical` fires only when the
 *     canonical field exists in that tool's shape, the alias does not,
 *     and the caller did not also send the canonical - so a tool whose
 *     REAL field is `body` (agent-instruction blocks) is never touched;
 *  3. `orboto_update_ticket` folds flat patch fields into `patch` when no
 *     `patch` was sent - agents routinely write `{ticketKey, description}`.
 *
 * ORB-1817 - "we do not force keys that make no sense - key and query are
 * sensible names" (operator). Extends the alias table with the sensible
 * spellings a caller actually reaches for (`key`, `query`, `projectId`,
 * ...) plus one DYNAMIC alias - `id` resolves to the tool's own single
 * id-shaped parameter (`ticketKey` / `docId` / `milestone` / `commentId`)
 * only when exactly one of those exists in that tool's shape - and adds a
 * teaching error: when a call still can't be resolved, the thrown message
 * is a structured JSON block naming every parameter the tool accepts plus
 * a Levenshtein<=2 guess for each unrecognized key (same distance the mjs
 * wrapper's `suggestFlag` uses for `--flag` typos). The failure is also
 * logged through the same `/admin/mcp/instrument` path a handler error
 * uses - see the module doc on `mcp-instrument.ts` for why that needs a
 * dedicated leaf module instead of importing from with-metrics.ts.
 *
 * SDK mechanics: `registerTool` accepts either a raw shape or a zod
 * schema. A top-level `z.preprocess(...)` has no `.shape`, which would
 * make the SDK advertise an EMPTY input schema in tools/list. Stamping
 * the inner object's `.shape` onto the effects schema keeps the
 * advertisement byte-identical to the strict object (verified: the SDK's
 * `normalizeObjectSchema` only checks `.shape !== undefined`, and its
 * json-schema emitter unwraps effects with pipeStrategy "input").
 *
 * ORB-1817 - the preprocess callback is also where the teaching error is
 * thrown (verified against @modelcontextprotocol/sdk 1.29's zod-compat +
 * server/mcp.js): a `preprocess` effect calls `effect.transform(data,
 * checkCtx)` BEFORE the inner schema ever parses, and unlike `refine` /
 * `transform`, a synchronous throw from inside it is NOT caught by zod -
 * it propagates out of `ZodEffects._parse`, out of the SDK's
 * `safeParseAsync` (converted to a rejected promise, since that's an
 * `async function`), and lands in the SDK's own `CallToolRequestSchema`
 * handler's outer try/catch, which for a plain (non-McpError) `Error`
 * returns `{isError: true, content: [{type: 'text', text: error.message}]}`
 * with NO extra wrapping. That is what lets us hand back exactly our
 * structured JSON with nothing else attached - `.superRefine()` cannot do
 * this (it never even runs once the base object parse has already failed,
 * which is the common case: a missing-required or unrecognized-key input).
 */
import { z } from 'zod';
import type { OrbotoClient } from './orboto-client.js';
import { postLogEntry, redactSecrets } from './mcp-instrument.js';

/**
 * alias -> canonical. Applied to every tool, guarded by the tool's own
 * shape (see module doc). Sourced from the ORB-1692 / ORB-1817 measurement
 * tables - extend it when a NEW misfire class shows up in the
 * mcp_call_log, not speculatively.
 */
export const GLOBAL_INPUT_ALIASES: Record<string, string> = {
  body: 'text',
  parentKey: 'parentTicketKey',
  dependsOnTicketKey: 'dependsOnKey',
  docKey: 'docId',
  status: 'statusCategory',
  milestoneKey: 'milestone',
  ticket: 'ticketKey',
  project: 'projectKey',
  // ORB-1817 - measured 2026-09-03: both cost one retry in the same
  // session. "key" and "query" are what a reasonable caller types.
  key: 'ticketKey',
  query: 'oql',
  projectId: 'projectKey',
  milestoneId: 'milestone',
  comment: 'text',
  message: 'text',
  // Bulk tools all take `ticketKeys` (plural) - singular-sounding `keys`
  // is the natural typo/guess.
  keys: 'ticketKeys',
  max: 'limit',
  page: 'cursor',
};

/** ORB-1817 - `id` has no single canonical target across tools (it's
 *  `ticketKey` on a ticket tool, `docId` on a doc tool, ...), so it can't
 *  be a static GLOBAL_INPUT_ALIASES entry. Resolved dynamically: only
 *  when the tool's shape has EXACTLY ONE of these, and only when the
 *  caller didn't already send it explicitly. Two or zero matches leave
 *  `id` alone so the strict error - now the teaching error - explains why. */
const ID_LIKE_CANONICALS = ['ticketKey', 'docId', 'milestone', 'commentId'] as const;

/** The flat fields orboto_update_ticket folds into `patch` (ORB-1692 #3). */
const UPDATE_TICKET_PATCH_KEYS = [
  'title', 'description', 'customerSummary', 'type', 'priority',
  'deliveryMode', 'dueDate', 'startDate', 'isPrivate', 'estimatedTimeMinutes',
] as const;

function applyAliases(toolName: string, shape: z.ZodRawShape, value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  let out = value as Record<string, unknown>;

  for (const [alias, canonical] of Object.entries(GLOBAL_INPUT_ALIASES)) {
    if (
      alias in out &&
      !(canonical in out) &&
      canonical in shape &&
      !(alias in shape)
    ) {
      const { [alias]: aliased, ...rest } = out;
      out = { ...rest, [canonical]: aliased };
    }
  }

  // ORB-1817 - `id` -> the tool's single id-shaped parameter.
  if ('id' in out && !('id' in shape)) {
    const candidates = ID_LIKE_CANONICALS.filter((c) => c in shape && !(c in out));
    if (candidates.length === 1) {
      const canonical = candidates[0];
      const { id, ...rest } = out;
      out = { ...rest, [canonical]: id };
    }
  }

  // update_ticket: flat fields become an implicit patch. Only when the
  // caller sent no patch at all - a partial patch plus flat extras stays
  // an error (ambiguous intent must not be guessed).
  if (toolName === 'orboto_update_ticket' && !('patch' in out)) {
    const patch: Record<string, unknown> = {};
    let rest: Record<string, unknown> = {};
    let folded = false;
    for (const [k, v] of Object.entries(out)) {
      if ((UPDATE_TICKET_PATCH_KEYS as readonly string[]).includes(k)) {
        patch[k] = v;
        folded = true;
      } else {
        rest[k] = v;
      }
    }
    if (folded) out = { ...rest, patch };
  }

  return out;
}

// ---------------------------------------------------------------------------
// ORB-1817 - teaching error: structured `expected` block + closest-name
// guess, built when the strict + alias-resolved value STILL doesn't parse.
// ---------------------------------------------------------------------------

/** Levenshtein-1/2 match, same algorithm skills/orboto/scripts/orboto.mjs
 *  uses for `--flag` typos (`suggestFlag` / `levenshtein`) - keep them in
 *  sync if the distance metric ever changes. */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function closestName(typed: string, candidates: string[], maxDistance = 2): string | undefined {
  const near = candidates.filter((c) => levenshtein(typed, c) <= maxDistance);
  return near.sort((a, b) => levenshtein(typed, a) - levenshtein(typed, b))[0];
}

interface ParamDoc {
  name: string;
  type: string;
  required: boolean;
  description?: string;
}

/** Peel ZodOptional / ZodDefault / ZodNullable to name the underlying
 *  type; everything else maps to a short lowercase type name so the
 *  block stays compact (this is for a tool-calling model, not a schema
 *  viewer). */
function describeZodType(schema: z.ZodTypeAny): string {
  const def = (schema as unknown as {
    _def: { typeName: string; innerType?: z.ZodTypeAny; values?: unknown[] };
  })._def;
  switch (def.typeName) {
    case 'ZodOptional':
    case 'ZodDefault':
    case 'ZodNullable':
      return def.innerType ? describeZodType(def.innerType) : 'unknown';
    case 'ZodString': return 'string';
    case 'ZodNumber': return 'number';
    case 'ZodBoolean': return 'boolean';
    case 'ZodArray': return 'array';
    case 'ZodObject': return 'object';
    case 'ZodEnum': return `enum(${(def.values as string[] ?? []).join('|')})`;
    case 'ZodUnion': return 'union';
    default: return def.typeName.replace(/^Zod/, '').toLowerCase() || 'unknown';
  }
}

function describeShape(shape: z.ZodRawShape): ParamDoc[] {
  return Object.entries(shape)
    .map(([name, schema]) => ({
      name,
      type: describeZodType(schema),
      required: !schema.isOptional(),
      description: schema.description,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Build the teaching-error message: ONE structured JSON block, not prose.
 * `code: -32602` mirrors the JSON-RPC "invalid params" code the SDK would
 * otherwise bury inside its own generic zod-issue dump.
 */
function buildTeachingError(
  toolName: string,
  shape: z.ZodRawShape,
  issues: z.ZodIssue[],
): string {
  const validNames = Object.keys(shape);

  const unrecognized: string[] = [];
  const missing: string[] = [];
  for (const issue of issues) {
    if (issue.code === 'unrecognized_keys') unrecognized.push(...issue.keys);
    if (issue.code === 'invalid_type' && issue.received === 'undefined' && issue.path.length === 1) {
      missing.push(String(issue.path[0]));
    }
  }

  const didYouMean: Record<string, string> = {};
  for (const key of unrecognized) {
    const guess = closestName(key, validNames);
    if (guess) didYouMean[key] = guess;
  }

  const summary = unrecognized.length > 0
    ? `Unrecognized parameter(s) for ${toolName}: ${unrecognized.join(', ')}.`
    : missing.length > 0
      ? `Missing required parameter(s) for ${toolName}: ${missing.join(', ')}.`
      : `Invalid arguments for ${toolName}.`;

  return JSON.stringify({
    code: -32602,
    error: summary,
    expected: {
      tool: toolName,
      parameters: describeShape(shape),
    },
    unrecognized: unrecognized.length ? unrecognized : undefined,
    missing: missing.length ? missing : undefined,
    didYouMean: Object.keys(didYouMean).length ? didYouMean : undefined,
  });
}

/**
 * Wrap a raw tool shape into the strict + alias-resolving schema the SDK
 * validates against. Returns a schema whose `.shape` is stamped so
 * tools/list advertisement stays identical to the plain object form.
 *
 * `client` + `clientHint` are optional (tests construct schemas without
 * them) - when present, a validation failure that survives aliasing is
 * logged through the SAME `/admin/mcp/instrument` path a handler error
 * uses (ORB-1817 Part C), because the SDK validates input BEFORE
 * with-metrics.ts's handler wrapper ever runs - this preprocess step is
 * the only place that ever sees the failure.
 */
export function buildStrictInputSchema(
  toolName: string,
  shape: z.ZodRawShape,
  client?: OrbotoClient,
  clientHint?: string,
): z.ZodTypeAny {
  const inner = z.object(shape).strict();
  const effects = z.preprocess((value) => {
    const start = Date.now();
    const aliased = applyAliases(toolName, shape, value);
    const parsed = inner.safeParse(aliased);
    if (parsed.success) return aliased;

    const message = buildTeachingError(toolName, shape, parsed.error.issues);
    if (client) {
      void postLogEntry(client, {
        toolName,
        durationMs: Date.now() - start,
        success: false,
        statusCode: -32602,
        errorMessage: redactSecrets(message).slice(0, 500),
        clientHint,
      });
    }
    // See the module doc: thrown here (inside a "preprocess" effect, not
    // a refinement/transform), this is NOT caught by zod - it becomes the
    // exact isError text the caller sees.
    throw new Error(message);
  }, inner);
  // SDK contract (see module doc): .shape must exist for advertisement.
  (effects as unknown as { shape: z.ZodRawShape }).shape = inner.shape;
  return effects;
}

/** True when the value is a raw shape (plain record of zod schemas), not a schema instance. */
export function isRawShape(value: unknown): value is z.ZodRawShape {
  if (!value || typeof value !== 'object') return false;
  if ((value as { _def?: unknown })._def !== undefined) return false;
  const entries = Object.values(value);
  return entries.length > 0 && entries.every(
    (v) => typeof v === 'object' && v !== null && (v as { _def?: unknown })._def !== undefined,
  );
}

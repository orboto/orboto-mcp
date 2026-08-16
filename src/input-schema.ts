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
 * SDK mechanics: `registerTool` accepts either a raw shape or a zod
 * schema. A top-level `z.preprocess(...)` has no `.shape`, which would
 * make the SDK advertise an EMPTY input schema in tools/list. Stamping
 * the inner object's `.shape` onto the effects schema keeps the
 * advertisement byte-identical to the strict object (verified: the SDK's
 * `normalizeObjectSchema` only checks `.shape !== undefined`, and its
 * json-schema emitter unwraps effects with pipeStrategy "input").
 */
import { z } from 'zod';

/**
 * alias -> canonical. Applied to every tool, guarded by the tool's own
 * shape (see module doc). Sourced from the ORB-1692 measurement table -
 * extend it when a NEW misfire class shows up in the mcp_call_log, not
 * speculatively.
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
};

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

/**
 * Wrap a raw tool shape into the strict + alias-resolving schema the SDK
 * validates against. Returns a schema whose `.shape` is stamped so
 * tools/list advertisement stays identical to the plain object form.
 */
export function buildStrictInputSchema(toolName: string, shape: z.ZodRawShape): z.ZodTypeAny {
  const inner = z.object(shape).strict();
  const effects = z.preprocess((value) => applyAliases(toolName, shape, value), inner);
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

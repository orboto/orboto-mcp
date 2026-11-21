import { z } from 'zod';
import { codePointLength, isPrintableLine } from './printable-text.js';

/** ORB-3174 - mirror of @orboto/shared-schema printable-line.ts (drift test in apps/api/src/test/orb-3174-printable-text.test.ts), without PRINTABLE_LINE_RULE in the descriptions, which the tool manifest has no room for. The zod message of a value that is no printable line; the API answers it as 400 `errors.common.unprintable_text`. */
export const PRINTABLE_LINE_MESSAGE = 'a single line of printable characters';

/** ORB-3174 - the rule every printable field states in its description, so the spec says what the server enforces. */
export const PRINTABLE_LINE_RULE = 'Single line; no control, format or line-separator characters.';

/** ORB-3162, ORB-3174 - a request field of one printable line of at most `max` code points (the spec's maxLength), trimmed first with `trim`; refinements, so no pattern reaches a tool manifest. */
export function printableLineSchema(max: number, opts: { trim?: boolean; min?: number; describe?: string } = {}) {
  const base = opts.trim ? z.string().trim() : z.string();
  return (opts.min ? base.min(opts.min) : base).max(max * 2)
    .refine((value) => codePointLength(value) <= max, `at most ${max} characters`)
    .refine(isPrintableLine, PRINTABLE_LINE_MESSAGE)
    .meta(opts.describe ? { maxLength: max, description: opts.describe } : { maxLength: max });
}

/**
 * ORB-3174 - the bound of each free-text field a heartbeat's clientInfo carries: a host is a DNS name (253) or a
 * POSIX host name (255); a runtime name is a harness name, an MCP client label (`name@version`) or an instance token
 * label (60), 200 leaves room; a version is a semver with a build suffix; a user agent of a browser runs to 300.
 */
export const AGENT_CLIENT_TEXT_MAX = {
  name: 200, version: 100, host: 255, user_agent: 500, runner: 60, channel: 40, claudeAccount: 64, claudeProfile: 64, capability: 100,
} as const;

/** ORB-3174 - the free-text fields of a heartbeat's clientInfo, each one printable line within its bound. */
export const AgentHeartbeatClientTextSchema = z.object({
  name: printableLineSchema(AGENT_CLIENT_TEXT_MAX.name).optional(),
  version: printableLineSchema(AGENT_CLIENT_TEXT_MAX.version).optional(),
  host: printableLineSchema(AGENT_CLIENT_TEXT_MAX.host).optional(),
  user_agent: printableLineSchema(AGENT_CLIENT_TEXT_MAX.user_agent).optional(),
  /** ORB-2553 - a runner names itself; its row is listed without a declared scope. */
  runner: printableLineSchema(AGENT_CLIENT_TEXT_MAX.runner).optional(),
  /** ORB-2140 - the wake channel this instance announced (`claude-code`). */
  channel: printableLineSchema(AGENT_CLIENT_TEXT_MAX.channel).optional(),
  /** ORB-2729 - the Claude account UUID and orboto profile the session's status line reported. */
  claudeAccount: printableLineSchema(AGENT_CLIENT_TEXT_MAX.claudeAccount).optional(),
  claudeProfile: printableLineSchema(AGENT_CLIENT_TEXT_MAX.claudeProfile).optional(),
});

/** ORB-3174 - one capability tag of a heartbeat. */
export const AgentCapabilitySchema = printableLineSchema(AGENT_CLIENT_TEXT_MAX.capability);

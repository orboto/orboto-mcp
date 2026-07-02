/**
 * ORB-1331 — session-start nudge.
 *
 * The binding operating rules are delivered as prose in the MCP
 * `instructions` block (see server.ts) with a "FIRST ACTION: call
 * orboto_session_start" pointer, but nothing verified compliance. Weaker
 * agents (and clients that truncate the instructions block, ORB-1177)
 * skip `orboto_session_start`, never load the rules, and then work
 * rule-blind for the whole session.
 *
 * This adds SOFT technical enforcement: per MCP session, if the FIRST
 * tool call is not `orboto_session_start`, prepend a one-time reminder
 * text block to that first call's response. It is a reminder, never a
 * refusal — read-only exploration and benign one-shot clients keep
 * working. It fires at most once and never when the first call already
 * IS `orboto_session_start`.
 *
 * Per-session vs. process-local is handled by lifetime, not code: the
 * state object is created once per `buildOrbotoMcpServer` call, which the
 * HTTP transport invokes once per session and the stdio transport once
 * per process. So one flag object == one session (HTTP) / one process
 * (stdio) with no session-lifecycle plumbing.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** The tool whose whole job is to load the rules — never nudge on it. */
export const SESSION_START_TOOL = 'orboto_session_start';

/**
 * The one-time reminder. English, ASCII-only, no em/en-dashes so it
 * survives every client. Prepended as a leading text block only —
 * structuredContent and the tool's own content are left untouched.
 */
export const SESSION_START_NUDGE =
  'NOTE: you have not loaded this workspace\'s binding operating rules yet. ' +
  'Call `orboto_session_start` now - it returns the rules you must follow ' +
  'plus your in-progress work.';

export interface NudgeState {
  /** Flips true on the first tool dispatch of the session, whatever it was. */
  firstToolCallSeen: boolean;
}

/** Fresh per-session (HTTP) / per-process (stdio) nudge state. */
export function createNudgeState(): NudgeState {
  return { firstToolCallSeen: false };
}

/**
 * Advance the state for one dispatch and report whether this dispatch
 * should carry the nudge. True ONLY for the first tool call of the
 * session when that call is not `orboto_session_start`. Every later call
 * — and the session_start-first case — returns false. Idempotent after
 * the first call because the flag is already set.
 */
export function shouldNudge(state: NudgeState, toolName: string): boolean {
  if (state.firstToolCallSeen) return false;
  state.firstToolCallSeen = true;
  return toolName !== SESSION_START_TOOL;
}

/**
 * Return a copy of the result with the nudge prepended as a leading text
 * block. Does not mutate the input, does not touch `structuredContent`,
 * and preserves `isError` and every existing content block.
 */
export function prependNudge(result: CallToolResult): CallToolResult {
  return {
    ...result,
    content: [
      { type: 'text', text: SESSION_START_NUDGE },
      ...(result.content ?? []),
    ],
  };
}

/**
 * ORB-1331 - session-start nudge.
 *
 * @see ORB-1177
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** The tool whose whole job is to load the rules - never nudge on it. */
export const SESSION_START_TOOL = 'orboto_session_start';

/**
 * The one-time reminder. English, ASCII-only, no em/en-dashes so it
 * survives every client. Prepended as a leading text block only - 
 * structuredContent and the tool's own content are left untouched.
 */
export const SESSION_START_NUDGE =
  'NOTE: you have not loaded this workspace\'s binding operating rules yet. ' +
  'Call `orboto_session_start` now - it returns the rules you must follow ' +
  'plus your in-progress work.';

export interface NudgeState {
  /** Flips true on the first tool dispatch of the session, whatever it was. */
  firstToolCallSeen: boolean;
  /**
   * Flips true only after `orboto_session_start` successfully loads rules.
   * Drives the HARD gate (see shouldGate) when the workspace flag
   * `mcp_require_session_start` is on: every other tool call is refused until
   * this is true.
   */
  sessionStartRan: boolean;
  /**
   * ORB-1471 - whether the workspace requires session-start before any other
   * tool (read from GET /agent-instructions at connect time). Off by default.
   */
  gateEnabled: boolean;
}

/** Fresh per-session (HTTP) / per-process (stdio) nudge state. `gateEnabled`
 *  comes from the workspace config fetched at server build (default off). */
export function createNudgeState(gateEnabled = false): NudgeState {
  return { firstToolCallSeen: false, sessionStartRan: false, gateEnabled };
}

/**
 * Advance the state for one dispatch and report whether this dispatch
 * should carry the nudge. True ONLY for the first tool call of the
 * session when that call is not `orboto_session_start`. Every later call
 * - and the session_start-first case - returns false. Idempotent after
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

/**
 * ORB-1471 - the HARD session-start gate message. Unlike the soft nudge
 * (which rides along on the tool's real result), the gate REFUSES the tool
 * call outright and returns this instead. English, ASCII-only.
 */
export const SESSION_START_GATE_MESSAGE =
  'This workspace requires you to load its binding operating rules before any ' +
  'other action. Call `orboto_session_start` now - it returns the rules you ' +
  'must follow plus your in-progress work - then retry this call.';

/**
 * Advance the gate state for one dispatch and report whether this
 * dispatch must be REFUSED (returned an instructive error without running the
 * handler).
 */
export function shouldGate(state: NudgeState, toolName: string): boolean {
  if (toolName === SESSION_START_TOOL) {
    state.sessionStartRan = false;
    return false;
  }
  if (!state.gateEnabled) return false;
  return !state.sessionStartRan;
}

export function recordSessionStartResult(state: NudgeState, toolName: string, success: boolean): void {
  if (toolName === SESSION_START_TOOL) state.sessionStartRan = success;
}

/** ORB-1471 - the instructive refusal result the gate returns. */
export function gateResult(): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: SESSION_START_GATE_MESSAGE }],
  };
}

/**
 * ORB-1331 — session-start nudge state machine + prepend helper.
 *
 * Unit-level proof of the semantics the transport tests then exercise
 * end-to-end: fire once, only on the first tool call, never when that
 * call is orboto_session_start, and never mutate structuredContent.
 */
import { describe, it, expect } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  SESSION_START_TOOL,
  SESSION_START_NUDGE,
  createNudgeState,
  shouldNudge,
  prependNudge,
} from './session-nudge.js';

describe('shouldNudge (ORB-1331)', () => {
  it('nudges on the first tool call when it is not session_start, then never again', () => {
    const state = createNudgeState();
    expect(shouldNudge(state, 'orboto_list_projects')).toBe(true);
    // Every subsequent call is clean regardless of tool.
    expect(shouldNudge(state, 'orboto_get_ticket')).toBe(false);
    expect(shouldNudge(state, 'orboto_list_projects')).toBe(false);
    expect(shouldNudge(state, SESSION_START_TOOL)).toBe(false);
  });

  it('never nudges when the first call IS session_start', () => {
    const state = createNudgeState();
    expect(shouldNudge(state, SESSION_START_TOOL)).toBe(false);
    // and does not resurface on later calls either.
    expect(shouldNudge(state, 'orboto_list_projects')).toBe(false);
  });

  it('isolates state between sessions/processes (each fresh state nudges once)', () => {
    const a = createNudgeState();
    const b = createNudgeState();
    expect(shouldNudge(a, 'orboto_list_projects')).toBe(true);
    // b is untouched by a — its own first call still nudges.
    expect(shouldNudge(b, 'orboto_list_projects')).toBe(true);
    expect(shouldNudge(a, 'orboto_list_projects')).toBe(false);
    expect(shouldNudge(b, 'orboto_list_projects')).toBe(false);
  });
});

describe('SESSION_START_NUDGE text (ORB-1331)', () => {
  it('is English, ASCII-only, and free of em/en-dashes', () => {
    // eslint-disable-next-line no-control-regex
    expect(/^[\x00-\x7F]*$/.test(SESSION_START_NUDGE)).toBe(true);
    expect(SESSION_START_NUDGE).not.toMatch(/[–—]/); // en/em dash
    expect(SESSION_START_NUDGE).toContain('orboto_session_start');
  });
});

describe('prependNudge (ORB-1331)', () => {
  it('prepends the nudge as a leading text block without touching structuredContent or isError', () => {
    const original: CallToolResult = {
      content: [{ type: 'text', text: 'tool output' }],
      structuredContent: { projects: [], total: 0 },
    };
    const out = prependNudge(original);
    expect(out.content).toHaveLength(2);
    expect(out.content[0]).toEqual({ type: 'text', text: SESSION_START_NUDGE });
    expect(out.content[1]).toEqual({ type: 'text', text: 'tool output' });
    // structuredContent consumers are unaffected — same reference-equal payload.
    expect(out.structuredContent).toBe(original.structuredContent);
    // input is not mutated.
    expect(original.content).toHaveLength(1);
  });

  it('preserves isError on an error result', () => {
    const errResult: CallToolResult = { isError: true, content: [{ type: 'text', text: 'boom' }] };
    const out = prependNudge(errResult);
    expect(out.isError).toBe(true);
    expect(out.content[0]).toEqual({ type: 'text', text: SESSION_START_NUDGE });
    expect(out.content[1]).toEqual({ type: 'text', text: 'boom' });
  });
});

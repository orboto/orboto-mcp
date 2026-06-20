/**
 * ORB-1177 — the instructions block stays under a length budget so the
 * client can't silently truncate it mid-rule; the head always survives
 * and the rules are cut at a whole-line boundary with a pointer to the
 * cap-independent full set.
 */
import { describe, it, expect } from 'vitest';
import { assembleInstructions } from './server.js';

const HEADING = 'Working rules for this workspace:\n';

describe('assembleInstructions (ORB-1177)', () => {
  it('passes through unchanged when under budget', () => {
    const out = assembleInstructions('HEAD', 'rule one\nrule two', 1000);
    expect(out).toBe(`HEAD\n\n${HEADING}rule one\nrule two`);
  });

  it('caps at the budget, keeps the head, cuts rules on a line boundary, points to the full set', () => {
    const head = 'HEAD-ABC';
    const lines = Array.from({ length: 300 }, (_, i) => `rule-line-${i}-padding-padding-padding-padding`);
    const rules = lines.join('\n');
    const budget = 600;
    const out = assembleInstructions(head, rules, budget);

    expect(out.length).toBeLessThanOrEqual(budget);
    expect(out.startsWith(`${head}\n\n${HEADING}`)).toBe(true);
    expect(out).toContain('orboto://rules');
    expect(out).toContain('orboto_session_start');
    expect(out).toContain('truncated');

    // Every kept rule line is a COMPLETE original line (no mid-line cut).
    const body = out.slice(`${head}\n\n${HEADING}`.length).split('\n\n[... rules truncated')[0];
    const kept = body.length ? body.split('\n') : [];
    for (const line of kept) expect(lines).toContain(line);
    // And it actually kept fewer than all lines (proves truncation happened).
    expect(kept.length).toBeLessThan(lines.length);
  });
});

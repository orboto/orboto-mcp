import { describe, expect, it } from 'vitest';
import {
  LIVE_KINDS, LIVE_RESOURCE_CHARS, renderLiveEvent, renderTranscriptResource, type LiveEvent, type LiveLine,
} from './live-transcript.js';

const SESSION = '6b2d8e1f-4a3c-4d5e-8f70-112233445566';

function line(seq: number, event: LiveEvent): LiveLine {
  return { id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`, sessionId: SESSION, seq, at: '2026-09-30T10:00:00.000Z', maskedCount: 0, event };
}

const conversation: LiveEvent[] = [
  { kind: 'user_prompt', text: 'Wie ist der Stand von ACME-129?' },
  { kind: 'assistant_text', text: 'Ich schaue mir **ACME-129** an.' },
  { kind: 'tool_group', groupId: 'g-1', final: false, counts: [{ kind: 'read', count: 1 }], durationMs: 10_000, items: [] },
  {
    kind: 'tool_group', groupId: 'g-1', final: true, durationMs: 22_000,
    counts: [{ kind: 'read', count: 2 }, { kind: 'shell', count: 5 }, { kind: 'orboto', count: 1 }],
    items: [
      { toolUseId: 't1', name: 'Read', kind: 'read', summary: 'README.md' },
      { toolUseId: 't2', name: 'Bash', kind: 'shell', summary: 'curl -H \'Authorization: Bearer [secret]\' https://x', isError: true },
    ],
  },
  { kind: 'permission_prompt', questionId: 'q1', tool: 'Bash', text: 'Run rm -rf dist?' },
  { kind: 'turn_end', durationMs: 1_351_000, model: 'claude-opus-5-5', effort: 'high', outcome: 'done' },
  { kind: 'usage', windows: [{ window: 'five_hour', usedPercent: 36, resetsAt: '2026-09-30T15:00:00Z' }, { window: 'seven_day', usedPercent: 67 }] },
  { kind: 'context', percent: 51, tokens: 510_000, windowSize: 1_000_000 },
];

describe('live transcript rendering', () => {
  it('knows every kind the contract names and renders each to one non-empty line head', () => {
    expect(LIVE_KINDS).toHaveLength(14);
    for (const event of conversation) expect(renderLiveEvent(event).length).toBeGreaterThan(3);
  });
});

describe('orboto://live/{sessionId}/transcript', () => {
  it('keeps the newest lines within its cap and says what it left out', () => {
    const items = Array.from({ length: 60 }, (_, i) => line(200 - i, { kind: 'assistant_text', text: `Zeile ${200 - i} ${'y'.repeat(300)}` }));
    const text = renderTranscriptResource(SESSION, { items, lastSeq: 200 });
    expect(text.length).toBeLessThanOrEqual(LIVE_RESOURCE_CHARS);
    expect(text).toContain('Zeile 200');
    expect(text).not.toContain('Zeile 141 ');
    expect(text).toMatch(/\[truncated: earlier lines are not shown here - page the rest with orboto_api_call get \/agents\/live-sessions\/[^ ]+\/transcript\?afterSeq=N; \d+ of the newest 60 did not fit\]/);
  });

  it('shows a short session whole', () => {
    const text = renderTranscriptResource(SESSION, { items: conversation.map((event, i) => line(i + 1, event)).reverse(), lastSeq: 8 });
    expect(text).not.toContain('[truncated');
    expect(text.indexOf('> Wie ist')).toBeLessThan(text.indexOf('[context 51%'));
  });
});

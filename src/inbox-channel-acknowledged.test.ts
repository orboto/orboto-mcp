/** ORB-2564 - a person's acknowledgement wakes the sending session as kind `acknowledged`, and the inbox names the ladder step of urgent mail. */
import { describe, expect, it } from 'vitest';
import { eventKind, renderEvent } from './inbox-channel.js';
import { repeatMarks } from './tools/agent-messages.js';

describe('ORB-2564 - acknowledged wake', () => {
  it('renders the acknowledgement as its own kind and any other message by its kind', () => {
    const ack = { id: 'a1', kind: 'info', subject: 'acknowledged: disk full', payload: { type: 'acknowledged', acknowledgedMessageId: 'm1' }, createdAt: new Date().toISOString() };
    expect(eventKind(ack)).toBe('acknowledged');
    const event = renderEvent(ack, Date.now());
    expect(event.meta.kind).toBe('acknowledged');
    expect(event.content.startsWith('[acknowledged] acknowledged: disk full')).toBe(true);
    expect(eventKind({ kind: 'request', payload: { type: 'ticket_ready' } })).toBe('request');
  });

  it('marks how far an urgent message escalated', () => {
    expect(repeatMarks({ priority: 'urgent', escalationStep: 2 })).toBe(' [urgent, escalated: deputy]');
    expect(repeatMarks({ priority: 'urgent', escalationStep: 1, reminderCount: 1 })).toBe(' [urgent, reminder 1, escalated: mail and channels]');
    expect(repeatMarks({ priority: 'normal' })).toBe('');
  });
});

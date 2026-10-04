/** ORB-2467 - the wake channel shows count and total size of agent mail attachments, never names; the tail calls are labelled. */
import { describe, expect, it } from 'vitest';
import { attachmentLine, renderDigest, renderEvent, type InboxMessage } from './inbox-channel.js';
import { metricsToolName } from './tail-labels.js';

const NOW = Date.parse('2026-10-04T10:00:00Z');
const ID = '6f1c2b1e-3d4a-4b5c-8d9e-0a1b2c3d4e5f';
const msg = (over: Partial<InboxMessage> = {}): InboxMessage => ({
  id: ID, kind: 'info', subject: 'build output', createdAt: '2026-10-04T09:59:00Z', from: { label: 'a@x.test' }, ...over,
});

describe('ORB-2467 - attachments on the wake channel', () => {
  it('an event names count and total size and the download command, a digest the summary', () => {
    const carried = msg({ attachments: { count: 1, label: '1 archive, 12.4 MB' }, payload: { message: 'see attached' } });
    const event = renderEvent(carried, NOW);
    expect(event.content).toContain(`attachments: 1 archive, 12.4 MB (orboto messages --download ${ID})`);
    expect(renderDigest([carried], NOW).content).toContain('| attachments: 1 archive, 12.4 MB');
  });

  it('a message without attachments renders as before', () => {
    expect(attachmentLine(msg())).toBe('');
    expect(renderEvent(msg(), NOW).content).not.toContain('attachments');
  });
});

describe('ORB-2467 - tail labels', () => {
  const call = (method: string, path: string) => metricsToolName('orboto_api_call', { method, path });

  it('labels the list, the signed URL and the operator panel', () => {
    expect(call('GET', `/v1/agent/messages/${ID}/attachments`)).toBe('orboto_agent_message_attachments');
    expect(call('GET', `/v1/agent/messages/${ID}/attachments/${ID}/url`)).toBe('orboto_agent_message_attachments');
    expect(call('GET', '/admin/agents/transfers')).toBe('orboto_agent_transfers');
    expect(call('DELETE', `/admin/agents/transfers/${ID}`)).toBe('orboto_agent_transfers');
  });

  it('leaves the multipart upload unlabelled: it needs the CLI', () => {
    expect(call('POST', '/v1/agent/messages/attachments')).toBe('orboto_api_call');
  });
});

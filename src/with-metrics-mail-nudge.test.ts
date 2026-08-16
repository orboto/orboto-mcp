/**
 * ORB-1733 - the pending-mail nudge must NEVER touch structuredContent.
 *
 * The SDK validates structuredContent against the tool's declared
 * outputSchema; the ORB-1727 version injected `__pendingAgentMessages`
 * into every result while mail was pending, which failed validation on
 * every strict-schema tool and rendered the whole MCP surface unusable
 * for that identity until the mail was acked. The nudge lives only in a
 * text content block.
 */
import { describe, it, expect } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { appendMailNudge } from './with-metrics.js';
import type { OrbotoClient } from './orboto-client.js';

function clientWithMail(count: number): OrbotoClient {
  return { pendingAgentMail: count } as unknown as OrbotoClient;
}

function structuredResult(): CallToolResult {
  return {
    content: [{ type: 'text', text: 'projects listed' }],
    structuredContent: { projects: [{ key: 'ORB', name: 'orboto' }] },
  };
}

describe('ORB-1733: mail nudge vs output schemas', () => {
  it('leaves structuredContent byte-identical while mail is pending - the nudge is a text block only', () => {
    const original = structuredResult();
    const out = appendMailNudge(clientWithMail(2), 'orboto_list_projects', original);
    expect(out.structuredContent).toEqual({ projects: [{ key: 'ORB', name: 'orboto' }] });
    expect(JSON.stringify(out.structuredContent)).not.toContain('__pendingAgentMessages');
    const texts = out.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text);
    expect(texts.some((t) => t.includes('2 unread agent message'))).toBe(true);
  });

  it('no mail = result passed through untouched', () => {
    const original = structuredResult();
    const out = appendMailNudge(clientWithMail(0), 'orboto_list_projects', original);
    expect(out).toBe(original);
  });

  it('orboto_messages itself is never nudged', () => {
    const original = structuredResult();
    const out = appendMailNudge(clientWithMail(5), 'orboto_messages', original);
    expect(out).toBe(original);
  });
});

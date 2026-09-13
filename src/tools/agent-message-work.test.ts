import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { makeAgentMessageWorkHandler } from './agent-message-work.js';
import { makeAgentMessagesHandler } from './agent-messages.js';
import type { OrbotoClient } from '../orboto-client.js';

describe('message work MCP parity', () => {
  it('keeps the standalone MCP mutation validator aligned with shared-schema', () => {
    const shared = readFileSync(new URL('../../../../packages/shared-schema/src/agent-message-work.ts', import.meta.url), 'utf8');
    const local = readFileSync(new URL('./agent-message-work.ts', import.meta.url), 'utf8');
    const block = shared.slice(shared.indexOf('export const MessageWorkStepSchema'), shared.indexOf('export const MessageAckSchema')).replaceAll('export const', 'const');
    expect(local).toContain(block);
  });
  it('uses each MCP connection identity and reads exact IDs without ACK', async () => {
    const get = vi.fn().mockResolvedValueOnce({ message: { id: 'message' } }).mockResolvedValue({ messages: [] }); const post = vi.fn().mockResolvedValue({ state: 'in_work' });
    const client = { get, post } as unknown as OrbotoClient;
    const handler = makeAgentMessageWorkHandler(client);
    await handler({ messageId: 'message' }, { sessionId: 'a' });
    expect(get).toHaveBeenCalledWith('/v1/agent/messages/message?limit=25&openOnly=true', { instanceToken: 'mcp-a' }); expect(post).not.toHaveBeenCalled();
    await handler({ messageId: 'message', mutation: { action: 'claim', summary: 'Explicit acceptance', evidence: [], leaseSeconds: 900 } }, { sessionId: 'a' });
    expect(post).toHaveBeenCalledWith('/v1/agent/messages/message/work', expect.objectContaining({ instanceToken: 'mcp-a' }));
    await makeAgentMessagesHandler(client)({ ackIds: ['message'], ackEvidence: 'Handled' }, { sessionId: 'b' });
    expect(post).toHaveBeenCalledWith('/v1/agent/messages/ack', { ids: ['message'], evidence: 'Handled', instanceToken: 'mcp-b' });
  });
});

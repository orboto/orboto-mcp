import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { agentMessageWorkToolConfig, makeAgentMessageWorkHandler } from './agent-message-work.js';
import { makeAgentMessagesHandler } from './agent-messages.js';
import type { OrbotoClient } from '../orboto-client.js';

describe('message work MCP parity', () => {
  it('carries no second copy of the shared mutation schema', () => {
    const shared = readFileSync(new URL('../../../../packages/shared-schema/src/agent-message-work.ts', import.meta.url), 'utf8');
    const local = readFileSync(new URL('./agent-message-work.ts', import.meta.url), 'utf8');
    const stepBlock = shared.slice(shared.indexOf('export const MessageWorkStepSchema'), shared.indexOf('export const MessageWorkMutationSchema'));
    expect(local).not.toContain(stepBlock.replaceAll('export const', 'const'));
    expect(local).not.toContain('MessageWorkStepSchema');
    expect(agentMessageWorkToolConfig.description).toContain('orboto_api_search');
  });
  it('uses each MCP connection identity and reads exact IDs without ACK', async () => {
    const get = vi.fn().mockResolvedValueOnce({ message: { id: 'message' } }).mockResolvedValue({ messages: [] }); const post = vi.fn().mockResolvedValue({ state: 'in_work' });
    const client = { get, post } as unknown as OrbotoClient;
    const handler = makeAgentMessageWorkHandler(client);
    await handler({ messageId: 'message' }, { sessionId: 'a' });
    expect(get).toHaveBeenCalledWith('/v1/agent/messages/message?limit=25&openOnly=true', { instanceToken: 'mcp-a' }); expect(post).not.toHaveBeenCalled();
    await handler({ messageId: 'message', mutation: { action: 'claim', summary: 'Explicit acceptance', evidence: [], leaseSeconds: 900 } }, { sessionId: 'a' });
    expect(post).toHaveBeenCalledWith('/v1/agent/messages/message/work', expect.objectContaining({ instanceToken: 'mcp-a' }));
  });
  it('ACK is a plain read receipt - no evidence travels with it', async () => {
    const get = vi.fn().mockResolvedValue({ messages: [] }); const post = vi.fn().mockResolvedValue({ acked: 1 });
    const client = { get, post } as unknown as OrbotoClient;
    await makeAgentMessagesHandler(client)({ ackIds: ['message'] }, { sessionId: 'b' });
    expect(post).toHaveBeenCalledWith('/v1/agent/messages/ack', { ids: ['message'], instanceToken: 'mcp-b' });
    expect(JSON.stringify(post.mock.calls)).not.toContain('evidence');
  });
});

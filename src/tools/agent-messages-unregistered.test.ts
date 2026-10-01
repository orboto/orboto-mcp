/**
 * ORB-2347 - the inbox tool names the unregistered-caller rule in its description and in its answer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import { agentMessagesToolConfig, makeAgentMessagesHandler } from './agent-messages.js';

afterEach(() => { vi.restoreAllMocks(); });

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });

function stubInbox(sessionId: string | null) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => (
    { ok: true, status: 200, statusText: 'OK', json: async () => ({ messages: [], sessionId }), text: async () => '' } as unknown as Response
  ));
}

describe('ORB-2347 - orboto_messages for an unregistered caller', () => {
  it('the description states the rule', () => {
    expect(agentMessagesToolConfig.description).toContain('Before orboto_session_start only account mail is listed');
  });

  it('an answer without a session id carries the register hint; a registered answer does not', async () => {
    stubInbox(null);
    const unregistered = (await makeAgentMessagesHandler(client)({})).content[0] as { text: string };
    expect(unregistered.text).toContain('Not registered: only account mail is listed');

    stubInbox('8772a665-0000-4000-8000-000000000000');
    const registered = (await makeAgentMessagesHandler(client)({})).content[0] as { text: string };
    expect(registered.text).not.toContain('Not registered');
  });
});

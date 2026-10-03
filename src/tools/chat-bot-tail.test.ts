/** ORB-2458 - the chat bot reaches an MCP-only agent through the escape hatch; every call is labelled in the metrics. */
import { describe, expect, it } from 'vitest';
import { metricsToolName } from '../tail-labels.js';

const ID = '6f1c2b1e-3d4a-4b5c-8d9e-0a1b2c3d4e5f';
const call = (method: string, path: string) => metricsToolName('orboto_api_call', { method, path });

describe('ORB-2458 - chat bot tail labels', () => {
  it('labels the reads', () => {
    for (const path of ['/admin/chat-bot/connections', `/admin/chat-bot/connections/${ID}/health`, `/admin/chat-bot/connections/${ID}/slack-manifest`, '/admin/chat-bot/routes', '/admin/chat-bot/links?includeRevoked=true', '/admin/chat-bot/settings', '/admin/chat-bot/deliveries', '/chat-bot/connections', '/chat-bot/links/mine', `/projects/${ID}/chat-bot/routes`]) {
      expect(call('GET', path), path).toBe('orboto_chat_bot_status');
    }
  });

  it('labels the operator writes, the route writes and the user link writes', () => {
    expect(call('POST', '/admin/chat-bot/connections')).toBe('orboto_chat_bot_admin');
    expect(call('POST', `/admin/chat-bot/connections/${ID}/rotate-credentials`)).toBe('orboto_chat_bot_admin');
    expect(call('POST', `/admin/chat-bot/connections/${ID}/discord-commands`)).toBe('orboto_chat_bot_admin');
    expect(call('PATCH', '/admin/chat-bot/settings')).toBe('orboto_chat_bot_admin');
    expect(call('DELETE', `/admin/chat-bot/connections/${ID}`)).toBe('orboto_chat_bot_admin');
    expect(call('POST', `/admin/chat-bot/links/${ID}/revoke`)).toBe('orboto_chat_bot_admin');
    expect(call('POST', `/admin/chat-bot/deliveries/${ID}/retry`)).toBe('orboto_chat_bot_admin');
    expect(call('POST', `/projects/${ID}/chat-bot/routes`)).toBe('orboto_chat_bot_route');
    expect(call('POST', `/projects/${ID}/chat-bot/routes/${ID}/send-test`)).toBe('orboto_chat_bot_route');
    expect(call('PATCH', `/projects/${ID}/chat-bot/routes/${ID}`)).toBe('orboto_chat_bot_route');
    expect(call('DELETE', `/projects/${ID}/chat-bot/routes/${ID}`)).toBe('orboto_chat_bot_route');
    expect(call('POST', '/chat-bot/links/confirm')).toBe('orboto_chat_bot_link');
    expect(call('POST', `/chat-bot/links/${ID}/revoke`)).toBe('orboto_chat_bot_link');
  });

  it('leaves the public receivers and unrelated calls unlabelled', () => {
    expect(call('POST', `/inbound/chat-bot/slack/${ID}/events`)).toBe('orboto_api_call');
    expect(call('GET', '/projects')).toBe('orboto_api_call');
  });
});

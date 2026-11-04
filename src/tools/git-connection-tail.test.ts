/** ORB-2755 - the git connection update (readOnly, shareable, the webhook refresh) has no named MCP tool; orboto_api_call reaches it under its own metrics label. */
import { describe, expect, it } from 'vitest';
import { metricsToolName } from '../tail-labels.js';

const ID = '11111111-1111-4111-8111-111111111111';
const CONN = '22222222-2222-4222-8222-222222222222';
const call = (method: string, path: string) => metricsToolName('orboto_api_call', { method, path });

describe('ORB-2755 - orboto_api_call on the git connection update', () => {
  it('labels the update of one connection', () => {
    expect(call('PATCH', `/projects/${ID}/git-connections/${CONN}`)).toBe('orboto_git_connection_update');
    expect(call('patch', `/projects/${ID}/git-connections/${CONN}/`)).toBe('orboto_git_connection_update');
  });

  it('leaves the list, the create, the delete and the token rotation alone', () => {
    expect(call('GET', `/projects/${ID}/git-connections`)).toBe('orboto_api_call');
    expect(call('POST', `/projects/${ID}/git-connections`)).toBe('orboto_api_call');
    expect(call('DELETE', `/projects/${ID}/git-connections/${CONN}`)).toBe('orboto_api_call');
    expect(call('POST', `/projects/${ID}/git-connections/${CONN}/rotate-token`)).toBe('orboto_api_call');
  });
});

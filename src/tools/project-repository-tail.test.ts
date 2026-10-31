/** ORB-2741 - the repository create has no named MCP tool (the full manifest has no room); orboto_api_call reaches it under its own metrics label. */
import { describe, expect, it } from 'vitest';
import { metricsToolName } from '../tail-labels.js';

const ID = '11111111-1111-4111-8111-111111111111';
const call = (method: string, path: string) => metricsToolName('orboto_api_call', { method, path });

describe('ORB-2741 - orboto_api_call on the repository create', () => {
  it('labels the create and the source list', () => {
    expect(call('POST', `/projects/${ID}/git-repositories`)).toBe('orboto_project_repository_create');
    expect(call('GET', `/projects/${ID}/git-repositories/sources`)).toBe('orboto_project_repository_create');
  });

  it('leaves the link route and other methods alone', () => {
    expect(call('POST', `/projects/${ID}/repositories`)).toBe('orboto_api_call');
    expect(call('DELETE', `/projects/${ID}/git-repositories`)).toBe('orboto_api_call');
  });
});

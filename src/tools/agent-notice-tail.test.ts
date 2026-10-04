/** ORB-2465 - the live notice reaches an MCP-only agent through the escape hatch; every call is labelled in the metrics. */
import { describe, expect, it } from 'vitest';
import { metricsToolName } from '../tail-labels.js';

const ID = '6f1c2b1e-3d4a-4b5c-8d9e-0a1b2c3d4e5f';
const call = (method: string, path: string) => metricsToolName('orboto_api_call', { method, path });

describe('ORB-2465 - live notice tail labels', () => {
  it('labels the send, the status and the active list', () => {
    expect(call('POST', '/v1/agent/broadcast/live')).toBe('orboto_agent_notice');
    expect(call('GET', `/v1/agent/broadcasts/live/${ID}`)).toBe('orboto_agent_notice_status');
    expect(call('GET', '/v1/agent/broadcasts/live')).toBe('orboto_agent_notice_status');
  });

  it('leaves the scope broadcasts and the prompt-hook delivery unlabelled', () => {
    expect(call('POST', '/v1/agent/broadcast')).toBe('orboto_api_call');
    expect(call('POST', '/v1/agent/broadcasts/live/deliver')).toBe('orboto_api_call');
  });
});

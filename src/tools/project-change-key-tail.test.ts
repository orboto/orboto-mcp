/** ORB-2677 - the project key change is a tail endpoint: reached through orboto_api_call and labelled in the metrics, no named tool. */
import { describe, expect, it } from 'vitest';
import { metricsToolName } from '../tail-labels.js';

const ID = '6f1c2b1e-3d4a-4b5c-8d9e-0a1b2c3d4e5f';
const call = (method: string, path: string) => metricsToolName('orboto_api_call', { method, path });

describe('ORB-2677 - project key change tail label', () => {
  it('labels the change by project id and by project key', () => {
    expect(call('POST', `/projects/${ID}/change-key`)).toBe('orboto_project_change_key');
    expect(call('post', '/projects/PROJ/change-key')).toBe('orboto_project_change_key');
    expect(call('GET', `/projects/${ID}/change-key/check?key=NEW`)).toBe('orboto_project_change_key');
  });

  it('leaves other project calls unlabelled', () => {
    expect(call('GET', `/projects/${ID}/change-key`)).toBe('orboto_api_call');
    expect(call('POST', `/projects/${ID}/change-key/check`)).toBe('orboto_api_call');
    expect(call('POST', `/projects/${ID}`)).toBe('orboto_api_call');
    expect(call('PATCH', `/projects/${ID}`)).toBe('orboto_api_call');
  });
});

/** ORB-2777 - the local memory import is a tail endpoint: the CLI reads the folder, an agent without it reaches the route through orboto_api_call, labelled in the metrics. */
import { describe, expect, it } from 'vitest';
import { metricsToolName } from '../tail-labels.js';

const call = (method: string, path: string) => metricsToolName('orboto_api_call', { method, path });

describe('ORB-2777 - local memory import tail label', () => {
  it('labels the import', () => {
    expect(call('POST', '/knowledge/import-local')).toBe('orboto_knowledge_import_local');
    expect(call('post', '/knowledge/import-local/')).toBe('orboto_knowledge_import_local');
  });

  it('leaves the other knowledge calls unlabelled', () => {
    expect(call('GET', '/knowledge/import-local')).toBe('orboto_api_call');
    expect(call('POST', '/knowledge/add')).toBe('orboto_api_call');
    expect(call('POST', '/knowledge/import-local/preview')).toBe('orboto_api_call');
  });
});

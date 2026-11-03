/** ORB-2774 - an explicit wiki merge is a tail endpoint: lint merges on its own, a person or agent reaches the manual merge through orboto_api_call, labelled in the metrics. */
import { describe, expect, it } from 'vitest';
import { metricsToolName } from '../tail-labels.js';

const ID = '6f1c2b1e-3d4a-4b5c-8d9e-0a1b2c3d4e5f';
const call = (method: string, path: string) => metricsToolName('orboto_api_call', { method, path });

describe('ORB-2774 - wiki merge tail label', () => {
  it('labels the merge by doc id and by doc key', () => {
    expect(call('POST', `/docs/${ID}/merge-into`)).toBe('orboto_wiki_merge');
    expect(call('post', '/docs/ORB-D44/merge-into/')).toBe('orboto_wiki_merge');
  });

  it('leaves other doc calls unlabelled', () => {
    expect(call('GET', `/docs/${ID}/merge-into`)).toBe('orboto_api_call');
    expect(call('POST', `/docs/${ID}`)).toBe('orboto_api_call');
  });
});

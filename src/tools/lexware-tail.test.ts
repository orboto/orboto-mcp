/** ORB-2508 - the Lexware connection reaches an MCP-only agent through the escape hatch; every call is labelled in the metrics. */
import { describe, expect, it } from 'vitest';
import { metricsToolName } from '../tail-labels.js';

const call = (method: string, path: string) => metricsToolName('orboto_api_call', { method, path });

describe('ORB-2508 - Lexware tail labels', () => {
  it('labels status, readiness, logs and the profile test as orboto_lexware_connection', () => {
    for (const path of ['/admin/integrations/lexware', '/admin/integrations/lexware/readiness', '/admin/integrations/lexware/events?limit=20', '/admin/integrations/lexware/deliveries']) {
      expect(call('GET', path), path).toBe('orboto_lexware_connection');
    }
    expect(call('POST', '/admin/integrations/lexware/test')).toBe('orboto_lexware_connection');
  });

  it('labels the operator writes as orboto_lexware_admin', () => {
    expect(call('POST', '/admin/integrations/lexware')).toBe('orboto_lexware_admin');
    expect(call('POST', '/admin/integrations/lexware/rotate-key')).toBe('orboto_lexware_admin');
    expect(call('POST', '/admin/integrations/lexware/subscriptions')).toBe('orboto_lexware_admin');
    expect(call('PATCH', '/admin/integrations/lexware')).toBe('orboto_lexware_admin');
    expect(call('DELETE', '/admin/integrations/lexware/subscriptions')).toBe('orboto_lexware_admin');
    expect(call('DELETE', '/admin/integrations/lexware')).toBe('orboto_lexware_admin');
  });

  it('labels the customer contact mapping as orboto_lexware_contact (ORB-2511)', () => {
    const path = '/customers/6f1c2b1e-3d4a-4b5c-8d9e-0a1b2c3d4e5f/lexware-contact';
    for (const method of ['GET', 'PUT', 'DELETE']) expect(call(method, path), method).toBe('orboto_lexware_contact');
    expect(call('GET', `${path}?name=Acme&page=1`)).toBe('orboto_lexware_contact');
  });

  it('leaves the public receiver unlabelled', () => {
    expect(call('POST', '/inbound/lexware/6f1c2b1e-3d4a-4b5c-8d9e-0a1b2c3d4e5f')).toBe('orboto_api_call');
  });
});

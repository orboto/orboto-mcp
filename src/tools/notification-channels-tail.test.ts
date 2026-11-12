/** ORB-3049 - the notification channels, web push among them, are tail endpoints: an agent lists and tests them through orboto_api_call, labelled in the metrics. */
import { describe, expect, it } from 'vitest';
import { metricsToolName } from '../tail-labels.js';

const ID = '6f1c2b1e-3d4a-4b5c-8d9e-0a1b2c3d4e5f';
const call = (method: string, path: string) => metricsToolName('orboto_api_call', { method, path });

describe('ORB-3049 - notification channel tail labels', () => {
  it('labels the channel, subscription and push device reads', () => {
    expect(call('GET', '/users/me/notification-channels')).toBe('orboto_notification_channels');
    expect(call('get', '/users/me/notification-channel-subscriptions')).toBe('orboto_notification_channels');
    expect(call('GET', '/users/me/push/subscriptions/')).toBe('orboto_notification_channels');
    expect(call('GET', '/users/me/push/config')).toBe('orboto_notification_channels');
  });

  it('labels a channel test and the push test', () => {
    expect(call('POST', `/users/me/notification-channels/${ID}/verify`)).toBe('orboto_notification_channel_test');
    expect(call('POST', '/users/me/push/test')).toBe('orboto_notification_channel_test');
  });

  it('leaves writes to the channels unlabelled', () => {
    expect(call('POST', '/users/me/notification-channels')).toBe('orboto_api_call');
    expect(call('DELETE', `/users/me/notification-channels/${ID}`)).toBe('orboto_api_call');
    expect(call('POST', '/users/me/push/subscriptions')).toBe('orboto_api_call');
  });
});

import { describe, expect, it } from 'vitest';
import { CallPushSubscriptionConflictError, isSupportedPushEndpoint, saveCallPushSubscription } from '../lib/callPush.js';

describe('call web push endpoints', () => {
  it('accepts HTTPS endpoints from supported browser push services', () => {
    expect(isSupportedPushEndpoint('https://fcm.googleapis.com/fcm/send/subscription')).toBe(true);
    expect(isSupportedPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/subscription')).toBe(true);
    expect(isSupportedPushEndpoint('https://web.push.apple.com/subscription')).toBe(true);
  });

  it('rejects insecure, credentialed, custom-host, and nonstandard-port endpoints', () => {
    expect(isSupportedPushEndpoint('http://fcm.googleapis.com/fcm/send/subscription')).toBe(false);
    expect(isSupportedPushEndpoint('https://user:pass@fcm.googleapis.com/fcm/send/subscription')).toBe(false);
    expect(isSupportedPushEndpoint('https://127.0.0.1:443/internal')).toBe(false);
    expect(isSupportedPushEndpoint('https://push.example.test/subscription')).toBe(false);
    expect(isSupportedPushEndpoint('https://fcm.googleapis.com:8443/subscription')).toBe(false);
  });

  it('does not allow a browser push subscription to be reassigned to another account', async () => {
    const subscription = {
      endpoint: `https://fcm.googleapis.com/fcm/send/${Date.now()}`,
      keys: { p256dh: 'public-key-value-long-enough', auth: 'auth-value-long-enough' },
    };
    await saveCallPushSubscription('owner-user', subscription);
    await expect(saveCallPushSubscription('other-user', subscription))
      .rejects.toBeInstanceOf(CallPushSubscriptionConflictError);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CallPushSubscriptionConflictError,
  isSupportedPushEndpoint,
  saveCallPushSubscription,
  sendIncomingCallPush,
} from '../lib/callPush.js';

const pushMocks = vi.hoisted(() => ({
  setVapidDetails: vi.fn(),
  sendNotification: vi.fn(),
}));

vi.mock('web-push', () => pushMocks);
vi.mock('../config/env.js', () => ({
  env: {
    VAPID_PUBLIC_KEY: 'test-public-key',
    VAPID_PRIVATE_KEY: 'test-private-key',
    VAPID_SUBJECT: 'mailto:test@example.com',
  },
}));
vi.mock('../lib/prisma.js', () => ({
  prisma: {},
  isDatabaseAvailable: vi.fn().mockResolvedValue(false),
}));
vi.mock('../lib/platform.js', () => ({
  getNotificationPreferences: vi.fn().mockResolvedValue([]),
}));

describe('call web push endpoints', () => {
  beforeEach(() => {
    pushMocks.setVapidDetails.mockClear();
    pushMocks.sendNotification.mockReset().mockResolvedValue(undefined);
  });

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

  it('configures VAPID and sends incoming call notifications', async () => {
    const subscription = {
      endpoint: `https://fcm.googleapis.com/fcm/send/${Date.now()}`,
      keys: { p256dh: 'public-key-value-long-enough', auth: 'auth-value-long-enough' },
    };
    await saveCallPushSubscription('call-user', subscription);

    await sendIncomingCallPush('call-user', {
      id: 'call-123',
      type: 'video',
      callerName: 'Caller',
      callerAvatar: 'https://example.test/avatar.png',
    });

    expect(pushMocks.setVapidDetails).toHaveBeenCalledWith(
      'mailto:test@example.com',
      'test-public-key',
      'test-private-key',
    );
    expect(pushMocks.sendNotification).toHaveBeenCalledOnce();
    const [sentSubscription, payload, options] = pushMocks.sendNotification.mock.calls[0];
    expect(sentSubscription).toEqual(subscription);
    expect(JSON.parse(payload)).toMatchObject({
      type: 'incoming-call',
      callId: 'call-123',
      callType: 'video',
      callerName: 'Caller',
      callerAvatar: 'https://example.test/avatar.png',
    });
    expect(options).toMatchObject({ TTL: 45, urgency: 'high' });
  });

  it('removes subscriptions that the push service reports as gone', async () => {
    const subscription = {
      endpoint: `https://fcm.googleapis.com/fcm/send/${Date.now()}`,
      keys: { p256dh: 'public-key-value-long-enough', auth: 'auth-value-long-enough' },
    };
    await saveCallPushSubscription('call-user', subscription);
    pushMocks.sendNotification.mockRejectedValue(Object.assign(new Error('Gone'), { statusCode: 410 }));

    await sendIncomingCallPush('call-user', { id: 'call-456', type: 'voice', callerName: 'Caller' });

    await expect(saveCallPushSubscription('another-user', subscription))
      .resolves.toBeUndefined();
  });
});

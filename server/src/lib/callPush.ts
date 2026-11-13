import { sendNotification, setVapidDetails } from 'web-push';
import { env } from '../config/env.js';
import { prisma, isDatabaseAvailable } from './prisma.js';
import { getNotificationPreferences } from './platform.js';

export type CallPushSubscriptionInput = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

type StoredSubscription = CallPushSubscriptionInput & { userId: string };

export class CallPushSubscriptionConflictError extends Error {
  constructor() {
    super('This browser push subscription is already linked to another account.');
    this.name = 'CallPushSubscriptionConflictError';
  }
}

const globalPushStore = globalThis as typeof globalThis & {
  __novaCallPushSubscriptions?: Map<string, StoredSubscription>;
};

function getMemorySubscriptions() {
  globalPushStore.__novaCallPushSubscriptions ??= new Map<string, StoredSubscription>();
  return globalPushStore.__novaCallPushSubscriptions;
}

export function isWebPushConfigured() {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

export function getWebPushPublicKey() {
  return env.VAPID_PUBLIC_KEY ?? null;
}

export function isSupportedPushEndpoint(endpoint: string) {
  try {
    const url = new URL(endpoint);
    const host = url.hostname.toLowerCase();
    const knownPushHost = host === 'fcm.googleapis.com'
      || host === 'updates.push.services.mozilla.com'
      || host === 'push.services.mozilla.com'
      || host.endsWith('.push.apple.com')
      || host.endsWith('.notify.windows.com');
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && !url.hash
      && (!url.port || url.port === '443')
      && knownPushHost;
  } catch {
    return false;
  }
}

export async function saveCallPushSubscription(userId: string, input: CallPushSubscriptionInput) {
  if (await isDatabaseAvailable()) {
    const existing = await prisma.pushSubscription.findUnique({
      where: { endpoint: input.endpoint },
      select: { userId: true },
    });
    if (existing && existing.userId !== userId) throw new CallPushSubscriptionConflictError();
    if (existing) {
      await prisma.pushSubscription.update({
        where: { endpoint: input.endpoint },
        data: { p256dh: input.keys.p256dh, auth: input.keys.auth },
      });
      return;
    }

    try {
      await prisma.pushSubscription.create({
        data: {
          userId,
          endpoint: input.endpoint,
          p256dh: input.keys.p256dh,
          auth: input.keys.auth,
        },
      });
    } catch (error) {
      if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'P2002') throw error;
      const updated = await prisma.pushSubscription.updateMany({
        where: { endpoint: input.endpoint, userId },
        data: { p256dh: input.keys.p256dh, auth: input.keys.auth },
      });
      if (updated.count === 0) throw new CallPushSubscriptionConflictError();
    }
    return;
  }
  const subscriptions = getMemorySubscriptions();
  const existing = subscriptions.get(input.endpoint);
  if (existing && existing.userId !== userId) throw new CallPushSubscriptionConflictError();
  subscriptions.set(input.endpoint, { userId, ...input });
}

export async function removeCallPushSubscriptions(userId: string) {
  if (await isDatabaseAvailable()) {
    await prisma.pushSubscription.deleteMany({ where: { userId } });
    return;
  }
  for (const [endpoint, subscription] of getMemorySubscriptions()) {
    if (subscription.userId === userId) getMemorySubscriptions().delete(endpoint);
  }
}

async function getSubscriptionsForUser(userId: string): Promise<StoredSubscription[]> {
  if (await isDatabaseAvailable()) {
    return prisma.pushSubscription.findMany({
      where: { userId },
      select: { userId: true, endpoint: true, p256dh: true, auth: true },
    }).then((subscriptions) => subscriptions.map((subscription) => ({
      userId: subscription.userId,
      endpoint: subscription.endpoint,
      keys: { p256dh: subscription.p256dh, auth: subscription.auth },
    })));
  }
  return [...getMemorySubscriptions().values()].filter((subscription) => subscription.userId === userId);
}

async function removeSubscription(userId: string, endpoint: string) {
  if (await isDatabaseAvailable()) {
    await prisma.pushSubscription.deleteMany({ where: { userId, endpoint } });
    return;
  }
  const subscription = getMemorySubscriptions().get(endpoint);
  if (subscription?.userId === userId) getMemorySubscriptions().delete(endpoint);
}

function getStatusCode(error: unknown) {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) return null;
  const statusCode = error.statusCode;
  return typeof statusCode === 'number' ? statusCode : null;
}

export async function sendIncomingCallPush(
  userId: string,
  call: { id: string; type: 'voice' | 'video'; callerName: string; callerAvatar?: string | null },
) {
  const publicKey = env.VAPID_PUBLIC_KEY;
  const privateKey = env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return;
  const callsPreference = (await getNotificationPreferences(userId)).find((preference) => preference.key === 'calls');
  if (callsPreference?.enabled === false) return;

  setVapidDetails(env.VAPID_SUBJECT, publicKey, privateKey);
  const subscriptions = await getSubscriptionsForUser(userId);
  const payload = JSON.stringify({
    type: 'incoming-call',
    callId: call.id,
    callType: call.type,
    callerName: call.callerName,
    callerAvatar: call.callerAvatar ?? null,
    createdAt: new Date().toISOString(),
  });
  const topic = Buffer.from(call.id).toString('base64url').slice(0, 32);

  await Promise.all(subscriptions.map(async (subscription) => {
    try {
      await sendNotification({
        endpoint: subscription.endpoint,
        keys: subscription.keys,
      }, payload, { TTL: 45, urgency: 'high', topic });
    } catch (error) {
      const statusCode = getStatusCode(error);
      if (statusCode === 404 || statusCode === 410) {
        await removeSubscription(userId, subscription.endpoint);
      } else {
        console.error('Unable to deliver an incoming call push notification.', {
          userId,
          callId: call.id,
          statusCode,
        });
      }
    }
  }));
}

import { prisma, isDatabaseAvailable } from './prisma.js';
import { socialStore } from './socialStore.js';
import { realtimeHub } from './realtime.js';

export type NotificationPreference = {
  key: 'social' | 'messages' | 'security' | 'live' | 'calls' | 'mentions';
  enabled: boolean;
  channel: 'in_app' | 'email' | 'push';
};

export type PresenceState = {
  userId: string;
  online: boolean;
  status: string;
  lastSeen: string | null;
  updatedAt: string;
};

export type TypingState = {
  conversationId: string;
  userId: string;
  isTyping: boolean;
  updatedAt: string;
};

export type CallType = 'voice' | 'video';
export type CallStatus = 'ringing' | 'outgoing' | 'connected' | 'ended' | 'missed' | 'rejected' | 'cancelled';

export type CallParticipantState = {
  userId: string;
  status: 'pending' | 'connected' | 'left';
  muted: boolean;
  cameraOn: boolean;
  speakerOn: boolean;
};

export type CallSession = {
  id: string;
  callerId: string;
  targetUserId?: string | null;
  type: CallType;
  status: CallStatus;
  participants: CallParticipantState[];
  provider: 'local-dev';
  providerConfigured: boolean;
  createdAt: string;
  updatedAt: string;
};

export type LiveVisibility = 'public' | 'private';
export type LiveStatus = 'live' | 'paused' | 'ended';

export type LiveViewer = {
  userId: string;
  isMuted: boolean;
  isBlocked: boolean;
  joinedAt: string;
};

export type LiveComment = {
  id: string;
  userId: string;
  text: string;
  createdAt: string;
};

export type LiveReaction = {
  id: string;
  userId: string;
  type: 'LIKE' | 'LOVE' | 'CLAP' | 'CHEER';
  createdAt: string;
};

export type LiveSession = {
  id: string;
  hostId: string;
  title: string;
  description?: string | null;
  visibility: LiveVisibility;
  status: LiveStatus;
  viewerCount: number;
  moderators: string[];
  viewers: LiveViewer[];
  comments: LiveComment[];
  reactions: LiveReaction[];
  replayUrl?: string | null;
  recordingUrl?: string | null;
  analyticsHook: string | null;
  provider: 'local-dev';
  providerConfigured: boolean;
  createdAt: string;
  updatedAt: string;
};

const globalStore = globalThis as typeof globalThis & {
  __novaPlatformStore?: {
    presence: PresenceState[];
    typing: TypingState[];
    callSessions: CallSession[];
    liveSessions: LiveSession[];
    notificationPreferences: Record<string, NotificationPreference[]>;
  };
};

if (!globalStore.__novaPlatformStore) {
  globalStore.__novaPlatformStore = {
    presence: [],
    typing: [],
    callSessions: [],
    liveSessions: [],
    notificationPreferences: {},
  };
}

function getStore() {
  return globalStore.__novaPlatformStore!;
}

function buildNotificationId() {
  return `notif_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function getNotificationPreferences(userId: string) {
  const preferences = getStore().notificationPreferences[userId] ?? [
    { key: 'social', enabled: true, channel: 'in_app' },
    { key: 'messages', enabled: true, channel: 'in_app' },
    { key: 'security', enabled: true, channel: 'in_app' },
    { key: 'live', enabled: true, channel: 'in_app' },
    { key: 'calls', enabled: true, channel: 'in_app' },
    { key: 'mentions', enabled: true, channel: 'in_app' },
  ];

  getStore().notificationPreferences[userId] = preferences;
  return [...preferences];
}

export function setNotificationPreferences(userId: string, updates: Partial<Record<NotificationPreference['key'], Partial<Pick<NotificationPreference, 'enabled' | 'channel'>>>>) {
  const current = getNotificationPreferences(userId);
  const next = current.map((pref) => {
    const patch = updates[pref.key];
    if (!patch) {
      return pref;
    }
    return {
      ...pref,
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.channel ? { channel: patch.channel } : {}),
    };
  });
  getStore().notificationPreferences[userId] = next;
  return [...next];
}

export async function createNotification(recipientId: string, actorId: string | null, type: string, message: string) {
  const dbAvailable = await isDatabaseAvailable();
  const base = {
    id: buildNotificationId(),
    recipientId,
    actorId,
    type,
    message,
    createdAt: new Date().toISOString(),
    readAt: null,
  };

  if (dbAvailable) {
    const record = await prisma.notification.create({
      data: {
        recipientId,
        actorId,
        type,
        message,
      },
    });

    realtimeHub.emit('notification:new', { notification: record, allowedUserIds: [recipientId] });
    return record;
  }

  socialStore.state.notifications.push(base);
  realtimeHub.emit('notification:new', { notification: base, allowedUserIds: [recipientId] });
  return base;
}

export async function listNotificationsForUser(userId: string, limit = 50) {
  const dbAvailable = await isDatabaseAvailable();
  if (dbAvailable) {
    const notifications = await prisma.notification.findMany({
      where: { recipientId: userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    const unreadCount = await prisma.notification.count({ where: { recipientId: userId, readAt: null } });
    return { notifications, unreadCount };
  }

  const notifications = socialStore.state.notifications
    .filter((notification) => notification.recipientId === userId)
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
    .slice(0, limit);

  const unreadCount = socialStore.state.notifications.filter((notification) => notification.recipientId === userId && !notification.readAt).length;
  return { notifications, unreadCount };
}

export async function markNotificationRead(notificationId: string, userId: string) {
  const dbAvailable = await isDatabaseAvailable();
  if (dbAvailable) {
    const notification = await prisma.notification.findFirst({ where: { id: notificationId, recipientId: userId }, select: { id: true, recipientId: true } });
    if (!notification) {
      return null;
    }
    const updated = await prisma.notification.update({ where: { id: notification.id }, data: { readAt: new Date() } });
    realtimeHub.emit('notification:read', { notificationId: updated.id, recipientId: updated.recipientId, allowedUserIds: [userId] });
    return updated;
  }

  const index = socialStore.state.notifications.findIndex((notification) => notification.id === notificationId && notification.recipientId === userId);
  if (index === -1) {
    return null;
  }
  socialStore.state.notifications[index].readAt = new Date().toISOString();
  realtimeHub.emit('notification:read', { notificationId, recipientId: userId, allowedUserIds: [userId] });
  return socialStore.state.notifications[index];
}

export async function markAllNotificationsRead(userId: string) {
  const dbAvailable = await isDatabaseAvailable();
  if (dbAvailable) {
    const affected = await prisma.notification.updateMany({ where: { recipientId: userId, readAt: null }, data: { readAt: new Date() } });
    realtimeHub.emit('notification:read', { recipientId: userId, all: true, allowedUserIds: [userId] });
    return affected.count;
  }

  const affected = socialStore.state.notifications.filter((notification) => notification.recipientId === userId && !notification.readAt);
  for (const notification of affected) {
    notification.readAt = new Date().toISOString();
  }
  realtimeHub.emit('notification:read', { recipientId: userId, all: true, allowedUserIds: [userId] });
  return affected.length;
}

export function setPresence(userId: string, next: { online?: boolean; status?: string; lastSeen?: string | null }) {
  const existing = getStore().presence.find((entry) => entry.userId === userId) ?? {
    userId,
    online: false,
    status: 'offline',
    lastSeen: null,
    updatedAt: new Date().toISOString(),
  };

  const record: PresenceState = {
    userId,
    online: next.online ?? existing.online,
    status: next.status ?? existing.status,
    lastSeen: next.lastSeen ?? (next.online === false ? new Date().toISOString() : existing.lastSeen),
    updatedAt: new Date().toISOString(),
  };

  const index = getStore().presence.findIndex((entry) => entry.userId === userId);
  if (index >= 0) {
    getStore().presence[index] = record;
  } else {
    getStore().presence.push(record);
  }

  realtimeHub.emit('presence:change', { ...record, allowedUserIds: [userId] });
  return { ...record };
}

export function getPresenceState(userId: string) {
  return getStore().presence.find((entry) => entry.userId === userId) ?? {
    userId,
    online: false,
    status: 'offline',
    lastSeen: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function setTypingState(conversationId: string, userId: string, isTyping: boolean) {
  const existing = getStore().typing.find((entry) => entry.conversationId === conversationId && entry.userId === userId);
  const record: TypingState = {
    conversationId,
    userId,
    isTyping,
    updatedAt: new Date().toISOString(),
  };

  if (existing) {
    Object.assign(existing, record);
  } else {
    getStore().typing.push(record);
  }

  const eventName = isTyping ? 'typing:start' : 'typing:stop';
  realtimeHub.emit(eventName, { conversationId, userId, isTyping, allowedUserIds: [userId] });
  return { ...record };
}

export function listCallHistory(userId: string) {
  return getStore().callSessions.filter((call) => call.participants.some((participant) => participant.userId === userId) && call.status !== 'cancelled');
}

export function createCallSession(input: { callerId: string; targetUserId: string | null; type: CallType; participants?: CallParticipantState[] }) {
  const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const participants: CallParticipantState[] = input.participants ?? [
    { userId: input.callerId, status: 'pending', muted: false, cameraOn: input.type === 'video', speakerOn: true },
    ...(input.targetUserId ? [{ userId: input.targetUserId, status: 'pending' as const, muted: false, cameraOn: input.type === 'video', speakerOn: true }] : []),
  ];

  const session: CallSession = {
    id: callId,
    callerId: input.callerId,
    targetUserId: input.targetUserId,
    type: input.type,
    status: 'ringing',
    participants,
    provider: 'local-dev',
    providerConfigured: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  getStore().callSessions.push(session);
  realtimeHub.emit('call:update', { call: session, allowedUserIds: participants.map((participant) => participant.userId) });
  return session;
}

export function getCallSession(callId: string) {
  return getStore().callSessions.find((call) => call.id === callId) ?? null;
}

export function updateCallSession(callId: string, changes: Partial<Pick<CallSession, 'status' | 'targetUserId' | 'type'>>, participantPatch?: Array<{ userId: string; muted?: boolean; cameraOn?: boolean; speakerOn?: boolean; status?: CallParticipantState['status'] }>) {
  const session = getStore().callSessions.find((entry) => entry.id === callId);
  if (!session) {
    return null;
  }

  if (changes.status) session.status = changes.status;
  if (changes.targetUserId !== undefined) session.targetUserId = changes.targetUserId;
  if (changes.type) session.type = changes.type;

  if (participantPatch) {
    for (const patch of participantPatch) {
      const participant = session.participants.find((entry) => entry.userId === patch.userId);
      if (!participant) {
        continue;
      }
      if (patch.status) participant.status = patch.status;
      if (patch.muted !== undefined) participant.muted = patch.muted;
      if (patch.cameraOn !== undefined) participant.cameraOn = patch.cameraOn;
      if (patch.speakerOn !== undefined) participant.speakerOn = patch.speakerOn;
    }
  }

  session.updatedAt = new Date().toISOString();
  realtimeHub.emit('call:update', { call: session, allowedUserIds: session.participants.map((participant) => participant.userId) });
  return session;
}

export function createLiveSession(input: { hostId: string; title: string; description?: string | null; visibility?: LiveVisibility; }) {
  const session: LiveSession = {
    id: `live_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    hostId: input.hostId,
    title: input.title,
    description: input.description ?? null,
    visibility: input.visibility ?? 'public',
    status: 'live',
    viewerCount: 0,
    moderators: [],
    viewers: [],
    comments: [],
    reactions: [],
    replayUrl: null,
    recordingUrl: null,
    analyticsHook: null,
    provider: 'local-dev',
    providerConfigured: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  getStore().liveSessions.push(session);
  realtimeHub.emit('live:update', { live: session, allowedUserIds: [input.hostId] });
  return session;
}

export function getLiveSession(liveId: string) {
  return getStore().liveSessions.find((session) => session.id === liveId) ?? null;
}

export function listLiveSessions() {
  return [...getStore().liveSessions].sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
}

export function updateLiveSession(liveId: string, updater: (session: LiveSession) => LiveSession) {
  const session = getStore().liveSessions.find((entry) => entry.id === liveId);
  if (!session) {
    return null;
  }

  const next = updater(session);
  next.updatedAt = new Date().toISOString();
  const index = getStore().liveSessions.findIndex((entry) => entry.id === liveId);
  getStore().liveSessions[index] = next;
  realtimeHub.emit('live:update', { live: next, allowedUserIds: [next.hostId, ...next.moderators, ...next.viewers.map((viewer) => viewer.userId)] });
  return next;
}

export function createAiProvider() {
  return {
    name: 'local-dev-mock',
    configured: false,
    async translateText(input: string, language: string) {
      return { provider: 'local-dev-mock', configured: false, language, output: input, note: 'No external translation provider configured.' };
    },
    async transcribeSpeech(audioBase64: string) {
      return { provider: 'local-dev-mock', configured: false, transcript: audioBase64 ? '[mock transcript unavailable without provider credentials]' : '', note: 'No speech provider configured.' };
    },
    async generateSmartReply(text: string) {
      return { provider: 'local-dev-mock', configured: false, suggestions: [text.trim() ? 'Thanks for the update.' : 'Let me think about that.'], note: 'No AI reply provider configured.' };
    },
    async generateCaptions(text: string) {
      return { provider: 'local-dev-mock', configured: false, captions: [text], note: 'No captioning provider configured.' };
    },
    async summarizeText(text: string) {
      return { provider: 'local-dev-mock', configured: false, summary: text.length > 180 ? `${text.slice(0, 180).trim()}...` : text, note: 'No summarization provider configured.' };
    },
    async moderateContent(input: { text?: string; type?: string }) {
      return { provider: 'local-dev-mock', configured: false, decision: 'ALLOW', reason: 'Using local safety rules only.', details: input };
    },
    async detectSpamScam(input: { text?: string; source?: string }) {
      return { provider: 'local-dev-mock', configured: false, risk: 'LOW', reason: 'No external scam detection provider connected.', details: input };
    },
  };
}

export function clearCommand2AStores() {
  getStore().presence = [];
  getStore().typing = [];
  getStore().callSessions = [];
  getStore().liveSessions = [];
  getStore().notificationPreferences = {};
}

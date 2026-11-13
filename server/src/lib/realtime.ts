export type RealtimeEvent =
  | 'message:new'
  | 'message:read'
  | 'message:delivered'
  | 'message:pinned'
  | 'conversation:unread'
  | 'conversation:read'
  | 'typing:start'
  | 'typing:stop'
  | 'presence:change'
  | 'recording:change'
  | 'notification:new'
  | 'notification:read'
  | 'call:update'
  | 'call:signal'
  | 'live:update'
  | 'live:feed:update'
  | 'live:signal';

export type RealtimeListener<T = unknown> = (payload: T) => void | Promise<void>;

class LocalRealtimeHub {
  private listeners = new Map<RealtimeEvent, Set<RealtimeListener<unknown>>>();

  subscribe<T>(event: RealtimeEvent, listener: RealtimeListener<T>) {
    const bucket = this.listeners.get(event) ?? new Set<RealtimeListener<unknown>>();
    bucket.add(listener as RealtimeListener<unknown>);
    this.listeners.set(event, bucket);

    return () => {
      bucket.delete(listener as RealtimeListener<unknown>);
      if (bucket.size === 0) {
        this.listeners.delete(event);
      }
    };
  }

  emit<T>(event: RealtimeEvent, payload: T) {
    const listeners = this.listeners.get(event);
    if (!listeners) {
      return;
    }

    for (const listener of listeners) {
      void listener(payload);
    }
  }
}

export const realtimeHub = new LocalRealtimeHub();

const realtimeConnections = new Map<string, Set<symbol>>();
const recordingTimers = new Map<string, ReturnType<typeof setTimeout>>();
const activeRecordings = new Map<string, { conversationId: string; userId: string; allowedUserIds: string[] }>();
const RECORDING_STALE_AFTER_MS = 25_000;

export function registerRealtimeConnection(userId: string, onPresenceChange: (online: boolean) => void) {
  const connectionId = Symbol(userId);
  const connections = realtimeConnections.get(userId) ?? new Set<symbol>();
  const wasOffline = connections.size === 0;
  connections.add(connectionId);
  realtimeConnections.set(userId, connections);
  if (wasOffline) onPresenceChange(true);

  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    const current = realtimeConnections.get(userId);
    current?.delete(connectionId);
    if (current?.size) return;
    realtimeConnections.delete(userId);
    clearUserRecordings(userId);
    onPresenceChange(false);
  };
}

export function isUserConnected(userId: string) {
  return Boolean(realtimeConnections.get(userId)?.size);
}

export function updateRecordingState(conversationId: string, userId: string, active: boolean, allowedUserIds: string[]) {
  const key = `${conversationId}:${userId}`;
  const previousTimer = recordingTimers.get(key);
  if (previousTimer) clearTimeout(previousTimer);

  if (!active) {
    recordingTimers.delete(key);
    if (activeRecordings.delete(key)) {
      emitConversationEvent('recording:change', conversationId, { userId, recording: false }, allowedUserIds);
    }
    return;
  }

  const wasActive = activeRecordings.has(key);
  activeRecordings.set(key, { conversationId, userId, allowedUserIds });
  const timer = setTimeout(() => {
    recordingTimers.delete(key);
    const recording = activeRecordings.get(key);
    if (!recording) return;
    activeRecordings.delete(key);
    emitConversationEvent('recording:change', conversationId, { userId, recording: false }, recording.allowedUserIds);
  }, RECORDING_STALE_AFTER_MS);
  timer.unref();
  recordingTimers.set(key, timer);
  if (!wasActive) emitConversationEvent('recording:change', conversationId, { userId, recording: true }, allowedUserIds);
}

function clearUserRecordings(userId: string) {
  for (const [key, recording] of activeRecordings) {
    if (recording.userId !== userId) continue;
    const timer = recordingTimers.get(key);
    if (timer) clearTimeout(timer);
    recordingTimers.delete(key);
    activeRecordings.delete(key);
    emitConversationEvent('recording:change', recording.conversationId, { userId, recording: false }, recording.allowedUserIds);
  }
}

export function subscribeToUserEvents(userId: string, listener: RealtimeListener) {
  const events: RealtimeEvent[] = ['message:new', 'message:read', 'message:delivered', 'message:pinned', 'typing:start', 'typing:stop', 'presence:change', 'recording:change', 'notification:new', 'notification:read', 'call:update', 'call:signal', 'live:update', 'live:feed:update', 'live:signal'];
  const unsubscribers = events.map((event) => realtimeHub.subscribe(event, (payload) => {
    if (typeof payload === 'object' && payload !== null && 'allowedUserIds' in payload) {
      const allowedUserIds = (payload as { allowedUserIds?: unknown }).allowedUserIds;
      if (Array.isArray(allowedUserIds) && allowedUserIds.includes(userId)) {
        return listener({ event, ...(payload as Record<string, unknown>) });
      }
    }
  }));

  return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
}

export function emitConversationEvent(
  event: RealtimeEvent,
  conversationId: string,
  payload: Record<string, unknown>,
  allowedUserIds: string[] = [],
) {
  realtimeHub.emit(event, {
    conversationId,
    allowedUserIds,
    ...payload,
  });
}

import { Router, type Request, type Response } from 'express';
import { TrackSource } from 'livekit-server-sdk';
import { z } from 'zod';
import { requireAuth, requireActiveAccountIfAuthenticated } from '../middleware/auth.js';
import { createCallSession, createLiveSession, createNotification, getCallSession, getLiveSession, getNotificationPreferences, listCallHistory, listLiveSessions, markAllNotificationsRead, markNotificationRead, restoreLiveSession, setNotificationPreferences, setPresence, setTypingState, updateCallSession, updateLiveSession, type LiveComment, type LiveReaction, type LiveViewer } from '../lib/platform.js';
import { socialStore } from '../lib/socialStore.js';
import { fallbackStore, findUserById } from '../lib/fallbackStore.js';
import { prisma, isDatabaseAvailable } from '../lib/prisma.js';
import { reviewContentForSafety } from '../lib/moderation.js';
import { callRoomName, createLiveKitToken, endLiveKitRoom, getLiveKitParticipants, isLiveKitConfigured, liveKitUrl, liveRoomName, removeLiveKitParticipant } from '../lib/livekit.js';
import { getMediaStorage, uploadedVideoBelongsTo, videoMediaKeyFromUrl } from '../lib/mediaStorage.js';
import { reviewContentForSafety as reviewPostContentForSafety } from '../lib/moderation.js';
import { canDeleteLiveReplayMedia, isLiveReplayOwner, isLiveReplayUploadRetry } from '../lib/liveReplayPolicy.js';
import { realtimeHub } from '../lib/realtime.js';
import { isLiveKitEgressConfigured, liveKitEgressMissingConfiguration, startLiveKitRoomEgress, stopLiveKitEgress } from '../lib/livekitEgress.js';
import { randomUUID } from 'node:crypto';

const command2aRouter = Router();
command2aRouter.use(requireActiveAccountIfAuthenticated);
const startingLiveIds = new Set<string>();
const startingRecordingIds = new Set<string>();

const notificationPreferenceSchema = z.object({
  key: z.enum(['social', 'messages', 'security', 'live', 'calls', 'mentions']),
  enabled: z.boolean().optional(),
  channel: z.enum(['in_app', 'email', 'push']).optional(),
});

const updatePresenceSchema = z.object({
  online: z.boolean().optional(),
  status: z.string().trim().min(1).max(64).optional(),
  lastSeen: z.string().datetime().nullable().optional(),
});

const typingSchema = z.object({
  isTyping: z.boolean(),
});

const callSchema = z.object({
  targetUserId: z.string().min(1).optional(),
  targetUserIds: z.array(z.string().min(1)).min(1).max(7).optional(),
  conversationId: z.string().min(1).optional(),
  type: z.enum(['voice', 'video']).default('voice'),
}).refine((payload) => Boolean(payload.targetUserId || payload.targetUserIds || payload.conversationId), {
  message: 'Choose at least one call participant or a group conversation.',
});
const callControlSchema = z.object({ muted: z.boolean().optional(), cameraOn: z.boolean().optional(), speakerOn: z.boolean().optional() });
const liveCreateSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).optional(),
  visibility: z.enum(['public', 'followers', 'private']).default('public'),
});

const liveCommentSchema = z.object({
  text: z.string().trim().min(1).max(500),
});

const liveReactionSchema = z.object({
  type: z.enum(['LIKE', 'LOVE', 'CLAP', 'CHEER']),
});
const liveReportSchema = z.object({
  category: z.enum(['SPAM', 'HARASSMENT', 'SEXUAL_CONTENT', 'HATE', 'VIOLENCE', 'SCAM', 'OTHER']),
  reason: z.string().trim().min(4).max(500),
});
const liveGuestSchema = z.object({ role: z.enum(['GUEST', 'COHOST']).default('GUEST') });
const liveGuestRecordSchema = z.array(z.object({
  userId: z.string().min(1),
  role: z.enum(['GUEST', 'COHOST']),
  status: z.enum(['REQUESTED', 'LIVE', 'REMOVED']),
  requestedAt: z.string().datetime(),
  admittedAt: z.string().datetime().optional(),
}));
const liveViewerControlSchema = z.object({ isMuted: z.boolean() });

async function canViewConversation(conversationId: string, userId: string) {
  const dbAvailable = await isDatabaseAvailable();
  if (dbAvailable) {
    const participant = await prisma.conversationParticipant.findFirst({ where: { conversationId, userId, leftAt: null }, select: { id: true } });
    return Boolean(participant);
  }
  return socialStore.state.conversationParticipants.some((participant) => participant.conversationId === conversationId && participant.userId === userId && !participant.leftAt);
}

async function isBlocked(userId: string, targetUserId: string) {
  const dbAvailable = await isDatabaseAvailable();
  if (dbAvailable) {
    const [left, right] = await Promise.all([
      prisma.block.findUnique({ where: { blockerId_blockedId: { blockerId: userId, blockedId: targetUserId } }, select: { id: true } }),
      prisma.block.findUnique({ where: { blockerId_blockedId: { blockerId: targetUserId, blockedId: userId } }, select: { id: true } }),
    ]);
    return Boolean(left || right);
  }
  return socialStore.state.blocks.some((block) => (block.blockerId === userId && block.blockedId === targetUserId) || (block.blockerId === targetUserId && block.blockedId === userId));
}

function isCallParticipant(call: NonNullable<ReturnType<typeof getCallSession>>, userId: string) {
  return call.participants.some((participant) => participant.userId === userId);
}

function canManageLive(live: NonNullable<ReturnType<typeof getLiveSession>>, userId: string) {
  return live.hostId === userId || live.moderators.includes(userId);
}

async function canViewLive(live: NonNullable<ReturnType<typeof getLiveSession>>, userId: string) {
  if (live.blockedUserIds.includes(userId)) return false;
  if (await isBlocked(userId, live.hostId)) return false;
  if (canManageLive(live, userId)) return true;
  if (live.visibility === 'private') return false;
  if (live.visibility === 'public') return true;
  if (await isDatabaseAvailable()) {
    return Boolean(await prisma.follow.findFirst({ where: { followerId: userId, followingId: live.hostId }, select: { id: true } }));
  }
  return socialStore.state.follows.some((follow) => follow.followerId === userId && follow.followingId === live.hostId);
}

async function publishLiveFeedPost(live: NonNullable<ReturnType<typeof getLiveSession>>) {
  const content = [live.title, live.description].filter(Boolean).join('\n\n');
  const visibility = live.visibility === 'public' ? 'PUBLIC' as const : live.visibility === 'followers' ? 'FOLLOWERS' as const : 'PRIVATE' as const;
  const replayUrl = live.recordingStatus === 'READY' ? live.replayUrl ?? null : null;
  if (await isDatabaseAvailable()) {
    await prisma.$transaction(async (transaction) => {
      await transaction.liveBroadcast.upsert({
        where: { id: live.id },
        create: {
          id: live.id,
          hostId: live.hostId,
          title: live.title,
          description: live.description,
          visibility: live.visibility,
          status: live.status,
          recordingStatus: live.recordingStatus,
          replayUrl: live.replayUrl,
          egressError: live.recordingError ?? null,
          moderators: live.moderators,
          blockedUserIds: live.blockedUserIds,
          mutedUserIds: live.mutedUserIds,
          guests: live.guests,
        },
        update: {
          status: live.status,
          recordingStatus: live.recordingStatus,
          replayUrl: live.replayUrl,
          egressError: live.recordingError ?? null,
          moderators: live.moderators,
          blockedUserIds: live.blockedUserIds,
          mutedUserIds: live.mutedUserIds,
          guests: live.guests,
        },
      });
      await transaction.post.upsert({
        where: { sourceLiveBroadcastId: live.id },
        create: {
          authorId: live.hostId,
          content,
          visibility,
          sourceLiveBroadcastId: live.id,
          imageUrl: replayUrl,
          createdAt: new Date(live.createdAt),
        },
        update: {
          content,
          visibility,
          imageUrl: replayUrl,
        },
      });
    });
    return;
  }

  const existing = socialStore.state.posts.find((post) => post.sourceLiveBroadcastId === live.id);
  if (existing) {
    existing.content = content;
    existing.visibility = visibility;
    existing.imageUrl = replayUrl;
    existing.updatedAt = new Date().toISOString();
    return;
  }
  const now = new Date().toISOString();
  socialStore.state.posts.push({
    id: `live_post_${live.id}`,
    authorId: live.hostId,
    content,
    imageUrl: null,
    visibility,
    sourceLiveBroadcastId: live.id,
    createdAt: live.createdAt,
    updatedAt: now,
  });
}

async function persistLiveSession(live: NonNullable<ReturnType<typeof getLiveSession>>, endedAt?: Date) {
  if (!(await isDatabaseAvailable())) return false;
  await prisma.liveBroadcast.upsert({
    where: { id: live.id },
    create: {
      id: live.id,
      hostId: live.hostId,
      title: live.title,
      description: live.description,
      visibility: live.visibility,
      status: live.status,
      recordingStatus: live.recordingStatus,
      replayUrl: live.replayUrl,
      egressError: live.recordingError ?? null,
      moderators: live.moderators,
      blockedUserIds: live.blockedUserIds,
      mutedUserIds: live.mutedUserIds,
      guests: live.guests,
      ...(endedAt ? { endedAt } : {}),
    },
    update: {
      title: live.title,
      description: live.description,
      visibility: live.visibility,
      status: live.status,
      recordingStatus: live.recordingStatus,
      replayUrl: live.replayUrl,
      egressError: live.recordingError ?? null,
      moderators: live.moderators,
      blockedUserIds: live.blockedUserIds,
      mutedUserIds: live.mutedUserIds,
      guests: live.guests,
      ...(endedAt ? { endedAt } : {}),
    },
  });
  return true;
}

function liveSessionFromRecord(record: {
  id: string;
  hostId: string;
  title: string;
  description: string | null;
  visibility: string;
  status: string;
  recordingStatus: string;
  replayUrl: string | null;
  egressError?: string | null;
  moderators: string[];
  blockedUserIds: string[];
  mutedUserIds: string[];
  guests: unknown;
  createdAt: Date;
  updatedAt: Date;
  viewers?: Array<{ userId: string; joinedAt: Date; lastSeenAt: Date; connectedAt: Date | null }>;
  comments?: Array<{ id: string; userId: string; text: string; createdAt: Date }>;
  reactions?: Array<{ id: string; userId: string; type: string; createdAt: Date }>;
}) {
  const guests = liveGuestRecordSchema.parse(record.guests);
  const stageUserIds = new Set([
    record.hostId,
    ...guests.filter((guest) => guest.status === 'LIVE' && guest.admittedAt).map((guest) => guest.userId),
  ]);
  const viewers = (record.viewers ?? [])
    .filter((viewer) => viewer.connectedAt !== null)
    .filter((viewer) => !stageUserIds.has(viewer.userId))
    .map((viewer) => ({
      userId: viewer.userId,
      isMuted: record.mutedUserIds.includes(viewer.userId),
      isBlocked: record.blockedUserIds.includes(viewer.userId),
      joinedAt: viewer.lastSeenAt.toISOString(),
    }));
  return {
    id: record.id,
    hostId: record.hostId,
    title: record.title,
    description: record.description,
    visibility: record.visibility as 'public' | 'followers' | 'private',
    status: record.status as 'live' | 'paused' | 'ended',
    viewerCount: viewers.length,
    moderators: record.moderators,
    blockedUserIds: record.blockedUserIds,
    mutedUserIds: record.mutedUserIds,
    viewers,
    guests,
    comments: (record.comments ?? []).slice().reverse().map((comment): LiveComment => ({
      id: comment.id,
      userId: comment.userId,
      text: comment.text,
      createdAt: comment.createdAt.toISOString(),
    })),
    reactions: (record.reactions ?? []).slice().reverse().map((reaction): LiveReaction => ({
      id: reaction.id,
      userId: reaction.userId,
      type: liveReactionSchema.shape.type.parse(reaction.type),
      createdAt: reaction.createdAt.toISOString(),
    })),
    replayUrl: record.replayUrl,
    recordingUrl: record.replayUrl,
    recordingStatus: record.recordingStatus as 'UNAVAILABLE' | 'RECORDING' | 'PROCESSING' | 'READY',
    recordingError: record.egressError ?? null,
    analyticsHook: null,
    provider: 'livekit' as const,
    providerConfigured: isLiveKitConfigured(),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function liveViewerSnapshot(live: NonNullable<ReturnType<typeof getLiveSession>>, records: Array<{ userId: string; lastSeenAt: Date }>) {
  const stageUserIds = new Set([
    live.hostId,
    ...live.guests.filter((guest) => guest.status === 'LIVE' && guest.admittedAt).map((guest) => guest.userId),
  ]);
  const viewers = records
    .filter((viewer) => !stageUserIds.has(viewer.userId))
    .map((viewer) => ({
      userId: viewer.userId,
      isMuted: live.mutedUserIds.includes(viewer.userId),
      isBlocked: live.blockedUserIds.includes(viewer.userId),
      joinedAt: viewer.lastSeenAt.toISOString(),
    }));
  return { viewers, viewerCount: viewers.length };
}

async function getActiveLiveViewerRecords(liveId: string) {
  return prisma.liveBroadcastViewer.findMany({
    where: { liveId, connectedAt: { not: null }, lastSeenAt: { gte: new Date(Date.now() - 60_000) } },
    select: { userId: true, lastSeenAt: true },
  });
}

async function loadLiveSession(liveId: string) {
  if (await isDatabaseAvailable()) {
    const record = await prisma.liveBroadcast.findUnique({
      where: { id: liveId },
      include: { viewers: { where: { connectedAt: { not: null }, lastSeenAt: { gte: new Date(Date.now() - 60_000) } } } },
    });
    if (!record) return null;
    const [comments, reactions] = await Promise.all([
      prisma.liveBroadcastComment.findMany({
        where: { liveId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      prisma.liveBroadcastReaction.findMany({
        where: { liveId },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    ]);
    return restoreLiveSession(liveSessionFromRecord({ ...record, comments, reactions }));
  }
  return getLiveSession(liveId);
}

async function clearLiveReplayFromSession(liveId: string) {
  const live = await loadLiveSession(liveId);
  if (!live) return;
  const updated = {
    ...live,
    recordingStatus: 'UNAVAILABLE' as const,
    replayUrl: null,
    recordingUrl: null,
  };
  const next = updateLiveSession(liveId, (session) => ({ ...session, ...updated }));
  const current = next ?? updated;
  await persistLiveSession(current);
  await publishLiveFeedPost(current);
  await emitLiveFeedUpdate(current);
}

async function canInteractWithLive(live: NonNullable<ReturnType<typeof getLiveSession>>, userId: string) {
  if (!(await canViewLive(live, userId))) return false;
  if (canManageLive(live, userId)) return true;
  const admittedGuest = live.guests.some((guest) => guest.userId === userId && guest.status === 'LIVE' && guest.admittedAt);
  if (admittedGuest) return !live.mutedUserIds.includes(userId);
  return !live.mutedUserIds.includes(userId)
    && live.viewers.some((viewer) => viewer.userId === userId && !viewer.isBlocked && !viewer.isMuted);
}

async function recordLiveModeration(liveId: string, actorId: string, actionType: string, targetUserId?: string, details?: string) {
  const auditDetails = JSON.stringify({ liveId, ...(details ? { details } : {}) });
  if (await isDatabaseAvailable()) {
    await prisma.adminAction.create({
      data: { actorId, actionType, details: auditDetails, ...(targetUserId ? { targetUserId } : {}) },
    });
    return;
  }
  fallbackStore.createAdminAction({ actorId, actionType, details: auditDetails, ...(targetUserId ? { targetUserId } : {}) });
}

function liveForAudience(live: NonNullable<ReturnType<typeof getLiveSession>>, userId: string) {
  const isManager = canManageLive(live, userId);
  return {
    ...live,
    recordingError: isManager ? live.recordingError ?? null : null,
    moderators: isManager ? live.moderators : [],
    blockedUserIds: isManager ? live.blockedUserIds : [],
    mutedUserIds: isManager ? live.mutedUserIds : [],
    viewers: isManager ? live.viewers : [],
    guests: isManager
      ? live.guests
      : live.guests.filter((guest) => guest.status === 'LIVE' || guest.userId === userId),
  };
}

async function presentLive(live: NonNullable<ReturnType<typeof getLiveSession>>, userId: string) {
  const databaseAvailable = await isDatabaseAvailable();
  const host = await (databaseAvailable
    ? prisma.user.findUnique({ where: { id: live.hostId }, select: { name: true, profile: { select: { avatarUrl: true } } } })
    : Promise.resolve(findUserById(live.hostId)));
  const comments = databaseAvailable
    ? (await prisma.liveBroadcastComment.findMany({
      where: { liveId: live.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })).reverse().map((comment) => ({ id: comment.id, userId: comment.userId, text: comment.text, createdAt: comment.createdAt.toISOString() }))
    : live.comments;
  return {
    ...liveForAudience(live, userId),
    comments,
    host: host ? { name: host.name, avatar: 'profile' in host ? host.profile?.avatarUrl ?? null : null } : null,
    egressConfigured: isLiveKitEgressConfigured(),
    egressMissingConfiguration: canManageLive(live, userId) ? liveKitEgressMissingConfiguration() : [],
  };
}

async function notifyLiveAudience(liveId: string, hostId: string, hostName: string, title: string) {
  const audienceIds = new Set<string>();
  if (await isDatabaseAvailable()) {
    const follows = await prisma.follow.findMany({
      where: { OR: [{ followingId: hostId }, { followerId: hostId }] },
      select: { followerId: true, followingId: true },
    });
    for (const follow of follows) {
      if (follow.followingId === hostId && follow.followerId !== hostId) audienceIds.add(follow.followerId);
    }
    if (!audienceIds.size) return;
    const recipients = await prisma.user.findMany({
      where: { id: { in: [...audienceIds] }, status: 'ACTIVE' },
      select: { id: true },
    });
    const eligibleIds = new Set(recipients.map((recipient) => recipient.id));
    const blocks = await prisma.block.findMany({
      where: {
        OR: [
          { blockerId: hostId, blockedId: { in: [...eligibleIds] } },
          { blockerId: { in: [...eligibleIds] }, blockedId: hostId },
        ],
      },
      select: { blockerId: true, blockedId: true },
    });
    for (const block of blocks) eligibleIds.delete(block.blockerId === hostId ? block.blockedId : block.blockerId);
    await Promise.all([...eligibleIds].map((recipientId) => createNotification(
      recipientId,
      hostId,
      'live_started',
      `${hostName} is live now: ${title}`,
      { link: `/live?live=${encodeURIComponent(liveId)}`, dedupeKey: `live_started:${liveId}:${recipientId}` },
    )));
    return;
  }

  for (const follow of socialStore.state.follows) {
    if (follow.followingId === hostId) audienceIds.add(follow.followerId);
  }
  await Promise.all([...audienceIds].filter((recipientId) => {
    const recipient = findUserById(recipientId);
    return recipient?.status === 'ACTIVE' && recipientId !== hostId
      && !socialStore.state.blocks.some((block) =>
        (block.blockerId === hostId && block.blockedId === recipientId)
        || (block.blockerId === recipientId && block.blockedId === hostId),
      );
  }).map((recipientId) => createNotification(
    recipientId,
    hostId,
    'live_started',
    `${hostName} is live now: ${title}`,
    { link: `/live?live=${encodeURIComponent(liveId)}`, dedupeKey: `live_started:${liveId}:${recipientId}` },
  )));
}

async function liveFeedAudienceUserIds(live: NonNullable<ReturnType<typeof getLiveSession>>) {
  if (live.visibility === 'private') return [live.hostId];
  if (await isDatabaseAvailable()) {
    const candidateIds = live.visibility === 'public'
      ? (await prisma.user.findMany({ where: { status: 'ACTIVE' }, select: { id: true } })).map((user) => user.id)
      : (await prisma.follow.findMany({ where: { followingId: live.hostId }, select: { followerId: true } }))
        .map((follow) => follow.followerId);
    const recipientIds = candidateIds.filter((userId) =>
      userId !== live.hostId && !live.blockedUserIds.includes(userId),
    );
    if (!recipientIds.length) return [live.hostId];
    const [activeUsers, blocks] = await Promise.all([
      prisma.user.findMany({ where: { id: { in: recipientIds }, status: 'ACTIVE' }, select: { id: true } }),
      prisma.block.findMany({
        where: {
          OR: [
            { blockerId: live.hostId, blockedId: { in: recipientIds } },
            { blockerId: { in: recipientIds }, blockedId: live.hostId },
          ],
        },
        select: { blockerId: true, blockedId: true },
      }),
    ]);
    const blockedIds = new Set(blocks.map((block) => block.blockerId === live.hostId ? block.blockedId : block.blockerId));
    return [live.hostId, ...activeUsers.map((user) => user.id).filter((userId) => !blockedIds.has(userId))];
  }
  const candidateIds = live.visibility === 'public'
    ? fallbackStore.list().map((user) => user.id)
    : socialStore.state.follows
      .filter((follow) => follow.followingId === live.hostId)
      .map((follow) => follow.followerId);
  const followers = candidateIds
    .filter((userId) => userId !== live.hostId && !live.blockedUserIds.includes(userId))
    .filter((userId) => findUserById(userId)?.status === 'ACTIVE')
    .filter((userId) => !socialStore.state.blocks.some((block) =>
      (block.blockerId === live.hostId && block.blockedId === userId)
      || (block.blockerId === userId && block.blockedId === live.hostId),
    ));
  return [live.hostId, ...followers];
}

async function emitLiveFeedUpdate(live: NonNullable<ReturnType<typeof getLiveSession>>) {
  realtimeHub.emit('live:feed:update', {
    live: { id: live.id },
    allowedUserIds: await liveFeedAudienceUserIds(live),
  });
}

command2aRouter.get('/notifications', requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);
  const { notifications, unreadCount } = await (await import('../lib/platform.js')).listNotificationsForUser(userId, limit);
  return res.json({ notifications, unreadCount, totalCount: notifications.length });
});

command2aRouter.post('/notifications/:id/read', requireAuth, async (req, res) => {
  const item = await markNotificationRead(String(req.params.id), req.user!.id);
  if (!item) {
    return res.status(404).json({ message: 'Notification not found.' });
  }
  return res.json({ notification: item, message: 'Notification marked as read.' });
});

command2aRouter.post('/notifications/read-all', requireAuth, async (req, res) => {
  const count = await markAllNotificationsRead(req.user!.id);
  return res.json({ message: 'All notifications marked as read.', count });
});

command2aRouter.get('/notifications/preferences', requireAuth, async (req, res) => {
  return res.json({ preferences: await getNotificationPreferences(req.user!.id) });
});

command2aRouter.put('/notifications/preferences', requireAuth, async (req, res) => {
  const payload = notificationPreferenceSchema.parse(req.body ?? {});
  const next = await setNotificationPreferences(req.user!.id, { [payload.key]: { enabled: payload.enabled, channel: payload.channel } });
  return res.json({ preferences: next });
});

command2aRouter.post('/presence', requireAuth, async (req, res) => {
  const payload = updatePresenceSchema.parse(req.body ?? {});
  const state = setPresence(req.user!.id, payload);
  return res.json({ presence: state });
});

command2aRouter.get('/presence/:userId', requireAuth, async (req, res) => {
  const userId = String(req.params.userId);
  const target = findUserById(userId);
  if (!target) {
    return res.status(404).json({ message: 'User not found.' });
  }

  const presence = (await import('../lib/platform.js')).getPresenceState(userId);
  return res.json({ userId, presence });
});

command2aRouter.post('/conversations/:id/typing', requireAuth, async (req, res) => {
  const conversationId = String(req.params.id);
  const userId = req.user!.id;
  const payload = typingSchema.parse(req.body ?? {});

  if (!(await canViewConversation(conversationId, userId))) {
    return res.status(404).json({ message: 'Conversation not found.' });
  }

  const typing = setTypingState(conversationId, userId, payload.isTyping);
  return res.json({ typing });
});

command2aRouter.post('/calls/start', requireAuth, async (req, res) => {
  if (!isLiveKitConfigured()) return res.status(503).json({ message: 'Calls are unavailable because LiveKit is not configured.' });
  const payload = callSchema.parse(req.body ?? {});
  const userId = req.user!.id;
  let targetUserIds = payload.targetUserIds ?? (payload.targetUserId ? [payload.targetUserId] : []);

  if (payload.conversationId) {
    if (!(await canViewConversation(payload.conversationId, userId))) return res.status(404).json({ message: 'Group conversation not found.' });
    const members = await isDatabaseAvailable()
      ? (await prisma.conversationParticipant.findMany({ where: { conversationId: payload.conversationId, leftAt: null }, select: { userId: true } })).map((member) => member.userId)
      : socialStore.state.conversationParticipants.filter((member) => member.conversationId === payload.conversationId && !member.leftAt).map((member) => member.userId);
    const conversationTargets = members.filter((memberId) => memberId !== userId);
    if (targetUserIds.length && targetUserIds.some((memberId) => !conversationTargets.includes(memberId))) {
      return res.status(403).json({ message: 'Every call participant must belong to the selected conversation.' });
    }
    if (!targetUserIds.length) targetUserIds = conversationTargets;
  }

  if (!targetUserIds.length || targetUserIds.length > 7) return res.status(400).json({ message: 'Calls support one to seven other participants.' });
  if (new Set(targetUserIds).size !== targetUserIds.length || targetUserIds.includes(userId)) {
    return res.status(400).json({ message: 'Call participants must be unique and cannot include you.' });
  }

  const dbAvailable = await isDatabaseAvailable();
  if (dbAvailable) {
    const found = await prisma.user.findMany({ where: { id: { in: targetUserIds } }, select: { id: true } });
    if (found.length !== targetUserIds.length) return res.status(404).json({ message: 'Call participant not found.' });
  } else if (targetUserIds.some((targetId) => !findUserById(targetId))) {
    return res.status(404).json({ message: 'Call participant not found.' });
  }
  for (const targetId of targetUserIds) {
    if (await isBlocked(userId, targetId)) return res.status(403).json({ message: 'You cannot call a user who has blocked you or who you have blocked.' });
  }

  const call = createCallSession(userId, targetUserIds, payload.type, payload.conversationId);
  return res.status(201).json({ call, message: 'Call started. Connecting to LiveKit.' });
});

command2aRouter.get('/calls/history', requireAuth, async (req, res) => {
  const history = listCallHistory(req.user!.id);
  return res.json({ calls: history });
});

command2aRouter.get('/calls/:id', requireAuth, async (req, res) => {
  const call = getCallSession(String(req.params.id));
  if (!call) {
    return res.status(404).json({ message: 'Call not found.' });
  }

  if (!isCallParticipant(call, req.user!.id)) {
    return res.status(403).json({ message: 'You do not have access to this call.' });
  }

  return res.json({ call });
});

command2aRouter.post('/calls/:id/token', requireAuth, async (req, res) => {
  const call = getCallSession(String(req.params.id));
  if (!call) return res.status(404).json({ message: 'Call not found.' });
  const userId = req.user!.id;
  if (!isCallParticipant(call, userId)) return res.status(403).json({ message: 'You do not have access to this call.' });
  if (!isLiveKitConfigured()) return res.status(503).json({ message: 'Calls are unavailable because LiveKit is not configured.' });
  if (!['ringing', 'outgoing', 'connected'].includes(call.status)) return res.status(409).json({ message: 'This call is no longer active.' });
  const participant = call.participants.find((entry) => entry.userId === userId)!;
  for (const other of call.participants) {
    if (other.userId !== userId && other.status !== 'left' && await isBlocked(userId, other.userId)) {
      return res.status(403).json({ message: 'Blocked users cannot join this call.' });
    }
  }
  const mayJoin = userId === call.callerId
    ? participant.status !== 'left'
    : participant.status === 'accepted' || participant.status === 'connected';
  if (!mayJoin) return res.status(403).json({ message: 'Accept the incoming call before joining its media room.' });
  const room = callRoomName(call.id);
  const canPublishSources = call.type === 'video'
    ? [TrackSource.MICROPHONE, TrackSource.CAMERA]
    : [TrackSource.MICROPHONE];
  const token = await createLiveKitToken({ identity: userId, name: req.user!.name, room, canPublish: true, canPublishSources });
  return res.set('Cache-Control', 'no-store').json({ token, url: liveKitUrl(), room });
});

command2aRouter.post('/calls/:id/connected', requireAuth, async (req, res) => {
  const call = getCallSession(String(req.params.id));
  if (!call) return res.status(404).json({ message: 'Call not found.' });
  const userId = req.user!.id;
  if (!isCallParticipant(call, userId)) return res.status(403).json({ message: 'You do not have access to this call.' });
  if (['ended', 'cancelled', 'rejected', 'missed'].includes(call.status)) return res.status(409).json({ message: 'This call is no longer active.' });
  if (call.participants.find((participant) => participant.userId === userId)?.status === 'left') {
    return res.status(403).json({ message: 'You have left this call.' });
  }
  let roomParticipants: Awaited<ReturnType<typeof getLiveKitParticipants>>;
  try {
    roomParticipants = await getLiveKitParticipants(callRoomName(call.id));
  } catch {
    return res.status(503).json({ message: 'LiveKit could not verify the call media connection.' });
  }
  const connectedUserIds = new Set(roomParticipants.map((participant) => participant.identity));
  const requiredSources = call.type === 'video'
    ? [TrackSource.MICROPHONE, TrackSource.CAMERA]
    : [TrackSource.MICROPHONE];
  const connectedParticipantIds = call.participants
    .filter((participant) => participant.status !== 'left' && connectedUserIds.has(participant.userId))
    .filter((participant) => {
      const roomParticipant = roomParticipants.find((entry) => entry.identity === participant.userId);
      const publishedSources = new Set(roomParticipant?.tracks.filter((track) => !track.muted).map((track) => track.source) ?? []);
      return requiredSources.every((source) => publishedSources.has(source));
    })
    .map((participant) => participant.userId);
  if (!connectedParticipantIds.includes(userId)) {
    return res.status(409).json({ message: 'Your LiveKit media has not connected to this call.' });
  }
  if (connectedParticipantIds.length < 2) {
    return res.status(409).json({ message: 'A second call participant has not connected to LiveKit yet.' });
  }
  const participantPatch = connectedParticipantIds.map((connectedUserId) => ({ userId: connectedUserId, status: 'connected' as const }));
  const next = updateCallSession(call.id, { status: 'connected' }, participantPatch);
  return res.json({ call: next });
});

command2aRouter.post('/calls/:id/accept', requireAuth, async (req, res) => {
  const call = getCallSession(String(req.params.id));
  if (!call) {
    return res.status(404).json({ message: 'Call not found.' });
  }
  if (!isCallParticipant(call, req.user!.id)) {
    return res.status(403).json({ message: 'You do not have access to this call.' });
  }
  if (!call.providerConfigured) {
    return res.status(503).json({ message: 'This call cannot connect because LiveKit is not configured.' });
  }

  if (call.status !== 'ringing') return res.status(409).json({ message: 'This call is no longer waiting for an answer.' });
  if (call.callerId === req.user!.id || call.participants.find((participant) => participant.userId === req.user!.id)?.status !== 'pending') {
    return res.status(409).json({ message: 'Only a pending invitee can accept this call.' });
  }
  const next = updateCallSession(call.id, {}, [{ userId: req.user!.id, status: 'accepted' }]);
  return res.json({ call: next, message: 'Call accepted. Establishing the encrypted media connection.' });
});

command2aRouter.post('/calls/:id/reject', requireAuth, async (req, res) => {
  const call = getCallSession(String(req.params.id));
  if (!call) {
    return res.status(404).json({ message: 'Call not found.' });
  }
  if (!isCallParticipant(call, req.user!.id)) {
    return res.status(403).json({ message: 'You do not have access to this call.' });
  }
  if (call.callerId === req.user!.id || call.participants.find((participant) => participant.userId === req.user!.id)?.status !== 'pending') {
    return res.status(409).json({ message: 'Only a pending invitee can decline this call.' });
  }
  const allTargetsRejected = call.participants.filter((participant) => participant.userId !== call.callerId)
    .every((participant) => participant.userId === req.user!.id || participant.status === 'left');
  const next = updateCallSession(call.id, allTargetsRejected ? { status: 'rejected' } : {}, [{ userId: req.user!.id, status: 'left' }]);
  return res.json({ call: next, message: allTargetsRejected ? 'Call rejected.' : 'Call declined.' });
});

command2aRouter.post('/calls/:id/cancel', requireAuth, async (req, res) => {
  const call = getCallSession(String(req.params.id));
  if (!call) {
    return res.status(404).json({ message: 'Call not found.' });
  }
  if (call.callerId !== req.user!.id) {
    return res.status(403).json({ message: 'Only the caller can cancel this call.' });
  }

  const next = updateCallSession(call.id, { status: 'cancelled' });
  return res.json({ call: next, message: 'Call cancelled.' });
});

command2aRouter.post('/calls/:id/end', requireAuth, async (req, res) => {
  const call = getCallSession(String(req.params.id));
  if (!call) {
    return res.status(404).json({ message: 'Call not found.' });
  }
  if (!isCallParticipant(call, req.user!.id)) {
    return res.status(403).json({ message: 'You do not have access to this call.' });
  }

  const next = updateCallSession(call.id, { status: 'ended' });
  return res.json({ call: next, message: 'Call ended.' });
});

command2aRouter.post('/calls/:id/leave', requireAuth, async (req, res) => {
  const call = getCallSession(String(req.params.id));
  if (!call) return res.status(404).json({ message: 'Call not found.' });
  if (!isCallParticipant(call, req.user!.id)) return res.status(403).json({ message: 'You do not have access to this call.' });
  const allTargetsRejected = call.participants.every((participant) => participant.userId === req.user!.id || participant.status === 'left');
  const next = updateCallSession(call.id, allTargetsRejected ? { status: 'ended' } : {}, [{ userId: req.user!.id, status: 'left' }]);
  return res.json({ call: next, message: allTargetsRejected ? 'Call ended.' : 'You left the call.' });
});

command2aRouter.post('/calls/:id/mute', requireAuth, async (req, res) => {
  const call = getCallSession(String(req.params.id));
  if (!call) {
    return res.status(404).json({ message: 'Call not found.' });
  }
  if (!isCallParticipant(call, req.user!.id)) return res.status(403).json({ message: 'You do not have access to this call.' });
  const payload = callControlSchema.parse(req.body ?? {});
  if (payload.muted === undefined) return res.status(400).json({ message: 'muted is required.' });
  const muted = payload.muted;
  const next = updateCallSession(call.id, {}, [{ userId: req.user!.id, muted }]);
  return res.json({ call: next });
});

command2aRouter.post('/calls/:id/camera', requireAuth, async (req, res) => {
  const call = getCallSession(String(req.params.id));
  if (!call) {
    return res.status(404).json({ message: 'Call not found.' });
  }
  if (!isCallParticipant(call, req.user!.id)) return res.status(403).json({ message: 'You do not have access to this call.' });
  const payload = callControlSchema.parse(req.body ?? {});
  if (payload.cameraOn === undefined) return res.status(400).json({ message: 'cameraOn is required.' });
  const cameraOn = payload.cameraOn;
  const next = updateCallSession(call.id, {}, [{ userId: req.user!.id, cameraOn }]);
  return res.json({ call: next });
});

command2aRouter.post('/calls/:id/speaker', requireAuth, async (req, res) => {
  const call = getCallSession(String(req.params.id));
  if (!call) return res.status(404).json({ message: 'Call not found.' });
  if (!isCallParticipant(call, req.user!.id)) return res.status(403).json({ message: 'You do not have access to this call.' });
  const payload = callControlSchema.parse(req.body ?? {});
  if (payload.speakerOn === undefined) return res.status(400).json({ message: 'speakerOn is required.' });
  const next = updateCallSession(call.id, {}, [{ userId: req.user!.id, speakerOn: payload.speakerOn }]);
  return res.json({ call: next });
});

command2aRouter.post('/live/create', requireAuth, async (req, res) => {
  const payload = liveCreateSchema.parse(req.body ?? {});
  const moderation = reviewContentForSafety({
    type: 'post',
    text: [payload.title, payload.description].filter(Boolean).join('\n\n'),
    userId: req.user!.id,
  });
  if (moderation === 'REMOVE') return res.status(400).json({ message: 'This live title or description violates NOVA Community & Safety Rules.' });
  if (moderation === 'REVIEW') return res.status(422).json({ message: 'This live title or description requires moderator review.' });
  const live = createLiveSession(req.user!.id, payload);
  await persistLiveSession(live);
  return res.status(201).json({ live, message: 'Live session created. Start broadcasting to publish through LiveKit.' });
});

command2aRouter.get('/live', requireAuth, async (req, res) => {
  const cutoff = Date.now() - 60_000;
  const liveById = new Map<string, NonNullable<ReturnType<typeof getLiveSession>>>();
  if (await isDatabaseAvailable()) {
    const persisted = await prisma.liveBroadcast.findMany({
      where: { OR: [{ visibility: 'public' }, { visibility: 'followers' }, { hostId: req.user!.id }, { moderators: { has: req.user!.id } }] },
      include: { viewers: { where: { connectedAt: { not: null }, lastSeenAt: { gte: new Date(cutoff) } } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    for (const record of persisted) {
      const live = restoreLiveSession(liveSessionFromRecord(record));
      liveById.set(record.id, live);
    }
  } else {
    for (const live of listLiveSessions()) {
      if (live.status !== 'live') {
        liveById.set(live.id, live);
        continue;
      }
      const viewers = live.viewers.filter((viewer) => new Date(viewer.joinedAt).getTime() >= cutoff);
      liveById.set(live.id, updateLiveSession(live.id, (session) => ({ ...session, viewers, viewerCount: viewers.length })) ?? live);
    }
  }
  const visibleLives = await Promise.all([...liveById.values()].map(async (live) =>
    await canViewLive(live, req.user!.id) ? live : null,
  ));
  const lives = visibleLives.filter((live): live is NonNullable<typeof live> => live !== null)
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
    .slice(0, 100);
  return res.json({ lives: await Promise.all(lives.map((live) => presentLive(live, req.user!.id))) });
});

command2aRouter.get('/live/replays', requireAuth, async (req, res) => {
  if (!(await isDatabaseAvailable())) return res.status(503).json({ message: 'Persistent replay storage is unavailable. Configure the server DATABASE_URL, apply Prisma migrations, and ensure PostgreSQL is reachable.' });
  const replays = await prisma.liveReplay.findMany({
    where: { hostId: req.user!.id, status: { in: ['READY', 'PUBLISHED', 'DELETING'] } },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  return res.json({ replays });
});

command2aRouter.get('/live/:id', requireAuth, async (req, res) => {
  const live = await loadLiveSession(String(req.params.id));
  if (!live) {
    return res.status(404).json({ message: 'Live session not found.' });
  }
  if (!(await canViewLive(live, req.user!.id))) {
    return res.status(404).json({ message: 'Live session not found.' });
  }
  return res.json({ live: await presentLive(live, req.user!.id) });
});

command2aRouter.post('/live/:id/start', requireAuth, async (req, res) => {
  const live = await loadLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (live.hostId !== req.user!.id) return res.status(403).json({ message: 'Only the host can start this live session.' });
  if (!isLiveKitConfigured()) return res.status(503).json({ message: 'Live broadcasts are unavailable because LiveKit is not configured.' });
  if (live.status === 'live') {
    await publishLiveFeedPost(live);
    await emitLiveFeedUpdate(live);
    return res.json({ live, message: 'Live session is already running.' });
  }
  if (live.status !== 'paused' || startingLiveIds.has(live.id)) return res.status(409).json({ message: 'This live session cannot be started in its current state.' });
  startingLiveIds.add(live.id);
  try {
    let participants;
    try {
      participants = await getLiveKitParticipants(liveRoomName(live.id));
    } catch {
      return res.status(503).json({ message: 'LiveKit could not verify the host broadcast.' });
    }
    const host = participants.find((participant) => participant.identity === live.hostId);
    const publishedSources = new Set(host?.tracks.filter((track) => !track.muted).map((track) => track.source) ?? []);
    if (!publishedSources.has(TrackSource.CAMERA) || !publishedSources.has(TrackSource.MICROPHONE)) {
      return res.status(409).json({ message: 'The host camera and microphone must be published before starting the live session.' });
    }
    if (await isDatabaseAvailable()) {
      const claimed = await prisma.liveBroadcast.updateMany({
        where: { id: live.id, hostId: live.hostId, status: 'paused' },
        data: { status: 'live' },
      });
      if (claimed.count === 0) {
        const latest = await loadLiveSession(live.id);
        if (latest?.status !== 'live') return res.status(409).json({ message: 'This live session cannot be started in its current state.' });
        await publishLiveFeedPost(latest);
        return res.json({ live: latest, message: 'Live session is already running.' });
      }
    }
    const latest = getLiveSession(live.id);
    if (!latest || latest.status !== 'paused') return res.status(409).json({ message: 'This live session cannot be started in its current state.' });
    const startedLive = { ...latest, status: 'live' as const, viewerCount: Math.max(0, latest.viewerCount) };
    await publishLiveFeedPost(startedLive);
    const next = updateLiveSession(live.id, (session) => ({ ...session, status: 'live', viewerCount: Math.max(0, session.viewerCount) }));
    let notificationWarning = false;
    if (next?.visibility === 'public' || next?.visibility === 'followers') {
      try {
        await notifyLiveAudience(next.id, next.hostId, req.user!.name, next.title);
      } catch {
        notificationWarning = true;
      }
    }
    if (next) await emitLiveFeedUpdate(next);
    return res.json({ live: next, message: 'Live session started.', notificationWarning });
  } finally {
    startingLiveIds.delete(live.id);
  }
});

command2aRouter.post('/live/:id/token', requireAuth, async (req, res) => {
  const live = await loadLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (!isLiveKitConfigured()) return res.status(503).json({ message: 'Live broadcasts are unavailable because LiveKit is not configured.' });
  const userId = req.user!.id;
  const isHost = live.hostId === userId;
  const guest = live.guests.find((entry) => entry.userId === userId && entry.status === 'LIVE');
  const canPublish = isHost;
  if (isHost) {
    if (live.status !== 'paused' && live.status !== 'live') return res.status(409).json({ message: 'This live session is no longer active.' });
  } else {
    const viewer = live.viewers.find((entry) => entry.userId === userId && !entry.isBlocked);
    const pendingJoin = !viewer && await isDatabaseAvailable()
      ? await prisma.liveBroadcastViewer.findFirst({
        where: { liveId: live.id, userId, lastSeenAt: { gte: new Date(Date.now() - 60_000) } },
        select: { userId: true },
      })
      : null;
    if (live.status !== 'live' || (!viewer && !pendingJoin)) return res.status(403).json({ message: 'Join this live session before requesting media access.' });
    if (!(await canViewLive(live, userId))) return res.status(403).json({ message: 'You do not have permission to watch this live session.' });
  }
  const room = liveRoomName(live.id);
  const token = await createLiveKitToken({
    identity: userId,
    name: req.user!.name,
    room,
    canPublish,
    ...(canPublish ? { canPublishSources: [TrackSource.MICROPHONE, TrackSource.CAMERA] } : {}),
  });
  return res.set('Cache-Control', 'no-store').json({ token, url: liveKitUrl(), room, role: isHost ? 'host' : guest ? 'guest' : 'viewer' });
});

command2aRouter.post('/live/:id/stage/token', requireAuth, async (req, res) => {
  const live = await loadLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (!isLiveKitConfigured()) return res.status(503).json({ message: 'Live broadcasts are unavailable because LiveKit is not configured.' });
  if (live.status !== 'live') return res.status(409).json({ message: 'This live session is no longer running.' });
  const userId = req.user!.id;
  const guest = live.guests.find((entry) => entry.userId === userId && entry.status === 'LIVE' && entry.admittedAt);
  if (!guest) return res.status(403).json({ message: 'The host must approve and admit you to the stage before you can publish.' });
  if (!(await canViewLive(live, userId))) return res.status(403).json({ message: 'You do not have permission to join this live session.' });
  if (live.mutedUserIds.includes(userId) || live.viewers.find((viewer) => viewer.userId === userId)?.isMuted) {
    return res.status(403).json({ message: 'Muted participants cannot publish to this live session.' });
  }
  const token = await createLiveKitToken({
    identity: userId,
    name: req.user!.name,
    room: liveRoomName(live.id),
    canPublish: true,
    canPublishSources: [TrackSource.MICROPHONE, TrackSource.CAMERA],
  });
  return res.set('Cache-Control', 'no-store').json({ token, url: liveKitUrl(), room: liveRoomName(live.id), role: guest.role.toLowerCase() });
});

const endLiveSchema = z.object({
  recordingUnavailable: z.boolean().optional(),
}).strict();

command2aRouter.post('/live/:id/end', requireAuth, async (req, res) => {
  const parsed = endLiveSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ message: 'Invalid live session end request.', errors: parsed.error.flatten() });
  const live = await loadLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (live.hostId !== req.user!.id) return res.status(403).json({ message: 'Only the host can end this live session.' });
  if (live.status === 'ended') {
    await persistLiveSession(live);
    await publishLiveFeedPost(live);
    await emitLiveFeedUpdate(live);
    return res.json({ live, message: 'Live session already ended.' });
  }
  let liveEgressId: string | null = null;
  let databaseAvailable: boolean;
  try {
    databaseAvailable = await isDatabaseAvailable();
  } catch {
    return res.status(503).json({ message: 'PostgreSQL is unavailable. The live broadcast could not be safely finalized.' });
  }
  if (databaseAvailable) {
    const egress = await prisma.liveBroadcast.findUnique({
      where: { id: live.id },
      select: { egressId: true, egressOutputKey: true },
    });
    if (egress?.egressOutputKey && !egress.egressId) {
      return res.status(503).json({ message: 'LiveKit Egress is still starting. Retry ending the broadcast in a moment.' });
    }
    if (egress?.egressId) {
      liveEgressId = egress.egressId;
      try {
        await stopLiveKitEgress(egress.egressId);
      } catch {
        return res.status(503).json({ message: 'LiveKit Egress could not stop this recording. The broadcast remains active; retry ending it.' });
      }
    }
  }
  if (isLiveKitConfigured()) {
    try {
      await endLiveKitRoom(liveRoomName(live.id));
    } catch {
      return res.status(503).json({ message: 'LiveKit could not stop this broadcast. The session remains active; retry ending it.' });
    }
  }
  if (databaseAvailable) {
    await prisma.liveBroadcastViewer.deleteMany({ where: { liveId: live.id } });
  }
  const endedLive = {
    ...live,
    status: 'ended' as const,
    recordingStatus: live.recordingStatus === 'RECORDING'
      ? liveEgressId ? 'PROCESSING' as const : parsed.data.recordingUnavailable ? 'UNAVAILABLE' as const : 'PROCESSING' as const
      : live.recordingStatus,
    viewers: [],
    viewerCount: 0,
  };
  const persisted = await persistLiveSession(endedLive, new Date());
  const next = updateLiveSession(live.id, (session) => ({
    ...session,
    status: 'ended',
    recordingStatus: endedLive.recordingStatus,
    recordingError: endedLive.recordingStatus === 'UNAVAILABLE' ? live.recordingError : null,
    viewers: [],
    viewerCount: 0,
  })) ?? endedLive;
  await publishLiveFeedPost(next);
  await emitLiveFeedUpdate(next);
  return res.json({ live: next, message: 'Live session ended.', persistenceWarning: !persisted });
});

const liveReplaySchema = z.object({
  mediaUrl: z.string().trim().min(1).max(1000),
  contentType: z.enum(['video/mp4', 'video/webm', 'video/ogg']),
  durationSeconds: z.number().int().min(1).max(86_400),
}).strict();

command2aRouter.post('/live/:id/replay', requireAuth, async (req, res) => {
  const live = await loadLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (!isLiveReplayOwner(live, req.user!.id)) return res.status(403).json({ message: 'Only the host can save a live replay.' });
  const parsed = liveReplaySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ message: 'Invalid live replay upload.', errors: parsed.error.flatten() });
  if (!(await uploadedVideoBelongsTo(parsed.data.mediaUrl, req.user!.id, process.env.NODE_ENV ?? 'development'))) {
    return res.status(400).json({ message: 'The replay must be a video uploaded by this account.' });
  }
  if (!(await isDatabaseAvailable())) return res.status(503).json({ message: 'Persistent replay storage is unavailable. Configure the server DATABASE_URL, apply Prisma migrations, and ensure PostgreSQL is reachable; no replay was marked ready.' });
  const existing = await prisma.liveReplay.findUnique({ where: { id: live.id } });
  if (existing && existing.status !== 'DELETED') {
    if (isLiveReplayUploadRetry(existing, req.user!.id, parsed.data.mediaUrl)) {
      const replayReadyLive = { ...live, recordingStatus: 'READY' as const, replayUrl: existing.mediaUrl, recordingUrl: existing.mediaUrl };
      const next = updateLiveSession(live.id, (session) => ({ ...session, ...replayReadyLive }));
      await persistLiveSession(next ?? replayReadyLive);
      await publishLiveFeedPost(next ?? replayReadyLive);
      await emitLiveFeedUpdate(next ?? replayReadyLive);
      return res.json({ replay: existing, live: next ?? replayReadyLive, duplicate: true });
    }
    return res.status(409).json({ message: 'A replay has already been saved for this broadcast.' });
  }
  if (!['live', 'ended'].includes(live.status) || !['RECORDING', 'PROCESSING'].includes(live.recordingStatus)) {
    return res.status(409).json({ message: 'A recording must be active or awaiting upload before its replay can be saved.' });
  }
  const replay = await prisma.liveReplay.upsert({
    where: { id: live.id },
    create: {
      id: live.id,
      hostId: req.user!.id,
      title: live.title,
      mediaUrl: parsed.data.mediaUrl,
      contentType: parsed.data.contentType,
      durationSeconds: parsed.data.durationSeconds,
    },
    update: {
      mediaUrl: parsed.data.mediaUrl,
      contentType: parsed.data.contentType,
      durationSeconds: parsed.data.durationSeconds,
      status: 'READY',
      publishedPostId: null,
    },
  });
  const next = updateLiveSession(live.id, (session) => ({ ...session, recordingStatus: 'READY', replayUrl: replay.mediaUrl, recordingUrl: replay.mediaUrl }));
  const replayReadyLive = next ?? { ...live, recordingStatus: 'READY' as const, replayUrl: replay.mediaUrl, recordingUrl: replay.mediaUrl };
  await persistLiveSession(replayReadyLive);
  await publishLiveFeedPost(replayReadyLive);
  await emitLiveFeedUpdate(replayReadyLive);
  return res.status(201).json({ replay, live: replayReadyLive });
});

const publishLiveReplaySchema = z.object({
  content: z.string().trim().max(2500).optional(),
  visibility: z.enum(['PUBLIC', 'FOLLOWERS', 'PRIVATE']).default('PUBLIC'),
}).strict();

command2aRouter.post('/live/:id/replay/publish', requireAuth, async (req, res) => {
  if (!(await isDatabaseAvailable())) return res.status(503).json({ message: 'Persistent replay publishing is unavailable.' });
  const parsed = publishLiveReplaySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ message: 'Invalid replay post details.', errors: parsed.error.flatten() });
  const replay = await prisma.liveReplay.findUnique({ where: { id: String(req.params.id) } });
  if (!replay) return res.status(404).json({ message: 'Live replay not found.' });
  if (!isLiveReplayOwner(replay, req.user!.id)) return res.status(403).json({ message: 'Only the host can publish this replay.' });
  if (replay.status === 'PUBLISHED' && replay.publishedPostId) {
    const post = await prisma.post.findUnique({ where: { id: replay.publishedPostId } });
    if (post) return res.json({ replay, post, duplicate: true });
  }
  if (replay.status !== 'READY') return res.status(409).json({ message: 'This replay is not available for publishing.' });
  if (!(await uploadedVideoBelongsTo(replay.mediaUrl, req.user!.id, process.env.NODE_ENV ?? 'development'))) {
    return res.status(409).json({ message: 'The stored replay media is no longer available to this account.' });
  }
  const content = parsed.data.content || replay.title;
  const moderation = reviewPostContentForSafety({ type: 'post', text: content, userId: req.user!.id });
  if (moderation === 'REMOVE') return res.status(400).json({ message: 'This replay post violates NOVA Community & Safety Rules.' });
  if (moderation === 'REVIEW') return res.status(422).json({ message: 'This replay post requires moderator review.' });
  try {
    const result = await prisma.$transaction(async (transaction) => {
      const current = await transaction.liveReplay.findUnique({ where: { id: replay.id } });
      if (!current || current.status !== 'READY' || !isLiveReplayOwner(current, req.user!.id)) {
        throw new Error('Replay is no longer available for publishing.');
      }
      const livePost = await transaction.post.findUnique({ where: { sourceLiveBroadcastId: current.id } });
      if (livePost && livePost.authorId !== req.user!.id) {
        throw new Error('The linked live post is not owned by the replay creator.');
      }
      const post = livePost
        ? await transaction.post.update({
          where: { id: livePost.id },
          data: { imageUrl: current.mediaUrl },
        })
        : await transaction.post.create({
          data: {
            authorId: req.user!.id,
            content,
            imageUrl: current.mediaUrl,
            visibility: parsed.data.visibility,
            sourceLiveReplayId: current.id,
          },
        });
      const published = await transaction.liveReplay.update({
        where: { id: current.id },
        data: { status: 'PUBLISHED', publishedPostId: post.id },
      });
      return { replay: published, post };
    });
    return res.status(201).json({ ...result, duplicate: false });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
      const published = await prisma.liveReplay.findUnique({ where: { id: replay.id } });
      if (published?.publishedPostId) {
        const post = await prisma.post.findUnique({ where: { id: published.publishedPostId } });
        if (post) return res.json({ replay: published, post, duplicate: true });
      }
    }
    throw error;
  }
});

command2aRouter.delete('/live/:id/replay', requireAuth, async (req, res) => {
  if (!(await isDatabaseAvailable())) return res.status(503).json({ message: 'Persistent replay storage is unavailable.' });
  const replay = await prisma.liveReplay.findUnique({ where: { id: String(req.params.id) } });
  if (!replay) return res.status(404).json({ message: 'Live replay not found.' });
  if (!isLiveReplayOwner(replay, req.user!.id)) return res.status(403).json({ message: 'Only the host can delete this replay.' });
  if (replay.status === 'DELETED') {
    await clearLiveReplayFromSession(replay.id);
    return res.json({ deleted: true, replay });
  }
  if (!['READY', 'DELETING'].includes(replay.status)) return res.status(409).json({ message: 'Only an unpublished replay can be deleted.' });
  const key = videoMediaKeyFromUrl(replay.mediaUrl);
  if (!key) {
    return res.status(409).json({ message: 'The replay media could not be verified for safe deletion.' });
  }
  const storage = getMediaStorage(process.env.NODE_ENV ?? 'development');
  const metadata = await storage.getMetadata(key);
  if (!canDeleteLiveReplayMedia(replay.status, metadata, req.user!.id)) {
    return res.status(409).json({ message: 'The replay media could not be verified for safe deletion.' });
  }
  await prisma.liveReplay.update({ where: { id: replay.id }, data: { status: 'DELETING' } });
  if (metadata) await storage.delete(key);
  const deleted = await prisma.liveReplay.update({ where: { id: replay.id }, data: { status: 'DELETED' } });
  await clearLiveReplayFromSession(replay.id);
  return res.json({ deleted: true, replay: deleted });
});

command2aRouter.post('/live/:id/comment', requireAuth, async (req, res) => {
  const live = await loadLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (live.status !== 'live') return res.status(409).json({ message: 'Comments are available while the live session is running.' });
  if (!(await canInteractWithLive(live, req.user!.id))) return res.status(403).json({ message: 'Join this live session and meet its audience permissions to comment.' });
  const payload = liveCommentSchema.parse(req.body ?? {});
  const moderation = reviewContentForSafety({ type: 'comment', text: payload.text, userId: req.user!.id });
  if (moderation === 'REMOVE') return res.status(400).json({ message: 'This comment violates NOVA Community & Safety Rules.' });
  if (moderation === 'REVIEW') return res.status(422).json({ message: 'This comment requires moderator review.' });
  const comment = await (await isDatabaseAvailable()
    ? prisma.liveBroadcastComment.create({ data: { liveId: live.id, userId: req.user!.id, text: payload.text } })
    : Promise.resolve({ id: `live_comment_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, liveId: live.id, userId: req.user!.id, text: payload.text, createdAt: new Date() }));
  const liveComment = { id: comment.id, userId: comment.userId, text: comment.text, createdAt: comment.createdAt.toISOString() };
  const next = updateLiveSession(live.id, (session) => ({
    ...session,
    comments: [...session.comments, liveComment],
  }));
  return res.status(201).json({ comment: liveComment, live: next && await presentLive(next, req.user!.id) });
});

command2aRouter.post('/live/:id/react', requireAuth, async (req, res) => {
  const live = await loadLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (live.status !== 'live') return res.status(409).json({ message: 'Reactions are available while the live session is running.' });
  if (!(await canInteractWithLive(live, req.user!.id))) return res.status(403).json({ message: 'Join this live session and meet its audience permissions to react.' });
  const payload = liveReactionSchema.parse(req.body ?? {});
  if (await isDatabaseAvailable()) {
    const where = { liveId_userId_type: { liveId: live.id, userId: req.user!.id, type: payload.type } };
    const existingInDatabase = await prisma.liveBroadcastReaction.findUnique({ where });
    if (existingInDatabase) return res.json({ reaction: existingInDatabase, duplicate: true });
    try {
      const reaction = await prisma.liveBroadcastReaction.create({ data: { liveId: live.id, userId: req.user!.id, type: payload.type } });
      updateLiveSession(live.id, (session) => ({
        ...session,
        reactions: session.reactions.some((entry) => entry.userId === req.user!.id && entry.type === payload.type)
          ? session.reactions
          : [...session.reactions, { id: reaction.id, userId: req.user!.id, type: payload.type, createdAt: reaction.createdAt.toISOString() }],
      }));
      return res.status(201).json({ reaction, duplicate: false });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
        const duplicate = await prisma.liveBroadcastReaction.findUnique({ where });
        if (duplicate) return res.json({ reaction: duplicate, duplicate: true });
      }
      throw error;
    }
  }
  const existing = live.reactions.find((reaction) => reaction.userId === req.user!.id && reaction.type === payload.type);
  if (existing) return res.json({ reaction: existing, duplicate: true });
  const next = updateLiveSession(live.id, (session) => ({
    ...session,
    reactions: [...session.reactions, { id: `live_reaction_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, userId: req.user!.id, type: payload.type, createdAt: new Date().toISOString() }],
  }));
  return res.status(201).json({ reaction: next!.reactions[next!.reactions.length - 1], duplicate: false });
});

command2aRouter.post('/live/:id/viewer/:userId/remove', requireAuth, async (req, res) => {
  const live = await loadLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (!canManageLive(live, req.user!.id)) {
    return res.status(403).json({ message: 'Only the host or moderator can remove viewers.' });
  }
  const viewerId = String(req.params.userId);
  if (!live.viewers.some((viewer) => viewer.userId === viewerId)) return res.status(404).json({ message: 'Viewer not found.' });
  if (isLiveKitConfigured()) {
    try {
      await removeLiveKitParticipant(liveRoomName(live.id), viewerId);
    } catch {
      return res.status(503).json({ message: 'LiveKit could not remove this viewer from the broadcast. The viewer was not removed; retry the action.' });
    }
  }
  if (await isDatabaseAvailable()) {
    await prisma.liveBroadcastViewer.deleteMany({ where: { liveId: live.id, userId: viewerId } });
  }
  await recordLiveModeration(live.id, req.user!.id, 'LIVE_VIEWER_REMOVED', viewerId);
  const next = updateLiveSession(live.id, (session) => ({
    ...session,
    viewers: session.viewers.filter((viewer) => viewer.userId !== viewerId),
    viewerCount: session.viewers.some((viewer) => viewer.userId === viewerId) ? Math.max(0, session.viewerCount - 1) : session.viewerCount,
  }));
  return res.json({ live: next, message: 'Viewer removed.' });
});

command2aRouter.post('/live/:id/viewer/:userId/mute', requireAuth, async (req, res) => {
  const live = await loadLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (!canManageLive(live, req.user!.id)) return res.status(403).json({ message: 'Only the host or a moderator can mute viewers.' });
  const userId = String(req.params.userId);
  const payload = liveViewerControlSchema.parse(req.body ?? {});
  const stageGuest = live.guests.some((guest) => guest.userId === userId && guest.status === 'LIVE' && guest.admittedAt);
  if (!live.viewers.some((viewer) => viewer.userId === userId) && !stageGuest) return res.status(404).json({ message: 'Viewer not found.' });
  if (payload.isMuted && stageGuest && isLiveKitConfigured()) {
    try {
      await removeLiveKitParticipant(liveRoomName(live.id), userId);
    } catch {
      return res.status(503).json({ message: 'LiveKit could not mute this stage guest. Their access was not changed; retry the action.' });
    }
  }
  await recordLiveModeration(live.id, req.user!.id, payload.isMuted ? 'LIVE_VIEWER_MUTED' : 'LIVE_VIEWER_UNMUTED', userId);
  const next = updateLiveSession(live.id, (session) => ({
    ...session,
    mutedUserIds: payload.isMuted
      ? Array.from(new Set([...session.mutedUserIds, userId]))
      : session.mutedUserIds.filter((mutedUserId) => mutedUserId !== userId),
    viewers: session.viewers.map((viewer) => viewer.userId === userId ? { ...viewer, isMuted: payload.isMuted } : viewer),
  }));
  if (next) await persistLiveSession(next);
  return res.json({ live: next, viewer: next?.viewers.find((viewer) => viewer.userId === userId) });
});

command2aRouter.post('/live/:id/comments/:commentId/remove', requireAuth, async (req, res) => {
  const live = await loadLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (!canManageLive(live, req.user!.id)) return res.status(403).json({ message: 'Only the host or a moderator can remove comments.' });
  const commentId = String(req.params.commentId);
  const existingComment = live.comments.find((comment) => comment.id === commentId);
  const databaseAvailable = await isDatabaseAvailable();
  if (!existingComment && !databaseAvailable) return res.status(404).json({ message: 'Comment not found.' });
  if (databaseAvailable) {
    const removed = await prisma.liveBroadcastComment.deleteMany({ where: { id: commentId, liveId: live.id } });
    if (!existingComment && removed.count === 0) return res.status(404).json({ message: 'Comment not found.' });
  }
  await recordLiveModeration(live.id, req.user!.id, 'LIVE_COMMENT_REMOVED', existingComment?.userId, commentId);
  const next = updateLiveSession(live.id, (session) => ({ ...session, comments: session.comments.filter((comment) => comment.id !== commentId) }));
  if (next) next.comments = next.comments.filter((comment) => comment.id !== commentId);
  return res.json({ live: next, removed: commentId });
});

command2aRouter.post('/live/:id/moderators/:userId/add', requireAuth, async (req, res) => {
  const live = await loadLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (live.hostId !== req.user!.id) return res.status(403).json({ message: 'Only the host can assign moderators.' });
  const userId = String(req.params.userId);
  if (userId === live.hostId) return res.status(400).json({ message: 'The host is already a session moderator.' });
  await recordLiveModeration(live.id, req.user!.id, 'LIVE_MODERATOR_ADDED', userId);
  const next = updateLiveSession(live.id, (session) => ({
    ...session,
    moderators: Array.from(new Set([...session.moderators, userId])),
  }));
  if (next) await persistLiveSession(next);
  return res.json({ live: next, message: 'Moderator added.' });
});

command2aRouter.post('/live/:id/moderators/:userId/remove', requireAuth, async (req, res) => {
  const live = await loadLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (live.hostId !== req.user!.id) return res.status(403).json({ message: 'Only the host can remove moderators.' });
  const userId = String(req.params.userId);
  await recordLiveModeration(live.id, req.user!.id, 'LIVE_MODERATOR_REMOVED', userId);
  const next = updateLiveSession(live.id, (session) => ({ ...session, moderators: session.moderators.filter((moderatorId) => moderatorId !== userId) }));
  if (next) await persistLiveSession(next);
  return res.json({ live: next, message: 'Moderator removed.' });
});

command2aRouter.post('/live/:id/viewers/join', requireAuth, async (req, res) => {
  const live = await loadLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (live.status !== 'live') return res.status(409).json({ message: 'This live session is not running.' });
  if (!isLiveKitConfigured()) return res.status(503).json({ message: 'LiveKit is unavailable for this broadcast.' });
  if (!(await canViewLive(live, req.user!.id))) return res.status(403).json({ message: 'You do not have permission to watch this live session.' });
  const cutoff = Date.now() - 60_000;
  const existing = live.viewers.find((viewer) => viewer.userId === req.user!.id);
  const joinedAt = new Date();
  let next;
  let viewer: LiveViewer;
  if (await isDatabaseAvailable()) {
    const key = { liveId_userId: { liveId: live.id, userId: req.user!.id } };
    const record = await prisma.liveBroadcastViewer.upsert({
      where: key,
      create: {
        liveId: live.id,
        userId: req.user!.id,
        joinedAt,
        lastSeenAt: joinedAt,
        connectedAt: null,
      },
      update: { lastSeenAt: joinedAt, connectedAt: null },
    });
    const snapshot = liveViewerSnapshot(live, await getActiveLiveViewerRecords(live.id));
    viewer = snapshot.viewers.find((entry) => entry.userId === req.user!.id) ?? {
      userId: req.user!.id,
      isMuted: live.mutedUserIds.includes(req.user!.id),
      isBlocked: false,
      joinedAt: record.lastSeenAt.toISOString(),
    };
    next = updateLiveSession(live.id, (session) => ({ ...session, ...snapshot }));
  } else {
    const stageUserIds = new Set([
      live.hostId,
      ...live.guests.filter((guest) => guest.status === 'LIVE' && guest.admittedAt).map((guest) => guest.userId),
    ]);
    const activeViewers = live.viewers.filter((entry) =>
      !stageUserIds.has(entry.userId) && new Date(entry.joinedAt).getTime() >= cutoff,
    );
    viewer = {
      ...(existing ?? { userId: req.user!.id, isMuted: live.mutedUserIds.includes(req.user!.id), isBlocked: false }),
      joinedAt: joinedAt.toISOString(),
    };
    const nextViewers = stageUserIds.has(viewer.userId)
      ? activeViewers
      : [...activeViewers.filter((entry) => entry.userId !== viewer.userId), viewer];
    next = updateLiveSession(live.id, (session) => ({
      ...session,
      viewers: nextViewers,
      viewerCount: new Set(nextViewers.map((entry) => entry.userId)).size,
    }));
  }
  if (existing) return res.json({ viewer, live: next && liveForAudience(next, req.user!.id) });
  await createNotification(live.hostId, req.user!.id, 'live_viewer', `${req.user!.name} joined your live session.`);
  return res.status(201).json({ viewer, live: next && liveForAudience(next, req.user!.id) });
});

command2aRouter.post('/live/:id/viewers/heartbeat', requireAuth, async (req, res) => {
  const live = await loadLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (live.status !== 'live') return res.status(409).json({ message: 'This live session is not running.' });
  const viewer = live.viewers.find((entry) => entry.userId === req.user!.id && !entry.isBlocked);
  const admittedGuest = live.guests.some((entry) => entry.userId === req.user!.id && entry.status === 'LIVE' && entry.admittedAt);
  const pendingJoin = !viewer && await isDatabaseAvailable()
    ? await prisma.liveBroadcastViewer.findFirst({
      where: { liveId: live.id, userId: req.user!.id, lastSeenAt: { gte: new Date(Date.now() - 60_000) } },
      select: { userId: true },
    })
    : null;
  if (!viewer && !pendingJoin && !admittedGuest) return res.status(409).json({ message: 'Join this live session again to continue watching.' });
  if (!(await canViewLive(live, req.user!.id))) return res.status(403).json({ message: 'You cannot watch this live session.' });
  if (!isLiveKitConfigured()) return res.status(503).json({ message: 'LiveKit is unavailable for this broadcast.' });
  let liveKitParticipants: Awaited<ReturnType<typeof getLiveKitParticipants>>;
  try {
    liveKitParticipants = await getLiveKitParticipants(liveRoomName(live.id));
  } catch {
    return res.status(503).json({ message: 'LiveKit could not verify the viewer media connection.' });
  }
  if (!liveKitParticipants.some((participant) => participant.identity === req.user!.id)) {
    return res.status(409).json({ message: 'Connect to the live broadcast before updating viewer presence.' });
  }
  const lastSeenAt = new Date();
  let next;
  if (await isDatabaseAvailable()) {
    await prisma.liveBroadcastViewer.updateMany({
      where: { liveId: live.id, userId: req.user!.id, connectedAt: null },
      data: { connectedAt: lastSeenAt },
    });
    const result = await prisma.liveBroadcastViewer.updateMany({
      where: { liveId: live.id, userId: req.user!.id },
      data: { lastSeenAt },
    });
    if (result.count === 0) return res.status(409).json({ message: 'Join this live session again to continue watching.' });
    const snapshot = liveViewerSnapshot(live, await getActiveLiveViewerRecords(live.id));
    next = updateLiveSession(live.id, (session) => ({ ...session, ...snapshot }));
  } else {
    const cutoff = Date.now() - 60_000;
    const stageUserIds = new Set([
      live.hostId,
      ...live.guests.filter((guest) => guest.status === 'LIVE' && guest.admittedAt).map((guest) => guest.userId),
    ]);
    next = updateLiveSession(live.id, (session) => ({
      ...session,
      viewers: session.viewers.filter((entry) => !stageUserIds.has(entry.userId) && (entry.userId === req.user!.id || new Date(entry.joinedAt).getTime() >= cutoff))
        .map((entry) => entry.userId === req.user!.id ? { ...entry, joinedAt: lastSeenAt.toISOString() } : entry),
      viewerCount: session.viewers.filter((entry) => !stageUserIds.has(entry.userId) && (entry.userId === req.user!.id || new Date(entry.joinedAt).getTime() >= cutoff)).length,
    }));
  }
  return res.json({ live: next && liveForAudience(next, req.user!.id) });
});

command2aRouter.post('/live/:id/viewers/leave', requireAuth, async (req, res) => {
  const live = await loadLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  let wasViewer = live.viewers.some((viewer) => viewer.userId === req.user!.id);
  let next;
  if (await isDatabaseAvailable()) {
    const deleted = await prisma.liveBroadcastViewer.deleteMany({ where: { liveId: live.id, userId: req.user!.id } });
    wasViewer = deleted.count > 0;
    const snapshot = liveViewerSnapshot(live, await getActiveLiveViewerRecords(live.id));
    next = updateLiveSession(live.id, (session) => ({ ...session, ...snapshot }));
  } else {
    next = updateLiveSession(live.id, (session) => ({
      ...session,
      viewers: session.viewers.filter((viewer) => viewer.userId !== req.user!.id),
      viewerCount: wasViewer ? Math.max(0, session.viewerCount - 1) : session.viewerCount,
    }));
  }
  return res.json({ left: wasViewer, live: next && liveForAudience(next, req.user!.id) });
});

command2aRouter.post('/live/:id/guests/request', requireAuth, async (req, res) => {
  const live = await loadLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (live.status !== 'live') return res.status(409).json({ message: 'Guest requests are available while the live session is running.' });
  if (live.hostId === req.user!.id) return res.status(400).json({ message: 'The host is already on stage.' });
  if (!(await canViewLive(live, req.user!.id))) return res.status(403).json({ message: 'You do not have permission to request a guest spot.' });
  const payload = liveGuestSchema.parse(req.body ?? {});
  if (live.guests.some((guest) => guest.userId === req.user!.id && guest.status !== 'REMOVED')) return res.status(409).json({ message: 'A guest request already exists.' });
  const guest = { userId: req.user!.id, role: payload.role, status: 'REQUESTED' as const, requestedAt: new Date().toISOString() };
  const next = updateLiveSession(live.id, (session) => ({ ...session, guests: [...session.guests.filter((entry) => entry.userId !== req.user!.id), guest] }));
  if (next) await persistLiveSession(next);
  await createNotification(live.hostId, req.user!.id, 'live_guest_request', `${req.user!.name} requested to join your live session.`);
  return res.status(201).json({ guest, live: next && liveForAudience(next, req.user!.id) });
});

command2aRouter.post('/live/:id/guests/:userId/approve', requireAuth, async (req, res) => {
  const live = await loadLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (!canManageLive(live, req.user!.id)) return res.status(403).json({ message: 'Only the host or a moderator can approve guests.' });
  const userId = String(req.params.userId);
  const requested = live.guests.find((guest) => guest.userId === userId && guest.status === 'REQUESTED');
  if (!requested) return res.status(404).json({ message: 'Guest request not found.' });
  if (!(await canViewLive(live, userId))) return res.status(403).json({ message: 'This user is no longer eligible to join the broadcast.' });
  await recordLiveModeration(live.id, req.user!.id, 'LIVE_GUEST_APPROVED', userId);
  const next = updateLiveSession(live.id, (session) => ({
    ...session,
    guests: session.guests.map((guest) => guest.userId === userId ? { ...guest, status: 'LIVE' } : guest),
  }));
  if (next) await persistLiveSession(next);
  return res.json({ guest: next!.guests.find((guest) => guest.userId === userId), live: next });
});

command2aRouter.post('/live/:id/guests/stage/join', requireAuth, async (req, res) => {
  const live = await loadLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (live.status !== 'live') return res.status(409).json({ message: 'This live session is no longer running.' });
  const guest = live.guests.find((entry) => entry.userId === req.user!.id && entry.status === 'LIVE');
  if (!guest) return res.status(403).json({ message: 'The host must approve your guest request before you can join the stage.' });
  if (!(await canViewLive(live, req.user!.id))) return res.status(403).json({ message: 'You do not have permission to join this live session.' });
  const viewer = live.viewers.find((entry) => entry.userId === req.user!.id && !entry.isBlocked);
  const pendingJoin = !viewer && await isDatabaseAvailable()
    ? await prisma.liveBroadcastViewer.findFirst({
      where: { liveId: live.id, userId: req.user!.id, lastSeenAt: { gte: new Date(Date.now() - 60_000) } },
      select: { userId: true },
    })
    : null;
  if (!viewer && !pendingJoin) return res.status(409).json({ message: 'Join this live session before joining the stage.' });
  if (live.mutedUserIds.includes(req.user!.id) || live.viewers.find((viewer) => viewer.userId === req.user!.id)?.isMuted) {
    return res.status(403).json({ message: 'Muted participants cannot join the stage.' });
  }
  const admittedAt = guest.admittedAt ?? new Date().toISOString();
  const next = updateLiveSession(live.id, (session) => ({
    ...session,
    viewers: session.viewers.filter((viewer) => viewer.userId !== req.user!.id),
    viewerCount: session.viewers.filter((viewer) => viewer.userId !== req.user!.id).length,
    guests: session.guests.map((entry) => entry.userId === req.user!.id
      ? { ...entry, admittedAt }
      : entry),
  }));
  if (!next) return res.status(404).json({ message: 'Live session not found.' });
  await persistLiveSession(next);
  return res.json({ guest: next.guests.find((entry) => entry.userId === req.user!.id), live: await presentLive(next, req.user!.id) });
});

command2aRouter.post('/live/:id/guests/:userId/remove', requireAuth, async (req, res) => {
  const live = await loadLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (!canManageLive(live, req.user!.id)) return res.status(403).json({ message: 'Only the host or a moderator can remove guests.' });
  const userId = String(req.params.userId);
  if (isLiveKitConfigured()) {
    try {
      await removeLiveKitParticipant(liveRoomName(live.id), userId);
    } catch {
      return res.status(503).json({ message: 'LiveKit could not remove this guest from the broadcast. The guest was not removed; retry the action.' });
    }
  }
  if (await isDatabaseAvailable()) {
    await prisma.liveBroadcastViewer.deleteMany({ where: { liveId: live.id, userId } });
  }
  await recordLiveModeration(live.id, req.user!.id, 'LIVE_GUEST_REMOVED', userId);
  const next = updateLiveSession(live.id, (session) => ({
    ...session,
    guests: session.guests.map((guest) => guest.userId === userId ? { ...guest, status: 'REMOVED', admittedAt: undefined } : guest),
  }));
  if (next) await persistLiveSession(next);
  return res.json({ live: next });
});

command2aRouter.post('/live/:id/follow', requireAuth, async (req, res) => {
  const live = await loadLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (live.hostId === req.user!.id) return res.status(400).json({ message: 'You already own this live session.' });
  if (await isBlocked(req.user!.id, live.hostId)) return res.status(403).json({ message: 'You cannot follow this host.' });
  if (await isDatabaseAvailable()) {
    const where = { followerId_followingId: { followerId: req.user!.id, followingId: live.hostId } };
    if (!(await prisma.follow.findUnique({ where, select: { id: true } }))) await prisma.follow.create({ data: { followerId: req.user!.id, followingId: live.hostId } });
  } else if (!socialStore.state.follows.some((follow) => follow.followerId === req.user!.id && follow.followingId === live.hostId)) {
    socialStore.state.follows.push({ id: `follow_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, followerId: req.user!.id, followingId: live.hostId, createdAt: new Date().toISOString() });
  }
  await createNotification(live.hostId, req.user!.id, 'live_follow', `${req.user!.name} followed you from a live session.`);
  return res.json({ following: true, hostId: live.hostId });
});

command2aRouter.post('/live/:id/report', requireAuth, async (req, res) => {
  const live = await loadLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  const payload = liveReportSchema.parse(req.body ?? {});
  const details = `Live report: ${live.title} (${live.id})\n\n${payload.reason}`;
  if (await isDatabaseAvailable()) {
    const report = await prisma.report.create({ data: { reporterId: req.user!.id, targetUserId: live.hostId, category: payload.category, details } });
    return res.status(201).json({ report, message: 'Report submitted.' });
  }
  const report = { id: `report_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, reporterId: req.user!.id, targetType: 'user' as const, targetId: live.hostId, category: payload.category, reason: details, createdAt: new Date().toISOString() };
  socialStore.state.reports.push(report);
  return res.status(201).json({ report, message: 'Report submitted.' });
});

command2aRouter.post('/live/:id/block/:userId', requireAuth, async (req, res) => {
  const live = await loadLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (!canManageLive(live, req.user!.id)) return res.status(403).json({ message: 'Only the host or a moderator can block viewers.' });
  const userId = String(req.params.userId);
  if (userId === live.hostId) return res.status(400).json({ message: 'The host cannot be blocked from their own session.' });
  if (isLiveKitConfigured()) {
    try {
      await removeLiveKitParticipant(liveRoomName(live.id), userId);
    } catch {
      return res.status(503).json({ message: 'The viewer is blocked, but LiveKit could not end their active broadcast connection. Retry the action.' });
    }
  }
  if (await isDatabaseAvailable()) {
    await prisma.liveBroadcastViewer.deleteMany({ where: { liveId: live.id, userId } });
  }
  await recordLiveModeration(live.id, req.user!.id, 'LIVE_VIEWER_BLOCKED', userId);
  const next = updateLiveSession(live.id, (session) => ({
    ...session,
    blockedUserIds: Array.from(new Set([...session.blockedUserIds, userId])),
    viewers: session.viewers.filter((viewer) => viewer.userId !== userId),
    viewerCount: session.viewers.some((viewer) => viewer.userId === userId) ? Math.max(0, session.viewerCount - 1) : session.viewerCount,
    guests: session.guests.map((guest) => guest.userId === userId ? { ...guest, status: 'REMOVED', admittedAt: undefined } : guest),
  }));
  if (next) await persistLiveSession(next);
  return res.json({ blocked: true, live: next });
});

command2aRouter.post('/live/:id/recording/start', requireAuth, async (req, res) => {
  const live = await loadLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (live.hostId !== req.user!.id) return res.status(403).json({ message: 'Only the host can start the live recording.' });
  if (live.status !== 'live') return res.status(409).json({ message: 'Recording requires a running live session.' });
  if (live.recordingStatus === 'RECORDING') {
    const current = await (await isDatabaseAvailable()
      ? prisma.liveBroadcast.findUnique({ where: { id: live.id }, select: { egressId: true } })
      : Promise.resolve(null));
    return res.json({ live, recordingProvider: current?.egressId ? 'livekit-egress' : 'browser' });
  }
  if (startingRecordingIds.has(live.id)) return res.status(409).json({ message: 'Live recording is already starting.' });
  startingRecordingIds.add(live.id);
  try {
    if (isLiveKitEgressConfigured()) {
      let databaseAvailable: boolean;
      try {
        databaseAvailable = await isDatabaseAvailable();
      } catch {
        return res.status(503).json({ message: 'LiveKit Egress recording requires persistent PostgreSQL storage. Configure DATABASE_URL and apply Prisma migrations.' });
      }
      if (!databaseAvailable) {
        return res.status(503).json({ message: 'LiveKit Egress recording requires persistent PostgreSQL storage. Configure DATABASE_URL and apply Prisma migrations.' });
      }
      const outputKey = `live-recordings/${live.id}/${randomUUID()}.mp4`;
      const claimed = await prisma.liveBroadcast.updateMany({
        where: { id: live.id, hostId: live.hostId, status: 'live', recordingStatus: { in: ['UNAVAILABLE', 'READY'] } },
        data: { recordingStatus: 'PROCESSING', egressId: null, egressOutputKey: outputKey, egressError: null },
      });
      if (claimed.count !== 1) return res.status(409).json({ message: 'The recording state changed; refresh the live session and retry.' });
      let egressId: string | null = null;
      try {
        const info = await startLiveKitRoomEgress(liveRoomName(live.id), outputKey);
        egressId = info.egressId;
        const started = await prisma.liveBroadcast.updateMany({
          where: { id: live.id, egressOutputKey: outputKey },
          data: { recordingStatus: 'RECORDING', egressId, egressOutputKey: outputKey, egressError: null },
        });
        if (started.count === 0) {
          const current = await loadLiveSession(live.id);
          return res.json({ live: current, recordingProvider: 'livekit-egress', egressConfigured: true });
        }
      } catch (error) {
        if (egressId) {
          try {
            await stopLiveKitEgress(egressId);
          } catch {
            console.error('Unable to stop LiveKit Egress after recording setup failed.');
          }
        }
        const message = error instanceof Error ? error.message : 'LiveKit Egress could not start the recording.';
        await prisma.liveBroadcast.updateMany({
          where: { id: live.id, egressOutputKey: outputKey },
          data: { recordingStatus: 'UNAVAILABLE', egressId: null, egressOutputKey: null, egressError: message },
        });
        return res.status(503).json({ message });
      }
      const next = updateLiveSession(live.id, (session) => ({ ...session, recordingStatus: 'RECORDING', recordingError: null }));
      return res.json({ live: next, recordingProvider: 'livekit-egress', egressConfigured: true });
    }

    const missingConfiguration = liveKitEgressMissingConfiguration();
    const message = `LiveKit Egress is not configured. Missing: ${missingConfiguration.join(', ')}. Browser recording will be used for this broadcast.`;
    await persistLiveSession({ ...live, recordingStatus: 'RECORDING', recordingError: message });
    const next = updateLiveSession(live.id, (session) => ({ ...session, recordingStatus: 'RECORDING', recordingError: message }));
    return res.json({ live: next, recordingProvider: 'browser', egressConfigured: false, egressUnavailableReason: message });
  } finally {
    startingRecordingIds.delete(live.id);
  }
});

command2aRouter.post('/live/:id/recording/stop', requireAuth, async (req, res) => {
  const live = await loadLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (!canManageLive(live, req.user!.id)) return res.status(403).json({ message: 'Only the host or a moderator can control recording.' });
  if (live.recordingStatus !== 'RECORDING') return res.status(409).json({ message: 'No recording is active.' });
  let databaseAvailable: boolean;
  try {
    databaseAvailable = await isDatabaseAvailable();
  } catch {
    return res.status(503).json({ message: 'PostgreSQL is unavailable. The live recording could not be safely stopped.' });
  }
  if (databaseAvailable) {
    const egress = await prisma.liveBroadcast.findUnique({
      where: { id: live.id },
      select: { egressId: true },
    });
    if (egress?.egressId) {
      try {
        await stopLiveKitEgress(egress.egressId);
      } catch {
        return res.status(503).json({ message: 'LiveKit Egress could not stop this recording. Retry the stop request.' });
      }
    } else if (isLiveKitEgressConfigured()) {
      return res.status(503).json({ message: 'The LiveKit Egress identity is not yet persisted. Retry the stop request shortly.' });
    }
  } else if (isLiveKitEgressConfigured()) {
    return res.status(503).json({ message: 'LiveKit Egress recording requires persistent PostgreSQL storage.' });
  }
  const recordingStatus = live.replayUrl ? 'READY' as const : 'PROCESSING' as const;
  await persistLiveSession({ ...live, recordingStatus });
  const next = updateLiveSession(live.id, (session) => ({ ...session, recordingStatus: session.replayUrl ? 'READY' : 'PROCESSING' }));
  return res.json({ live: next, replayReady: Boolean(next?.replayUrl) });
});

command2aRouter.post('/live/:id/share', requireAuth, async (req, res) => {
  const live = await loadLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  await createNotification(live.hostId, req.user!.id, 'live', `${req.user!.name} shared your live session.`);
  return res.json({ shared: true, live: liveForAudience(live, req.user!.id) });
});

function aiUnavailable(_req: Request, res: Response) {
  return res.status(503).json({ message: 'AI assistance is unavailable because no AI provider is configured.' });
}

command2aRouter.post('/ai/summarize', aiUnavailable);
command2aRouter.post('/ai/translate', aiUnavailable);
command2aRouter.post('/ai/speech-to-text', aiUnavailable);
command2aRouter.post('/ai/smart-replies', aiUnavailable);
command2aRouter.post('/ai/captions', aiUnavailable);
command2aRouter.post('/ai/moderate', aiUnavailable);
command2aRouter.post('/ai/spam-scam-detect', aiUnavailable);

export { command2aRouter };

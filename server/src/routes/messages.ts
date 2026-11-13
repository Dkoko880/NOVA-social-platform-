import { Router } from 'express';
import { z } from 'zod';
import { prisma, isDatabaseAvailable } from '../lib/prisma.js';
import { socialStore, type MessageRecord } from '../lib/socialStore.js';
import { requireAuth, requireActiveAccountIfAuthenticated } from '../middleware/auth.js';
import { attachmentMediaKeyFromUrl, mediaKeyFromUrl, uploadedMediaBelongsTo, getMediaStorage } from '../lib/mediaStorage.js';
import { reviewContentForSafety } from '../lib/moderation.js';
import { emitConversationEvent, isUserConnected, realtimeHub, registerRealtimeConnection, subscribeToUserEvents, updateRecordingState } from '../lib/realtime.js';
import { findUserById } from '../lib/fallbackStore.js';
import { createNotification } from '../lib/platform.js';
import type { Prisma } from '@prisma/client';
import env from '../config/env.js';

const createConversationSchema = z.object({
  participantId: z.string().min(1).optional(),
  participantIds: z.array(z.string().min(1)).min(1).max(49).optional(),
  name: z.string().trim().max(120).optional(),
  description: z.string().trim().max(500).optional(),
  isChannel: z.boolean().optional(),
  isGroup: z.boolean().optional(),
}).refine((payload) => Boolean(payload.participantId) !== Boolean(payload.participantIds), {
  message: 'Provide either participantId or participantIds.',
}).refine((payload) => !payload.participantIds || new Set(payload.participantIds).size === payload.participantIds.length, {
  message: 'Group participants must be unique.',
});

function isAllowedMessageMediaUrl(value: string) {
  if (mediaKeyFromUrl(value) || attachmentMediaKeyFromUrl(value)) return true;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

const messageSchema = z.object({
  contentType: z.enum(['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT', 'VOICE', 'GIF', 'STICKER', 'CONTACT', 'LOCATION', 'POLL', 'EVENT']).default('TEXT'),
  text: z.string().trim().max(2000).optional(),
  mediaUrl: z.string().trim().max(2000).refine(isAllowedMessageMediaUrl, 'Use an HTTPS URL or an uploaded novachat image.').optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  replyToId: z.string().min(1).optional(),
}).refine((payload) => payload.contentType !== 'TEXT' || Boolean(payload.text?.trim()) || Boolean(payload.metadata?.timedUpdateReply), { message: 'Text messages need content.' })
  .refine((payload) => !['IMAGE', 'VIDEO', 'DOCUMENT', 'VOICE', 'GIF', 'STICKER'].includes(payload.contentType) || Boolean(payload.mediaUrl), { message: 'Media messages need a media URL.' })
  .refine((payload) => !['CONTACT', 'LOCATION', 'POLL', 'EVENT'].includes(payload.contentType) || Boolean(payload.metadata), { message: 'This message type needs metadata.' })
  .refine((payload) => payload.contentType !== 'POLL' || (
    typeof payload.metadata?.question === 'string'
    && Array.isArray(payload.metadata.options)
    && payload.metadata.options.length >= 2
    && payload.metadata.options.length <= 10
    && payload.metadata.options.every((option) => typeof option === 'object' && option !== null && typeof (option as { id?: unknown }).id === 'string' && typeof (option as { text?: unknown }).text === 'string')
  ), { message: 'Polls need a question and two to ten options.' })
  .refine((payload) => payload.contentType !== 'EVENT' || (
    typeof payload.metadata?.title === 'string'
    && typeof payload.metadata.startsAt === 'string'
    && !Number.isNaN(Date.parse(payload.metadata.startsAt))
  ), { message: 'Events need a title and a valid start time.' });
const timedUpdateReplySchema = z.object({
  kind: z.enum(['STORY', 'STATUS']),
  id: z.string().min(1).max(128),
  reaction: z.enum(['👍', '❤️', '😂', '😮', '😢', '🙏']).optional(),
});

const interactiveResponseSchema = z.object({
  optionId: z.string().min(1).optional(),
  response: z.enum(['GOING', 'MAYBE', 'NOT_GOING']).optional(),
}).refine((payload) => Boolean(payload.optionId) !== Boolean(payload.response), { message: 'Provide either a poll option or an event response.' });

const messageEditSchema = z.object({ text: z.string().trim().min(1).max(2000) });
const reactionSchema = z.object({ type: z.string().trim().min(1).max(24) });
const messagePreferenceSchema = z.object({
  pinned: z.boolean().optional(),
  starred: z.boolean().optional(),
}).refine((payload) => payload.pinned !== undefined || payload.starred !== undefined, {
  message: 'Choose a message preference to update.',
});
const conversationPreferenceSchema = z.object({
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  starred: z.boolean().optional(),
  mutedUntil: z.string().datetime().nullable().optional(),
  disappearingAfterSeconds: z.number().int().min(0).max(90 * 24 * 60 * 60).optional(),
});
const addParticipantSchema = z.object({
  participantIds: z.array(z.string().min(1)).min(1).max(49),
}).refine((payload) => new Set(payload.participantIds).size === payload.participantIds.length, {
  message: 'Group participants must be unique.',
});
const roleSchema = z.object({ role: z.enum(['MEMBER', 'MODERATOR']) });
const groupDetailsSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).optional(),
  imageUrl: z.string().trim().max(500).refine((value) => {
    if (!value || mediaKeyFromUrl(value)) return true;
    try {
      return new URL(value).protocol === 'https:';
    } catch {
      return false;
    }
  }, 'Use an HTTPS URL or an uploaded novachat image.').optional(),
}).refine((payload) => Object.keys(payload).length > 0, { message: 'Provide group details to update.' });
const reportSchema = z.object({
  category: z.enum(['SPAM', 'HARASSMENT', 'SEXUAL_CONTENT', 'HATE', 'VIOLENCE', 'SCAM', 'OTHER']),
  reason: z.string().trim().min(4).max(500),
});
const messagingPreferenceSchema = z.object({
  readReceiptsEnabled: z.boolean().optional(),
  presenceVisibility: z.enum(['EVERYONE', 'MY_CONTACTS', 'NOBODY']).optional(),
}).refine((payload) => Object.keys(payload).length > 0, { message: 'Choose a messaging preference to update.' });
const recordingSchema = z.object({ recording: z.boolean() });

const canViewConversation = async (conversationId: string, userId: string) => {
  const dbAvailable = await isDatabaseAvailable();

  if (dbAvailable) {
    const participant = await prisma.conversationParticipant.findFirst({
      where: { conversationId, userId, leftAt: null },
      select: { id: true },
    });
    return Boolean(participant);
  }

  return socialStore.state.conversationParticipants.some(
    (participant) => participant.conversationId === conversationId && participant.userId === userId && !participant.leftAt,
  );
};

const listConversationParticipantIds = async (conversationId: string) => {
  if (await isDatabaseAvailable()) {
    return (await prisma.conversationParticipant.findMany({ where: { conversationId, leftAt: null }, select: { userId: true } })).map((participant) => participant.userId);
  }
  return socialStore.state.conversationParticipants.filter((participant) => participant.conversationId === conversationId && !participant.leftAt).map((participant) => participant.userId);
};

const isConversationOwner = (conversation: { ownerId?: string | null }, userId: string) => conversation.ownerId === userId;
const canManageGroupMembers = (conversation: { ownerId?: string | null }, participant: { role: string }, userId: string) =>
  participant.role === 'OWNER' || isConversationOwner(conversation, userId) || participant.role === 'MODERATOR';

const isBlocked = async (userId: string, targetUserId: string) => {
  const dbAvailable = await isDatabaseAvailable();

  if (dbAvailable) {
    const [userBlocked, targetBlocked] = await Promise.all([
      prisma.block.findUnique({ where: { blockerId_blockedId: { blockerId: userId, blockedId: targetUserId } }, select: { id: true } }),
      prisma.block.findUnique({ where: { blockerId_blockedId: { blockerId: targetUserId, blockedId: userId } }, select: { id: true } }),
    ]);
    return Boolean(userBlocked || targetBlocked);
  }

  return socialStore.state.blocks.some(
    (block) => (block.blockerId === userId && block.blockedId === targetUserId) || (block.blockerId === targetUserId && block.blockedId === userId),
  );
};

type PresenceVisibility = 'EVERYONE' | 'MY_CONTACTS' | 'NOBODY';

async function messagingPreferencesFor(userId: string) {
  if (await isDatabaseAvailable()) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { readReceiptsEnabled: true, presenceVisibility: true },
    });
    if (!user) return null;
    return { readReceiptsEnabled: user.readReceiptsEnabled, presenceVisibility: user.presenceVisibility as PresenceVisibility };
  }
  return socialStore.state.messagingPreferences[userId] ?? { readReceiptsEnabled: true, presenceVisibility: 'EVERYONE' as const };
}

async function setLastSeenAt(userId: string, lastSeenAt: Date) {
  if (await isDatabaseAvailable()) {
    await prisma.user.update({ where: { id: userId }, data: { lastSeenAt } });
  } else {
    socialStore.state.messagingLastSeenAt[userId] = lastSeenAt.toISOString();
  }
}

async function sharedPresenceConversations(viewerId: string, targetId: string) {
  if (await isDatabaseAvailable()) {
    const shared = await prisma.conversation.findMany({
      where: {
        participants: { some: { userId: viewerId, leftAt: null } },
        AND: [{ participants: { some: { userId: targetId, leftAt: null } } }],
      },
      select: { id: true, isGroup: true },
    });
    return shared;
  }
  const viewerConversationIds = new Set(socialStore.state.conversationParticipants
    .filter((participant) => participant.userId === viewerId && !participant.leftAt)
    .map((participant) => participant.conversationId));
  return socialStore.state.conversations
    .filter((conversation) => viewerConversationIds.has(conversation.id)
      && socialStore.state.conversationParticipants.some((participant) =>
        participant.conversationId === conversation.id && participant.userId === targetId && !participant.leftAt))
    .map((conversation) => ({ id: conversation.id, isGroup: conversation.isGroup ?? false }));
}

async function canViewPresence(viewerId: string, targetId: string) {
  if (viewerId === targetId) return true;
  if (await isBlocked(viewerId, targetId)) return false;
  const [conversations, preferences] = await Promise.all([
    sharedPresenceConversations(viewerId, targetId),
    messagingPreferencesFor(targetId),
  ]);
  if (!conversations.length || !preferences || preferences.presenceVisibility === 'NOBODY') return false;
  return preferences.presenceVisibility === 'EVERYONE' || conversations.some((conversation) => !conversation.isGroup);
}

async function publishPresenceChange(userId: string, online: boolean, lastSeenAt?: Date) {
  if (!online && lastSeenAt) await setLastSeenAt(userId, lastSeenAt);
  const dbAvailable = await isDatabaseAvailable();
  const shared = dbAvailable
    ? await prisma.conversation.findMany({
      where: { participants: { some: { userId, leftAt: null } } },
      select: { id: true, isGroup: true, participants: { where: { leftAt: null }, select: { userId: true } } },
    })
    : socialStore.state.conversations
      .filter((conversation) => socialStore.state.conversationParticipants.some((participant) => participant.conversationId === conversation.id && participant.userId === userId && !participant.leftAt))
      .map((conversation) => ({
        id: conversation.id,
        isGroup: conversation.isGroup ?? false,
        participants: socialStore.state.conversationParticipants.filter((participant) => participant.conversationId === conversation.id && !participant.leftAt).map((participant) => ({ userId: participant.userId })),
      }));

  for (const conversation of shared) {
    const allowedUserIds: string[] = [];
    for (const participant of conversation.participants) {
      if (participant.userId === userId || await isBlocked(userId, participant.userId)) continue;
      const preferences = await messagingPreferencesFor(userId);
      if (!preferences || preferences.presenceVisibility === 'NOBODY') continue;
      if (preferences.presenceVisibility === 'MY_CONTACTS' && conversation.isGroup) continue;
      allowedUserIds.push(participant.userId);
    }
    if (allowedUserIds.length) {
      emitConversationEvent('presence:change', conversation.id, {
        userId,
        online,
        lastSeenAt: online ? null : lastSeenAt?.toISOString() ?? null,
      }, allowedUserIds);
    }
  }
}

async function revokePresenceVisibility(userId: string) {
  const dbAvailable = await isDatabaseAvailable();
  const shared = dbAvailable
    ? await prisma.conversation.findMany({
      where: { participants: { some: { userId, leftAt: null } } },
      select: { id: true, participants: { where: { leftAt: null }, select: { userId: true } } },
    })
    : socialStore.state.conversations
      .filter((conversation) => socialStore.state.conversationParticipants.some((participant) => participant.conversationId === conversation.id && participant.userId === userId && !participant.leftAt))
      .map((conversation) => ({
        id: conversation.id,
        participants: socialStore.state.conversationParticipants.filter((participant) => participant.conversationId === conversation.id && !participant.leftAt).map((participant) => ({ userId: participant.userId })),
      }));
  for (const conversation of shared) {
    const allowedUserIds: string[] = [];
    for (const participant of conversation.participants) {
      if (participant.userId !== userId && !(await isBlocked(userId, participant.userId))) allowedUserIds.push(participant.userId);
    }
    if (allowedUserIds.length) emitConversationEvent('presence:change', conversation.id, { userId, visible: false }, allowedUserIds);
  }
}

const messageToPublicShape = (message: any, viewerUserId?: string) => ({
  id: message.id,
  conversationId: message.conversationId,
  senderId: message.senderId,
  text: message.deletedAt ? '[deleted]' : message.moderationHiddenAt ? '[removed by moderators]' : message.text,
  createdAt: message.createdAt,
  updatedAt: message.updatedAt,
  readAt: viewerUserId === message.senderId && Array.isArray(message.receipts)
    ? message.receipts.length > 0 && message.receipts.every((receipt: { readAt?: Date | string | null; recipient?: { readReceiptsEnabled?: boolean } }) => Boolean(receipt.readAt) && receipt.recipient?.readReceiptsEnabled !== false)
      ? message.receipts.find((receipt: { readAt?: Date | string | null }) => receipt.readAt)?.readAt ?? null
      : null
    : message.readAt,
  deletedAt: message.deletedAt,
  status: viewerUserId === message.senderId && Array.isArray(message.receipts) && message.receipts.length
    ? message.receipts.every((receipt: { readAt?: Date | string | null; recipient?: { readReceiptsEnabled?: boolean } }) => Boolean(receipt.readAt) && receipt.recipient?.readReceiptsEnabled !== false)
      ? 'READ'
      : message.receipts.every((receipt: { deliveredAt?: Date | string | null }) => Boolean(receipt.deliveredAt))
        ? 'DELIVERED'
        : 'SENT'
    : message.status,
  contentType: message.contentType ?? 'TEXT',
  mediaUrl: message.deletedAt || message.moderationHiddenAt ? null : message.mediaUrl ?? null,
  metadata: message.deletedAt || message.moderationHiddenAt ? null : message.metadata ?? null,
  replyToId: message.replyToId ?? null,
  forwardedFromId: message.forwardedFromId ?? null,
  editedAt: message.editedAt ?? null,
  expiresAt: message.expiresAt ?? null,
  pinnedAt: message.pinnedAt ?? null,
  starredAt: (message.preferences ?? []).some((preference: { starredAt?: Date | string | null }) => Boolean(preference.starredAt)),
  reactions: message.reactions ?? [],
  ...(viewerUserId === message.senderId && Array.isArray(message.receipts) ? {
    receipts: message.receipts.map((receipt: { recipientId: string; deliveredAt?: Date | string | null; readAt?: Date | string | null; recipient?: { readReceiptsEnabled?: boolean } }) => ({
      recipientId: receipt.recipientId,
      deliveredAt: receipt.deliveredAt ?? null,
      readAt: receipt.recipient?.readReceiptsEnabled === false ? null : receipt.readAt ?? null,
    })),
  } : {}),
});

function giphyMediaUrl(value: unknown) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'giphy.com' || url.hostname.endsWith('.giphy.com')) ? url.toString() : null;
  } catch {
    return null;
  }
}

async function fetchGiphy(path: string, search: Record<string, string>) {
  if (!env.GIPHY_API_KEY) return null;
  const url = new URL(`https://api.giphy.com/v1/${path}`);
  url.search = new URLSearchParams({ api_key: env.GIPHY_API_KEY, ...search }).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`GIPHY returned status ${response.status}.`);
  return response.json() as Promise<{ data?: unknown }>;
}

export const messagesRouter = Router();

messagesRouter.use(requireActiveAccountIfAuthenticated);

messagesRouter.get('/media-picker/:kind', requireAuth, async (req, res) => {
  const kind = z.enum(['gif', 'sticker']).safeParse(req.params.kind);
  if (!kind.success) return res.status(400).json({ message: 'Choose gif or sticker media.' });
  if (!env.GIPHY_API_KEY) return res.status(503).json({ message: 'GIF and sticker search is not configured. Set GIPHY_API_KEY on the server.' });
  const query = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
  const categoriesOnly = kind.data === 'sticker' && req.query.categories === 'true';
  try {
    const response = categoriesOnly
      ? await fetchGiphy('stickers/categories', {})
      : await fetchGiphy(`${kind.data === 'gif' ? 'gifs' : 'stickers'}/${query ? 'search' : 'trending'}`, {
        ...(query ? { q: query } : {}),
        limit: '24',
        rating: 'g',
        lang: 'en',
      });
    const data = Array.isArray(response?.data) ? response.data : [];
    if (categoriesOnly) {
      return res.json({ categories: data.flatMap((entry) => {
        if (typeof entry !== 'object' || entry === null) return [];
        const category = entry as { name?: unknown; name_encoded?: unknown };
        return typeof category.name === 'string' && typeof category.name_encoded === 'string'
          ? [{ name: category.name, query: category.name_encoded }]
          : [];
      }) });
    }
    const items = data.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null) return [];
      const item = entry as { id?: unknown; title?: unknown; images?: Record<string, { url?: unknown } | undefined> };
      const images = item.images ?? {};
      const mediaUrl = giphyMediaUrl(images.original?.url) ?? giphyMediaUrl(images.fixed_height?.url);
      const previewUrl = giphyMediaUrl(images.fixed_height_still?.url) ?? giphyMediaUrl(images.original?.url);
      return typeof item.id === 'string' && mediaUrl && previewUrl
        ? [{ id: item.id, title: typeof item.title === 'string' ? item.title : '', mediaUrl, previewUrl }]
        : [];
    });
    return res.json({ items, attribution: 'Powered by GIPHY' });
  } catch (error) {
    return res.status(502).json({ message: error instanceof Error ? `GIPHY search failed: ${error.message}` : 'GIPHY search failed.' });
  }
});

messagesRouter.post('/conversations', requireAuth, async (req, res) => {
  const payload = createConversationSchema.parse(req.body ?? {});
  const userId = req.user!.id;
  const participantIds = payload.participantIds ?? [payload.participantId!];
  const conversationParticipantIds = [userId, ...participantIds];

  if (participantIds.includes(userId)) {
    return res.status(400).json({ message: 'You cannot create a conversation with yourself.' });
  }

  const dbAvailable = await isDatabaseAvailable();

  if (dbAvailable) {
    const targetUsers = await prisma.user.findMany({ where: { id: { in: participantIds } }, select: { id: true } });
    if (targetUsers.length !== participantIds.length) {
      return res.status(404).json({ message: 'User not found.' });
    }

    for (const participantId of participantIds) {
      if (await isBlocked(userId, participantId)) {
        return res.status(403).json({ message: 'You cannot message a user who has blocked you or who you have blocked.' });
      }
    }

    if (participantIds.length === 1 && !payload.isChannel && !payload.isGroup && !payload.participantIds) {
      const peerId = participantIds[0];
      const pairKey = [userId, peerId].sort().join(':');
      const result = await prisma.$transaction(async (transaction) => {
        await transaction.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${pairKey}))`;
        const existing = await transaction.conversation.findFirst({
          where: {
            isGroup: false,
            isChannel: false,
            AND: conversationParticipantIds.map((participantId) => ({
              participants: { some: { userId: participantId, leftAt: null } },
            })),
            participants: { every: { userId: { in: conversationParticipantIds }, leftAt: null } },
          },
        });
        if (existing) return { conversation: existing, created: false };
        const conversation = await transaction.conversation.create({
          data: {
            ownerId: userId,
            isChannel: false,
            isGroup: false,
            participants: {
              create: conversationParticipantIds.map((participantId, index) => ({
                userId: participantId,
                role: index === 0 ? 'OWNER' : 'MEMBER',
              })),
            },
          },
        });
        return { conversation, created: true };
      });
      return res.status(result.created ? 201 : 200).json({ conversation: {
        id: result.conversation.id,
        name: result.conversation.name,
        updatedAt: result.conversation.updatedAt,
        lastMessageAt: result.conversation.lastMessageAt,
        lastMessagePreview: result.conversation.lastMessagePreview,
      } });
    }

    const conversation = await prisma.conversation.create({
      data: {
        name: payload.name ?? null,
        description: payload.description ?? null,
        imageUrl: null,
        ownerId: userId,
        isChannel: payload.isChannel ?? false,
        isGroup: payload.isGroup ?? (Boolean(payload.participantIds) || Boolean(payload.isChannel)),
        participants: {
          create: conversationParticipantIds.map((participantId, index) => ({
            userId: participantId,
            role: index === 0 ? 'OWNER' : 'MEMBER',
          })),
        },
      },
      include: { participants: true },
    });

    return res.status(201).json({ conversation: {
      id: conversation.id,
      name: conversation.name,
      description: conversation.description,
      imageUrl: conversation.imageUrl,
      isGroup: conversation.isGroup,
      isChannel: conversation.isChannel,
      disappearingAfterSeconds: conversation.disappearingAfterSeconds,
      updatedAt: conversation.updatedAt,
      lastMessageAt: conversation.lastMessageAt,
      lastMessagePreview: conversation.lastMessagePreview,
    } });
  }

  if (participantIds.some((participantId) => !findUserById(participantId))) {
    return res.status(404).json({ message: 'User not found.' });
  }

  for (const participantId of participantIds) {
    if (await isBlocked(userId, participantId)) {
      return res.status(403).json({ message: 'You cannot message a user who has blocked you or who you have blocked.' });
    }
  }

  const existing = participantIds.length === 1 && !payload.isChannel && !payload.isGroup && !payload.participantIds ? socialStore.state.conversations.find((conversation) => {
    if (conversation.isGroup || conversation.isChannel) return false;
    const existingParticipantIds = socialStore.state.conversationParticipants
      .filter((participant) => participant.conversationId === conversation.id && !participant.leftAt)
      .map((participant) => participant.userId);
    return existingParticipantIds.length === 2 && conversationParticipantIds.every((participantId) => existingParticipantIds.includes(participantId));
  }) : undefined;

  if (existing) {
    return res.status(200).json({ conversation: existing });
  }

  const conversation = {
    id: `conversation_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: payload.name ?? null,
    description: payload.description ?? null,
    imageUrl: null,
    ownerId: userId,
    isChannel: payload.isChannel ?? false,
    isGroup: payload.isGroup ?? (Boolean(payload.participantIds) || Boolean(payload.isChannel)),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastMessageAt: null,
    lastMessagePreview: null,
    disappearingAfterSeconds: 0,
  };

  socialStore.state.conversations.push(conversation);
  conversationParticipantIds.forEach((participantId, index) => {
    socialStore.state.conversationParticipants.push({
      id: `participant_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      conversationId: conversation.id,
      userId: participantId,
      role: index === 0 ? 'OWNER' : 'MEMBER',
      joinedAt: new Date().toISOString(),
      lastReadAt: index === 0 ? new Date().toISOString() : null,
      leftAt: null,
    });
  });

  return res.status(201).json({ conversation });
});

messagesRouter.get('/conversations', requireAuth, async (_req, res) => {
  const userId = _req.user!.id;
  const dbAvailable = await isDatabaseAvailable();

  if (dbAvailable) {
    const conversations = await prisma.conversation.findMany({
      where: { participants: { some: { userId, leftAt: null } } },
      include: {
        participants: { where: { leftAt: null }, include: { user: { select: { id: true, name: true, profile: { select: { avatarUrl: true } } } } } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1, include: { preferences: { where: { userId }, select: { starredAt: true } }, receipts: { include: { recipient: { select: { readReceiptsEnabled: true } } } } } },
        _count: { select: { messages: { where: { senderId: { not: userId }, deletedAt: null, moderationHiddenAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }], receipts: { some: { recipientId: userId, readAt: null } } } } } },
      },
      orderBy: { updatedAt: 'desc' },
    });

    return res.json({ conversations: conversations.map((conversation) => {
      const currentParticipant = conversation.participants.find((participant) => participant.userId === userId);
      const lastMessage = conversation.messages[0];
      const publicLastMessage = lastMessage ? messageToPublicShape(lastMessage, userId) : null;
      return {
        id: conversation.id,
        name: conversation.name,
        description: conversation.description,
        imageUrl: conversation.imageUrl,
        isGroup: conversation.isGroup,
        isChannel: conversation.isChannel,
        updatedAt: conversation.updatedAt,
        lastMessageAt: conversation.lastMessageAt,
        lastMessagePreview: publicLastMessage?.text ?? conversation.lastMessagePreview,
        pinnedAt: currentParticipant?.pinnedAt ?? null,
        archivedAt: currentParticipant?.archivedAt ?? null,
        starredAt: currentParticipant?.starredAt ?? null,
        mutedUntil: currentParticipant?.mutedUntil ?? null,
        unreadCount: Math.max(conversation._count.messages, currentParticipant?.unreadMarkedAt ? 1 : 0),
        participants: conversation.participants.map((participant) => ({ id: participant.id, userId: participant.userId, role: conversation.ownerId === participant.userId ? 'OWNER' : participant.role, user: { id: participant.user.id, name: participant.user.name, avatar: participant.user.profile?.avatarUrl ?? '' } })),
        lastMessage: publicLastMessage,
      };
    }) });
  }

  const conversations = socialStore.state.conversations.filter((conversation) => {
    const participants = socialStore.state.conversationParticipants.filter((participant) => participant.conversationId === conversation.id);
    return participants.some((participant) => participant.userId === userId && !participant.leftAt);
  });

  return res.json({ conversations: conversations.map((conversation) => {
    const participants = socialStore.state.conversationParticipants.filter((participant) => participant.conversationId === conversation.id && !participant.leftAt);
    const currentParticipant = participants.find((participant) => participant.userId === userId);
    const lastMessage = socialStore.state.messages
      .filter((message) => message.conversationId === conversation.id)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] ?? null;
    return {
      ...conversation,
      description: conversation.description ?? null,
      imageUrl: conversation.imageUrl ?? null,
      pinnedAt: currentParticipant?.pinnedAt ?? null,
      archivedAt: currentParticipant?.archivedAt ?? null,
      starredAt: currentParticipant?.starredAt ?? null,
      mutedUntil: currentParticipant?.mutedUntil ?? null,
      unreadCount: Math.max(socialStore.state.messages.filter((message) => message.conversationId === conversation.id && message.senderId !== userId && !message.deletedAt && !message.moderationHiddenAt && (!message.expiresAt || new Date(message.expiresAt).getTime() > Date.now()) && (!socialStore.state.messageReceipts.some((receipt) => receipt.messageId === message.id && receipt.recipientId === userId) || !socialStore.state.messageReceipts.find((receipt) => receipt.messageId === message.id && receipt.recipientId === userId)?.readAt)).length, currentParticipant?.unreadMarkedAt ? 1 : 0),
      participants: participants.map((participant) => ({
        ...participant,
        role: conversation.ownerId === participant.userId ? 'OWNER' : participant.role,
        user: findUserById(participant.userId) ? { id: participant.userId, name: findUserById(participant.userId)!.name, avatar: socialStore.state.profiles.find((profile) => profile.userId === participant.userId)?.avatarUrl ?? '' } : undefined,
      })),
      lastMessage: lastMessage ? messageToPublicShape({
        ...lastMessage,
        receipts: socialStore.state.messageReceipts.filter((receipt) => receipt.messageId === lastMessage.id).map((receipt) => ({
          ...receipt,
          recipient: { readReceiptsEnabled: socialStore.state.messagingPreferences[receipt.recipientId]?.readReceiptsEnabled ?? true },
        })),
      }, userId) : null,
      lastMessagePreview: lastMessage ? messageToPublicShape(lastMessage).text : conversation.lastMessagePreview,
    };
  }) });
});

messagesRouter.get('/conversations/:id', requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const conversationId = String(req.params.id);

  if (!(await canViewConversation(conversationId, userId))) {
    return res.status(403).json({ message: 'You do not have access to this conversation.' });
  }
  const dbAvailable = await isDatabaseAvailable();

  if (dbAvailable) {
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        participants: { include: { user: { select: { id: true, name: true, profile: { select: { avatarUrl: true } } } } } },
        messages: { where: { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, include: { reactions: true, preferences: { where: { userId }, select: { starredAt: true } }, receipts: { include: { recipient: { select: { readReceiptsEnabled: true } } } } }, orderBy: { createdAt: 'asc' } },
      },
    });

    if (!conversation) {
      return res.status(404).json({ message: 'Conversation not found.' });
    }

    return res.json({ conversation: {
      id: conversation.id,
      name: conversation.name,
      isGroup: conversation.isGroup,
      updatedAt: conversation.updatedAt,
      lastMessageAt: conversation.lastMessageAt,
      lastMessagePreview: conversation.messages.length
        ? messageToPublicShape(conversation.messages.at(-1)).text
        : conversation.lastMessagePreview,
      isChannel: conversation.isChannel,
      disappearingAfterSeconds: conversation.disappearingAfterSeconds,
      participants: conversation.participants.map((participant) => ({ id: participant.id, userId: participant.userId, role: participant.role, user: { id: participant.user.id, name: participant.user.name, avatar: participant.user.profile?.avatarUrl ?? '' } })),
      messages: conversation.messages.filter((message) => !message.deletedAt).map((message) => messageToPublicShape(message, userId)),
    } });
  }

  const conversation = socialStore.state.conversations.find((entry) => entry.id === conversationId);
  if (!conversation) {
    return res.status(404).json({ message: 'Conversation not found.' });
  }

  const conversationMessages = socialStore.state.messages
    .filter((message) => message.conversationId === conversationId && !message.deletedAt && (!message.expiresAt || new Date(message.expiresAt).getTime() > Date.now()))
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  return res.json({
    conversation: {
      ...conversation,
      lastMessagePreview: conversationMessages.length
        ? messageToPublicShape(conversationMessages.at(-1)).text
        : conversation.lastMessagePreview,
      participants: socialStore.state.conversationParticipants.filter((participant) => participant.conversationId === conversationId),
      messages: conversationMessages.map((message) => messageToPublicShape({
        ...message,
        preferences: socialStore.state.messagePreferences.filter((preference) => preference.messageId === message.id && preference.userId === userId),
        receipts: socialStore.state.messageReceipts.filter((receipt) => receipt.messageId === message.id).map((receipt) => ({
          ...receipt,
          recipient: { readReceiptsEnabled: socialStore.state.messagingPreferences[receipt.recipientId]?.readReceiptsEnabled ?? true },
        })),
      }, userId)),
    },
  });
});

messagesRouter.post('/conversations/:id/messages', requireAuth, async (req, res) => {
  const conversationId = String(req.params.id);
  const userId = req.user!.id;
  const payload = messageSchema.parse(req.body ?? {});
  const timedReplyResult = payload.metadata?.timedUpdateReply === undefined
    ? null
    : timedUpdateReplySchema.safeParse(payload.metadata.timedUpdateReply);
  if (timedReplyResult && !timedReplyResult.success) {
    return res.status(400).json({ message: 'Invalid Story or Status reply context.' });
  }
  const timedReply = timedReplyResult?.data ?? null;
  if (timedReply && !payload.text?.trim() && !timedReply.reaction) {
    return res.status(400).json({ message: 'Write a reply or choose a reaction.' });
  }

  if (!(await canViewConversation(conversationId, userId))) {
    return res.status(403).json({ message: 'You do not have access to this conversation.' });
  }
  if (payload.mediaUrl && !(await uploadedMediaBelongsTo(payload.mediaUrl, userId, process.env.NODE_ENV ?? 'development'))) {
    return res.status(403).json({ message: 'You can only attach media that you uploaded.' });
  }
  const attachmentKey = payload.mediaUrl ? attachmentMediaKeyFromUrl(payload.mediaUrl) : null;
  if (attachmentKey) {
    const attachment = await getMediaStorage(process.env.NODE_ENV ?? 'development').get(attachmentKey);
    const supportedForType = payload.contentType === 'VOICE'
      ? attachment?.contentType.startsWith('audio/')
      : payload.contentType === 'VIDEO'
        ? attachment?.contentType.startsWith('video/')
        : payload.contentType === 'DOCUMENT'
          ? ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(attachment?.contentType ?? '')
          : false;
    if (!supportedForType) return res.status(400).json({ message: 'This attachment type does not match the message type.' });
  }
  const imageKey = payload.mediaUrl ? mediaKeyFromUrl(payload.mediaUrl) : null;
  if (imageKey) {
    const image = await getMediaStorage(process.env.NODE_ENV ?? 'development').get(imageKey);
    if (payload.contentType !== 'IMAGE' || image?.contentType !== 'image/webp') {
      return res.status(400).json({ message: 'This attachment type does not match the message type.' });
    }
  }

  const dbAvailable = await isDatabaseAvailable();
  const conversation = dbAvailable
    ? await prisma.conversation.findUnique({ where: { id: conversationId }, select: { isChannel: true, isGroup: true, disappearingAfterSeconds: true } })
    : socialStore.state.conversations.find((entry) => entry.id === conversationId);
  if (!conversation) return res.status(404).json({ message: 'Conversation not found.' });
  if (conversation.isChannel) {
    const participant = dbAvailable
      ? await prisma.conversationParticipant.findUnique({ where: { conversationId_userId: { conversationId, userId } }, select: { role: true } })
      : socialStore.state.conversationParticipants.find((entry) => entry.conversationId === conversationId && entry.userId === userId);
    if (!participant || !['OWNER', 'MODERATOR'].includes(participant.role)) {
      return res.status(403).json({ message: 'Only channel admins and moderators can post.' });
    }
  }

  if (payload.replyToId) {
    const parent = dbAvailable
      ? await prisma.message.findFirst({ where: { id: payload.replyToId, conversationId, deletedAt: null, moderationHiddenAt: null }, select: { id: true } })
      : socialStore.state.messages.find((message) => message.id === payload.replyToId && message.conversationId === conversationId && !message.deletedAt && !message.moderationHiddenAt);
    if (!parent) return res.status(404).json({ message: 'Reply target not found in this conversation.' });
  }

  const recipients = await (async () => {
    const dbAvailable = await isDatabaseAvailable();

    if (dbAvailable) {
      const participants = await prisma.conversationParticipant.findMany({
        where: { conversationId, leftAt: null },
        select: { userId: true },
      });
      return participants.filter((participant) => participant.userId !== userId).map((participant) => participant.userId);
    }

    const participants = socialStore.state.conversationParticipants.filter((participant) => participant.conversationId === conversationId && !participant.leftAt);
    return participants.filter((participant) => participant.userId !== userId).map((participant) => participant.userId);
  })();

  for (const recipientId of recipients) {
    if (await isBlocked(userId, recipientId)) {
      return res.status(403).json({ message: 'You cannot send messages to a blocked user.' });
    }
  }

  let timedUpdateContext: Record<string, unknown> | null = null;
  if (timedReply) {
    if (recipients.length !== 1 || conversation.isGroup || conversation.isChannel) {
      return res.status(403).json({ message: 'Timed update replies must be sent in a private conversation.' });
    }
    const authorId = recipients[0];
    const update = dbAvailable
      ? await prisma.story.findFirst({
        where: { id: timedReply.id, kind: timedReply.kind, expiresAt: { gt: new Date() } },
        select: { id: true, authorId: true, kind: true, text: true, mediaUrl: true, createdAt: true, expiresAt: true },
      })
      : socialStore.state.stories.find((entry) => entry.id === timedReply.id
        && (entry.kind ?? 'STORY') === timedReply.kind
        && new Date(entry.expiresAt).getTime() > Date.now());
    if (!update || update.authorId !== authorId || authorId === userId) {
      return res.status(404).json({ message: 'This Story or Status has expired or is no longer available.' });
    }
    const followsAuthor = dbAvailable
      ? Boolean(await prisma.follow.findUnique({
        where: { followerId_followingId: { followerId: userId, followingId: authorId } },
        select: { id: true },
      }))
      : socialStore.state.follows.some((follow) => follow.followerId === userId && follow.followingId === authorId);
    if (!followsAuthor || await isBlocked(userId, authorId)) {
      return res.status(404).json({ message: 'This Story or Status is no longer available.' });
    }
    timedUpdateContext = {
      kind: timedReply.kind,
      id: update.id,
      text: update.text,
      mediaUrl: update.mediaUrl,
      createdAt: update.createdAt,
      expiresAt: update.expiresAt,
      authorId: update.authorId,
    };
  }

  const moderation = reviewContentForSafety({ type: 'message', text: payload.text ?? '', userId });
  if (moderation === 'REMOVE') {
    return res.status(400).json({ message: 'This message violates NOVA Community & Safety Rules.' });
  }
  if (moderation === 'REVIEW') {
    return res.status(422).json({ message: 'This content requires moderator review before publication.' });
  }

  if (dbAvailable) {
    const disappearingAfterSeconds = conversation.disappearingAfterSeconds ?? 0;
    const expiresAt = disappearingAfterSeconds > 0
      ? new Date(Date.now() + disappearingAfterSeconds * 1000)
      : undefined;
    const messageText = timedReply && !payload.text?.trim()
      ? `Reacted ${timedReply.reaction} to your ${timedReply.kind === 'STORY' ? 'Story' : 'Status'}`
      : payload.text ?? '';
    const messageMetadata = timedReply
      ? { ...(payload.metadata ?? {}), timedUpdate: timedUpdateContext, timedUpdateReaction: timedReply.reaction ?? null } as Prisma.InputJsonValue
      : payload.metadata as Prisma.InputJsonValue | undefined;
    const created = await prisma.message.create({
      data: {
        conversationId,
        senderId: userId,
        text: messageText,
        status: 'SENT',
        contentType: payload.contentType,
        mediaUrl: payload.mediaUrl,
        metadata: messageMetadata,
        replyToId: payload.replyToId,
        expiresAt,
        receipts: { create: recipients.map((recipientId) => ({ recipientId })) },
      },
      include: { receipts: { include: { recipient: { select: { readReceiptsEnabled: true } } } } },
    });

    const preview = messageText || `[${payload.contentType.toLowerCase()}]`;

    await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        lastMessageAt: created.createdAt,
        lastMessagePreview: preview,
        updatedAt: created.updatedAt,
      },
    });

    emitConversationEvent('message:new', conversationId, { message: messageToPublicShape(created), senderId: userId }, [userId, ...recipients]);
    if (timedReply) {
      const sender = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
      await createNotification(
        recipients[0],
        userId,
        `message_${timedReply.kind.toLowerCase()}_reply`,
        `${sender?.name ?? 'Someone'} ${timedReply.reaction
          ? `reacted ${timedReply.reaction} to your ${timedReply.kind === 'STORY' ? 'Story' : 'Status'}`
          : `replied to your ${timedReply.kind === 'STORY' ? 'Story' : 'Status'}`}.`,
        { link: `/messages?conversationId=${encodeURIComponent(conversationId)}`, dedupeKey: `timed-update-reply:${created.id}` },
      );
    }

    return res.status(201).json({ message: messageToPublicShape(created, userId) });
  }

  const created: MessageRecord = {
    id: `message_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    conversationId,
    senderId: userId,
    text: timedReply && !payload.text?.trim()
      ? `Reacted ${timedReply.reaction} to your ${timedReply.kind === 'STORY' ? 'Story' : 'Status'}`
      : payload.text ?? '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    readAt: null,
    deletedAt: null,
    status: 'SENT',
    contentType: payload.contentType,
    mediaUrl: payload.mediaUrl ?? null,
    metadata: timedReply
      ? { ...(payload.metadata ?? {}), timedUpdate: timedUpdateContext, timedUpdateReaction: timedReply.reaction ?? null }
      : payload.metadata ?? null,
    replyToId: payload.replyToId ?? null,
    forwardedFromId: null,
    editedAt: null,
    expiresAt: conversation.disappearingAfterSeconds && conversation.disappearingAfterSeconds > 0
      ? new Date(Date.now() + conversation.disappearingAfterSeconds * 1000).toISOString()
      : null,
  };

  socialStore.state.messages.push(created);
  socialStore.state.messageReceipts.push(...recipients.map((recipientId, index) => ({
    id: `receipt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${index}`,
    messageId: created.id,
    recipientId,
    deliveredAt: null,
    readAt: null,
  })));

  const fallbackConversation = socialStore.state.conversations.find((entry) => entry.id === conversationId);
  if (fallbackConversation) {
    fallbackConversation.updatedAt = new Date().toISOString();
    fallbackConversation.lastMessageAt = new Date().toISOString();
    fallbackConversation.lastMessagePreview = created.text || `[${payload.contentType.toLowerCase()}]`;
  }

  emitConversationEvent('message:new', conversationId, { message: messageToPublicShape(created), senderId: userId }, [userId, ...recipients]);
  if (timedReply) {
    const sender = findUserById(userId);
    await createNotification(
      recipients[0],
      userId,
      `message_${timedReply.kind.toLowerCase()}_reply`,
      `${sender?.name ?? 'Someone'} ${timedReply.reaction
        ? `reacted ${timedReply.reaction} to your ${timedReply.kind === 'STORY' ? 'Story' : 'Status'}`
        : `replied to your ${timedReply.kind === 'STORY' ? 'Story' : 'Status'}`}.`,
      { link: `/messages?conversationId=${encodeURIComponent(conversationId)}`, dedupeKey: `timed-update-reply:${created.id}` },
    );
  }

  return res.status(201).json({ message: messageToPublicShape({
    ...created,
    receipts: socialStore.state.messageReceipts.filter((receipt) => receipt.messageId === created.id).map((receipt) => ({
      ...receipt,
      recipient: { readReceiptsEnabled: socialStore.state.messagingPreferences[receipt.recipientId]?.readReceiptsEnabled ?? true },
    })),
  }, userId) });
});

messagesRouter.post('/messages/:id/interactive-response', requireAuth, async (req, res) => {
  const messageId = String(req.params.id);
  const payload = interactiveResponseSchema.parse(req.body ?? {});
  const dbAvailable = await isDatabaseAvailable();
  const message = dbAvailable
    ? await prisma.message.findUnique({ where: { id: messageId } })
    : socialStore.state.messages.find((entry) => entry.id === messageId);
  if (!message || message.deletedAt || message.moderationHiddenAt) return res.status(404).json({ message: 'Message not found.' });
  if (!(await canViewConversation(message.conversationId, req.user!.id))) return res.status(403).json({ message: 'You do not have access to this message.' });

  const metadata = (message.metadata ?? {}) as Record<string, unknown>;
  let updatedMetadata: Record<string, unknown>;
  if (message.contentType === 'POLL' && payload.optionId) {
    const options = Array.isArray(metadata.options) ? metadata.options as Array<{ id?: unknown }> : [];
    if (!options.some((option) => option.id === payload.optionId)) return res.status(400).json({ message: 'Choose an option from this poll.' });
    const votes = metadata.votes && typeof metadata.votes === 'object' ? metadata.votes as Record<string, unknown> : {};
    updatedMetadata = { ...metadata, votes: { ...votes, [req.user!.id]: payload.optionId } };
  } else if (message.contentType === 'EVENT' && payload.response) {
    const responses = metadata.responses && typeof metadata.responses === 'object' ? metadata.responses as Record<string, unknown> : {};
    updatedMetadata = { ...metadata, responses: { ...responses, [req.user!.id]: payload.response } };
  } else {
    return res.status(400).json({ message: 'This message does not accept that response.' });
  }

  const updated = dbAvailable
    ? await prisma.message.update({ where: { id: messageId }, data: { metadata: updatedMetadata as Prisma.InputJsonValue } })
    : Object.assign(message, { metadata: updatedMetadata, updatedAt: new Date().toISOString() });
  emitConversationEvent('message:new', message.conversationId, { message: messageToPublicShape(updated) }, await listConversationParticipantIds(message.conversationId));
  return res.json({ message: messageToPublicShape(updated) });
});

messagesRouter.get('/conversations/:id/messages', requireAuth, async (req, res) => {
  const conversationId = String(req.params.id);
  const userId = req.user!.id;

  if (!(await canViewConversation(conversationId, userId))) {
    return res.status(403).json({ message: 'You do not have access to this conversation.' });
  }

  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const before = typeof req.query.before === 'string' ? new Date(req.query.before) : null;
  const dbAvailable = await isDatabaseAvailable();

  if (dbAvailable) {
    const messages = await prisma.message.findMany({
      where: { conversationId, deletedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }], ...(before && !Number.isNaN(before.getTime()) ? { createdAt: { lt: before } } : {}) },
      include: { reactions: true, preferences: { where: { userId }, select: { starredAt: true } }, receipts: { include: { recipient: { select: { readReceiptsEnabled: true } } } } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    const newlyDelivered = messages.filter((message) => message.senderId !== userId
      && !(message.receipts ?? []).some((receipt) => receipt.recipientId === userId && receipt.deliveredAt));
    if (newlyDelivered.length) {
      const deliveredAt = new Date();
      await prisma.messageReceipt.updateMany({
        where: { messageId: { in: newlyDelivered.map((message) => message.id) }, recipientId: userId, deliveredAt: null },
        data: { deliveredAt },
      });
      for (const message of newlyDelivered) {
        emitConversationEvent('message:delivered', conversationId, { messageId: message.id, recipientId: userId, deliveredAt }, [message.senderId]);
      }
    }
    const deliveredIds = new Set(newlyDelivered.map((message) => message.id));
    return res.json({ messages: messages.reverse().map((message) => {
      const receipts = (message.receipts ?? []).map((receipt) =>
        receipt.recipientId === userId && deliveredIds.has(message.id)
          ? { ...receipt, deliveredAt: receipt.deliveredAt ?? new Date() }
          : receipt);
      return messageToPublicShape({ ...message, receipts }, userId);
    }), hasMore: messages.length === limit });
  }

  const messages = socialStore.state.messages
    .filter((message) => message.conversationId === conversationId && !message.deletedAt && (!message.expiresAt || new Date(message.expiresAt).getTime() > Date.now()))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .filter((message) => !before || new Date(message.createdAt) < before)
    .slice(0, limit)
    .map((message) => {
      if (message.senderId === userId) return message;
      let receipt = socialStore.state.messageReceipts.find((entry) => entry.messageId === message.id && entry.recipientId === userId);
      if (!receipt) {
        receipt = { id: `receipt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, messageId: message.id, recipientId: userId, deliveredAt: null, readAt: null };
        socialStore.state.messageReceipts.push(receipt);
      }
      if (receipt.deliveredAt) return message;
      receipt.deliveredAt = new Date().toISOString();
      emitConversationEvent('message:delivered', conversationId, { messageId: message.id, recipientId: userId, deliveredAt: receipt.deliveredAt }, [message.senderId]);
      return message;
    })
    .reverse();

  return res.json({ messages: messages.map((message) => messageToPublicShape({
    ...message,
    preferences: socialStore.state.messagePreferences.filter((preference) => preference.messageId === message.id && preference.userId === userId),
    receipts: socialStore.state.messageReceipts.filter((receipt) => receipt.messageId === message.id).map((receipt) => ({
      ...receipt,
      recipient: { readReceiptsEnabled: socialStore.state.messagingPreferences[receipt.recipientId]?.readReceiptsEnabled ?? true },
    })),
  }, userId)), hasMore: messages.length === limit });
});

messagesRouter.post('/conversations/:id/read', requireAuth, async (req, res) => {
  const conversationId = String(req.params.id);
  const userId = req.user!.id;
  if (!(await canViewConversation(conversationId, userId))) {
    return res.status(403).json({ message: 'You do not have access to this conversation.' });
  }

  const readAt = new Date();
  const dbAvailable = await isDatabaseAvailable();
  if (dbAvailable) {
    await prisma.conversationParticipant.update({
      where: { conversationId_userId: { conversationId, userId } },
      data: { lastReadAt: readAt, unreadMarkedAt: null },
    });
    const unreadMessages = await prisma.message.findMany({
      where: { conversationId, senderId: { not: userId }, deletedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: readAt } }], receipts: { none: { recipientId: userId, readAt: { not: null } } } },
      select: { id: true, senderId: true },
    });
    if (unreadMessages.length) {
      await prisma.messageReceipt.createMany({
        data: unreadMessages.map((message) => ({ messageId: message.id, recipientId: userId })),
        skipDuplicates: true,
      });
      await prisma.messageReceipt.updateMany({
        where: { messageId: { in: unreadMessages.map((message) => message.id) }, recipientId: userId, readAt: null },
        data: { deliveredAt: readAt, readAt },
      });
      const readReceiptsEnabled = (await messagingPreferencesFor(userId))?.readReceiptsEnabled ?? true;
      if (readReceiptsEnabled) for (const message of unreadMessages) {
        emitConversationEvent('message:read', conversationId, { messageId: message.id, recipientId: userId, readAt }, [message.senderId]);
      }
    }
  } else {
    const participant = socialStore.state.conversationParticipants.find((entry) => entry.conversationId === conversationId && entry.userId === userId && !entry.leftAt);
    if (participant) {
      participant.lastReadAt = readAt.toISOString();
      participant.unreadMarkedAt = null;
    }
    const readReceiptsEnabled = (await messagingPreferencesFor(userId))?.readReceiptsEnabled ?? true;
    socialStore.state.messages.filter((message) => message.conversationId === conversationId && message.senderId !== userId && !message.deletedAt && (!message.expiresAt || new Date(message.expiresAt).getTime() > readAt.getTime())).forEach((message) => {
      let receipt = socialStore.state.messageReceipts.find((entry) => entry.messageId === message.id && entry.recipientId === userId);
      if (!receipt) {
        receipt = { id: `receipt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, messageId: message.id, recipientId: userId, deliveredAt: readAt.toISOString(), readAt: null };
        socialStore.state.messageReceipts.push(receipt);
      }
      const wasUnread = !receipt.readAt;
      if (wasUnread) receipt.readAt = readAt.toISOString();
      receipt.deliveredAt ??= readAt.toISOString();
      if (wasUnread && readReceiptsEnabled) emitConversationEvent('message:read', conversationId, { messageId: message.id, recipientId: userId, readAt }, [message.senderId]);
    });
  }
  realtimeHub.emit('conversation:read', { conversationId, allowedUserIds: [userId] });
  return res.json({ readAt });
});

messagesRouter.get('/messaging/preferences', requireAuth, async (req, res) => {
  const preferences = await messagingPreferencesFor(req.user!.id);
  if (!preferences) return res.status(404).json({ message: 'User not found.' });
  return res.json({ preferences });
});

messagesRouter.patch('/messaging/preferences', requireAuth, async (req, res) => {
  const payload = messagingPreferenceSchema.parse(req.body ?? {});
  const userId = req.user!.id;
  const dbAvailable = await isDatabaseAvailable();
  const preferences: { readReceiptsEnabled: boolean; presenceVisibility: PresenceVisibility } = dbAvailable
    ? await prisma.user.update({
      where: { id: userId },
      data: payload,
      select: { readReceiptsEnabled: true, presenceVisibility: true },
    })
    : (socialStore.state.messagingPreferences[userId] = Object.assign(
      socialStore.state.messagingPreferences[userId] ?? { readReceiptsEnabled: true, presenceVisibility: 'EVERYONE' as const },
      payload,
    ));
  if (payload.presenceVisibility !== undefined) {
    await revokePresenceVisibility(userId);
    if (isUserConnected(userId)) await publishPresenceChange(userId, true);
  }
  return res.json({ preferences });
});

messagesRouter.get('/presence/:userId', requireAuth, async (req, res) => {
  const targetId = String(req.params.userId);
  const dbAvailable = await isDatabaseAvailable();
  let lastSeenAt: Date | string | null;
  if (dbAvailable) {
    const target = await prisma.user.findUnique({ where: { id: targetId }, select: { lastSeenAt: true } });
    if (!target) return res.status(404).json({ message: 'User not found.' });
    lastSeenAt = target.lastSeenAt;
  } else {
    if (!findUserById(targetId)) return res.status(404).json({ message: 'User not found.' });
    lastSeenAt = socialStore.state.messagingLastSeenAt[targetId] ?? null;
  }
  if (!(await canViewPresence(req.user!.id, targetId))) {
    return res.status(404).json({ message: 'Presence is unavailable.' });
  }
  return res.json({ presence: {
    online: isUserConnected(targetId),
    lastSeenAt: isUserConnected(targetId) ? null : lastSeenAt,
  } });
});

messagesRouter.post('/presence', requireAuth, (_req, res) =>
  res.status(410).json({ message: 'Presence is managed by authenticated real-time connections.' }));

messagesRouter.post('/conversations/:id/recording', requireAuth, async (req, res) => {
  const conversationId = String(req.params.id);
  const { recording } = recordingSchema.parse(req.body ?? {});
  const userId = req.user!.id;
  if (!(await canViewConversation(conversationId, userId))) return res.status(403).json({ message: 'You do not have access to this conversation.' });
  const participantIds = await listConversationParticipantIds(conversationId);
  if (!participantIds.includes(userId)) return res.status(403).json({ message: 'You do not have access to this conversation.' });
  updateRecordingState(conversationId, userId, recording, participantIds.filter((participantId) => participantId !== userId));
  return res.json({ recording });
});

messagesRouter.post('/conversations/:id/unread', requireAuth, async (req, res) => {
  const conversationId = String(req.params.id);
  const userId = req.user!.id;
  if (!(await canViewConversation(conversationId, userId))) return res.status(403).json({ message: 'You do not have access to this conversation.' });
  const dbAvailable = await isDatabaseAvailable();
  const markedAt = new Date();
  if (dbAvailable) {
    await prisma.conversationParticipant.update({
      where: { conversationId_userId: { conversationId, userId } },
      data: { unreadMarkedAt: markedAt },
    });
  } else {
    const participant = socialStore.state.conversationParticipants.find((entry) => entry.conversationId === conversationId && entry.userId === userId && !entry.leftAt);
    if (!participant) return res.status(404).json({ message: 'Conversation membership not found.' });
    participant.unreadMarkedAt = markedAt.toISOString();
  }
  realtimeHub.emit('conversation:unread', { conversationId, allowedUserIds: [userId] });
  return res.json({ unread: true });
});

messagesRouter.get('/realtime', requireAuth, (req, res) => {
  const userId = req.user!.id;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write(`event: ready\ndata: ${JSON.stringify({ userId })}\n\n`);
  const unsubscribe = subscribeToUserEvents(userId, (payload) => {
    const event = typeof payload === 'object' && payload !== null && 'event' in payload ? String((payload as { event: string }).event) : 'update';
    if (!res.destroyed && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  });
  const unregisterConnection = registerRealtimeConnection(userId, (online) => {
    if (online) void publishPresenceChange(userId, true);
    else void publishPresenceChange(userId, false, new Date());
  });
  const heartbeat = setInterval(() => {
    if (!res.destroyed && !res.writableEnded) res.write(': heartbeat\n\n');
  }, 25000);
  res.on('close', () => { clearInterval(heartbeat); unsubscribe(); unregisterConnection(); });
});

messagesRouter.post('/messages/:id/read', requireAuth, async (req, res) => {
  const messageId = String(req.params.id);
  const userId = req.user!.id;
  const dbAvailable = await isDatabaseAvailable();

  if (dbAvailable) {
    const message = await prisma.message.findUnique({
      where: { id: messageId },
      select: { id: true, conversationId: true, senderId: true },
    });

    if (!message) {
      return res.status(404).json({ message: 'Message not found.' });
    }

    if (!(await canViewConversation(message.conversationId, userId))) {
      return res.status(403).json({ message: 'You do not have access to this message.' });
    }
    if (message.senderId === userId) return res.status(400).json({ message: 'You cannot mark your own message as read.' });

    const readAt = new Date();
    const receipt = await prisma.messageReceipt.upsert({
      where: { messageId_recipientId: { messageId, recipientId: userId } },
      create: { messageId, recipientId: userId, deliveredAt: readAt, readAt },
      update: { deliveredAt: readAt, readAt },
    });
    const preferences = await messagingPreferencesFor(userId);
    if (preferences?.readReceiptsEnabled) emitConversationEvent('message:read', message.conversationId, { messageId, recipientId: userId, readAt }, [message.senderId]);
    return res.json({ receipt: { deliveredAt: receipt.deliveredAt, readAt: preferences?.readReceiptsEnabled ? receipt.readAt : null } });
  }

  const message = socialStore.state.messages.find((entry) => entry.id === messageId);
  if (!message) {
    return res.status(404).json({ message: 'Message not found.' });
  }

  if (!(await canViewConversation(message.conversationId, userId))) {
    return res.status(403).json({ message: 'You do not have access to this message.' });
  }
  if (message.senderId === userId) return res.status(400).json({ message: 'You cannot mark your own message as read.' });

  const readAt = new Date().toISOString();
  let receipt = socialStore.state.messageReceipts.find((entry) => entry.messageId === messageId && entry.recipientId === userId);
  if (!receipt) {
    receipt = { id: `receipt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, messageId, recipientId: userId, deliveredAt: readAt, readAt };
    socialStore.state.messageReceipts.push(receipt);
  } else {
    receipt.deliveredAt ??= readAt;
    receipt.readAt = readAt;
  }
  const preferences = await messagingPreferencesFor(userId);
  if (preferences?.readReceiptsEnabled) emitConversationEvent('message:read', message.conversationId, { messageId, recipientId: userId, readAt }, [message.senderId]);
  return res.json({ receipt: { deliveredAt: receipt.deliveredAt, readAt: preferences?.readReceiptsEnabled ? receipt.readAt : null } });
});

messagesRouter.get('/messages/:id/receipts', requireAuth, async (req, res) => {
  const messageId = String(req.params.id);
  const userId = req.user!.id;
  const dbAvailable = await isDatabaseAvailable();
  if (dbAvailable) {
    const message = await prisma.message.findUnique({
      where: { id: messageId },
      select: { id: true, senderId: true, conversationId: true, deletedAt: true, moderationHiddenAt: true },
    });
    if (!message || message.deletedAt || message.moderationHiddenAt) return res.status(404).json({ message: 'Message not found.' });
    if (message.senderId !== userId) return res.status(403).json({ message: 'Only the message sender can view receipt details.' });
    const [participants, receipts] = await Promise.all([
      prisma.conversationParticipant.findMany({ where: { conversationId: message.conversationId, userId: { not: userId }, leftAt: null }, include: { user: { select: { id: true, name: true } } } }),
      prisma.messageReceipt.findMany({ where: { messageId }, include: { recipient: { select: { id: true, name: true, readReceiptsEnabled: true } } } }),
    ]);
    const receiptByRecipient = new Map(receipts.map((receipt) => [receipt.recipientId, receipt]));
    return res.json({ receipts: participants.map((participant) => {
      const receipt = receiptByRecipient.get(participant.userId);
      return {
        recipientId: participant.userId,
        name: participant.user.name,
        deliveredAt: receipt?.deliveredAt ?? null,
        readAt: receipt?.recipient.readReceiptsEnabled === false ? null : receipt?.readAt ?? null,
      };
    }) });
  }

  const message = socialStore.state.messages.find((entry) => entry.id === messageId);
  if (!message || message.deletedAt || message.moderationHiddenAt) return res.status(404).json({ message: 'Message not found.' });
  if (message.senderId !== userId) return res.status(403).json({ message: 'Only the message sender can view receipt details.' });
  const recipients = socialStore.state.conversationParticipants.filter((entry) => entry.conversationId === message.conversationId && entry.userId !== userId && !entry.leftAt);
  return res.json({ receipts: recipients.map((recipient) => {
    const user = findUserById(recipient.userId);
    const receipt = socialStore.state.messageReceipts.find((entry) => entry.messageId === messageId && entry.recipientId === recipient.userId);
    const enabled = socialStore.state.messagingPreferences[recipient.userId]?.readReceiptsEnabled ?? true;
    return { recipientId: recipient.userId, name: user?.name ?? 'Unknown', deliveredAt: receipt?.deliveredAt ?? null, readAt: enabled ? receipt?.readAt ?? null : null };
  }) });
});

messagesRouter.delete('/messages/:id', requireAuth, async (req, res) => {
  const messageId = String(req.params.id);
  const userId = req.user!.id;
  const dbAvailable = await isDatabaseAvailable();

  if (dbAvailable) {
    const message = await prisma.message.findUnique({
      where: { id: messageId },
      select: { id: true, senderId: true, conversationId: true, deletedAt: true, moderationHiddenAt: true },
    });

    if (!message || message.moderationHiddenAt) {
      return res.status(404).json({ message: 'Message not found.' });
    }

    if (message.senderId !== userId) {
      return res.status(403).json({ message: 'You cannot delete this message.' });
    }

    const deleted = await prisma.message.update({
      where: { id: messageId },
      data: { deletedAt: new Date(), status: 'DELETED', text: '[deleted]' },
    });
    emitConversationEvent('message:new', message.conversationId, { message: messageToPublicShape(deleted), deleted: true }, await listConversationParticipantIds(message.conversationId));
    return res.json({ message: messageToPublicShape(deleted) });
  }

  const message = socialStore.state.messages.find((entry) => entry.id === messageId);
  if (!message || message.moderationHiddenAt) {
    return res.status(404).json({ message: 'Message not found.' });
  }

  if (message.senderId !== userId) {
    return res.status(403).json({ message: 'You cannot delete this message.' });
  }

  message.deletedAt = new Date().toISOString();
  message.status = 'DELETED' as 'SENT' | 'DELIVERED' | 'READ' | 'FAILED' | 'DELETED';
  message.text = '[deleted]';
  emitConversationEvent('message:new', message.conversationId, { message: messageToPublicShape(message), deleted: true }, await listConversationParticipantIds(message.conversationId));
  return res.json({ message: messageToPublicShape(message) });
});

messagesRouter.patch('/messages/:id', requireAuth, async (req, res) => {
  const messageId = String(req.params.id);
  const payload = messageEditSchema.parse(req.body ?? {});
  const userId = req.user!.id;
  const dbAvailable = await isDatabaseAvailable();
  const current = dbAvailable
    ? await prisma.message.findUnique({ where: { id: messageId } })
    : socialStore.state.messages.find((message) => message.id === messageId);
  if (!current || current.deletedAt || current.moderationHiddenAt) return res.status(404).json({ message: 'Message not found.' });
  if (current.senderId !== userId) return res.status(403).json({ message: 'You cannot edit this message.' });
  if ((current.contentType ?? 'TEXT') !== 'TEXT') return res.status(400).json({ message: 'Only text messages can be edited.' });
  const moderation = reviewContentForSafety({ type: 'message', text: payload.text, userId });
  if (moderation !== 'ALLOW') return res.status(moderation === 'REMOVE' ? 400 : 422).json({ message: 'This message cannot be published under NOVA Community & Safety Rules.' });
  const editedAt = new Date();
  const updated = dbAvailable
    ? await prisma.message.update({ where: { id: messageId }, data: { text: payload.text, editedAt } })
    : Object.assign(current, { text: payload.text, editedAt: editedAt.toISOString(), updatedAt: editedAt.toISOString() });
  emitConversationEvent('message:new', current.conversationId, { message: messageToPublicShape(updated), edited: true }, await listConversationParticipantIds(current.conversationId));
  return res.json({ message: messageToPublicShape(updated) });
});

messagesRouter.post('/messages/:id/forward', requireAuth, async (req, res) => {
  const sourceId = String(req.params.id);
  const targetConversationId = z.object({ conversationId: z.string().min(1) }).parse(req.body ?? {}).conversationId;
  const userId = req.user!.id;
  if (!(await canViewConversation(targetConversationId, userId))) return res.status(403).json({ message: 'You do not have access to the destination conversation.' });
  const dbAvailable = await isDatabaseAvailable();
  const source = dbAvailable
    ? await prisma.message.findUnique({ where: { id: sourceId } })
    : socialStore.state.messages.find((message) => message.id === sourceId);
  if (!source || source.deletedAt || source.moderationHiddenAt) return res.status(404).json({ message: 'Message not found.' });
  if (!(await canViewConversation(source.conversationId, userId))) return res.status(403).json({ message: 'You do not have access to this message.' });
  const target = dbAvailable
    ? await prisma.conversation.findUnique({ where: { id: targetConversationId }, select: { isChannel: true, disappearingAfterSeconds: true } })
    : socialStore.state.conversations.find((entry) => entry.id === targetConversationId);
  if (!target) return res.status(404).json({ message: 'Destination conversation not found.' });
  if (target.isChannel) {
    const member = dbAvailable
      ? await prisma.conversationParticipant.findUnique({ where: { conversationId_userId: { conversationId: targetConversationId, userId } }, select: { role: true } })
      : socialStore.state.conversationParticipants.find((entry) => entry.conversationId === targetConversationId && entry.userId === userId);
    if (!member || !['OWNER', 'MODERATOR'].includes(member.role)) return res.status(403).json({ message: 'Only channel admins and moderators can post.' });
  }
  const recipients = dbAvailable
    ? (await prisma.conversationParticipant.findMany({ where: { conversationId: targetConversationId, leftAt: null }, select: { userId: true } })).map((entry) => entry.userId)
    : socialStore.state.conversationParticipants.filter((entry) => entry.conversationId === targetConversationId && !entry.leftAt).map((entry) => entry.userId);
  for (const recipientId of recipients) {
    if (recipientId !== userId && await isBlocked(userId, recipientId)) return res.status(403).json({ message: 'You cannot forward messages to a blocked user.' });
  }
  const expiresAt = target.disappearingAfterSeconds && target.disappearingAfterSeconds > 0
    ? new Date(Date.now() + target.disappearingAfterSeconds * 1000)
    : null;
  const forwarded = dbAvailable
    ? await prisma.message.create({ data: {
      conversationId: targetConversationId,
      senderId: userId,
      text: source.text,
      contentType: source.contentType,
      mediaUrl: source.mediaUrl,
      metadata: (source.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      forwardedFromId: source.id,
      expiresAt: expiresAt ?? undefined,
      receipts: { create: recipients.filter((recipientId) => recipientId !== userId).map((recipientId) => ({ recipientId })) },
    }, include: { receipts: { include: { recipient: { select: { readReceiptsEnabled: true } } } } } })
    : {
      id: `message_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      conversationId: targetConversationId,
      senderId: userId,
      text: source.text,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      readAt: null,
      deletedAt: null,
      moderationHiddenAt: null,
      status: 'SENT' as const,
      contentType: source.contentType ?? 'TEXT',
      mediaUrl: source.mediaUrl ?? null,
      metadata: source.metadata ?? null,
      replyToId: null,
      forwardedFromId: source.id,
      editedAt: null,
      expiresAt: expiresAt?.toISOString() ?? null,
    };
    if (!dbAvailable) {
      socialStore.state.messages.push(forwarded as MessageRecord);
      socialStore.state.messageReceipts.push(...recipients.filter((recipientId) => recipientId !== userId).map((recipientId) => ({
        id: `receipt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        messageId: forwarded.id,
        recipientId,
        deliveredAt: null,
        readAt: null,
      })));
    }
  const preview = forwarded.text || `[${forwarded.contentType.toLowerCase()}]`;
  if (dbAvailable) await prisma.conversation.update({ where: { id: targetConversationId }, data: { lastMessageAt: forwarded.createdAt, lastMessagePreview: preview } });
  else {
    const targetConversationRecord = socialStore.state.conversations.find((entry) => entry.id === targetConversationId);
    if (targetConversationRecord) {
      targetConversationRecord.updatedAt = forwarded.updatedAt instanceof Date ? forwarded.updatedAt.toISOString() : forwarded.updatedAt;
      targetConversationRecord.lastMessageAt = forwarded.createdAt instanceof Date ? forwarded.createdAt.toISOString() : forwarded.createdAt;
      targetConversationRecord.lastMessagePreview = preview;
    }
  }
  emitConversationEvent('message:new', targetConversationId, { message: messageToPublicShape(forwarded), senderId: userId }, [userId, ...recipients]);
  return res.status(201).json({ message: messageToPublicShape(dbAvailable ? forwarded : {
    ...forwarded,
    receipts: socialStore.state.messageReceipts.filter((receipt) => receipt.messageId === forwarded.id).map((receipt) => ({
      ...receipt,
      recipient: { readReceiptsEnabled: socialStore.state.messagingPreferences[receipt.recipientId]?.readReceiptsEnabled ?? true },
    })),
  }, userId) });
});

messagesRouter.post('/messages/:id/reactions', requireAuth, async (req, res) => {
  const messageId = String(req.params.id);
  const { type } = reactionSchema.parse(req.body ?? {});
  const userId = req.user!.id;
  const dbAvailable = await isDatabaseAvailable();
  const message = dbAvailable
    ? await prisma.message.findUnique({ where: { id: messageId }, include: { reactions: true } })
    : socialStore.state.messages.find((entry) => entry.id === messageId);
  if (!message || message.deletedAt || message.moderationHiddenAt) return res.status(404).json({ message: 'Message not found.' });
  if (!(await canViewConversation(message.conversationId, userId))) return res.status(403).json({ message: 'You do not have access to this message.' });
  if (dbAvailable) {
    const existing = await prisma.messageReaction.findUnique({ where: { messageId_userId_type: { messageId, userId, type } } });
    if (existing) await prisma.messageReaction.delete({ where: { id: existing.id } });
    else await prisma.messageReaction.create({ data: { messageId, userId, type } });
    const reactions = await prisma.messageReaction.findMany({ where: { messageId } });
    emitConversationEvent('message:new', message.conversationId, { messageId, reactions }, await listConversationParticipantIds(message.conversationId));
    return res.json({ reactions, active: !existing });
  }
  const index = socialStore.state.messageReactions.findIndex((entry) => entry.messageId === messageId && entry.userId === userId && entry.type === type);
  if (index >= 0) socialStore.state.messageReactions.splice(index, 1);
  else socialStore.state.messageReactions.push({ id: `reaction_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, messageId, userId, type, createdAt: new Date().toISOString() });
  const reactions = socialStore.state.messageReactions.filter((entry) => entry.messageId === messageId);
  emitConversationEvent('message:new', message.conversationId, { messageId, reactions }, await listConversationParticipantIds(message.conversationId));
  return res.json({ reactions, active: index < 0 });
});

messagesRouter.patch('/messages/:id/preferences', requireAuth, async (req, res) => {
  const messageId = String(req.params.id);
  const userId = req.user!.id;
  const payload = messagePreferenceSchema.parse(req.body ?? {});
  const dbAvailable = await isDatabaseAvailable();
  const current = dbAvailable
    ? await prisma.message.findUnique({ where: { id: messageId }, select: { id: true, conversationId: true, deletedAt: true, moderationHiddenAt: true } })
    : socialStore.state.messages.find((message) => message.id === messageId);
  if (!current || current.deletedAt || current.moderationHiddenAt) return res.status(404).json({ message: 'Message not found.' });
  if (!(await canViewConversation(current.conversationId, userId))) return res.status(403).json({ message: 'You do not have access to this message.' });

  if (dbAvailable) {
    if (payload.pinned !== undefined) {
      await prisma.message.update({ where: { id: messageId }, data: { pinnedAt: payload.pinned ? new Date() : null } });
    }
    if (payload.starred === true) {
      await prisma.messagePreference.upsert({
        where: { messageId_userId: { messageId, userId } },
        create: { messageId, userId, starredAt: new Date() },
        update: { starredAt: new Date() },
      });
    } else if (payload.starred === false) {
      await prisma.messagePreference.deleteMany({ where: { messageId, userId } });
    }
    const updated = await prisma.message.findUnique({
      where: { id: messageId },
      include: { reactions: true, preferences: { where: { userId }, select: { starredAt: true } } },
    });
    if (!updated) return res.status(404).json({ message: 'Message not found.' });
    if (payload.pinned !== undefined) {
      emitConversationEvent('message:pinned', current.conversationId, { messageId, pinnedAt: updated.pinnedAt }, await listConversationParticipantIds(current.conversationId));
    }
    return res.json({ message: messageToPublicShape(updated) });
  }

  const message = socialStore.state.messages.find((entry) => entry.id === messageId)!;
  if (payload.pinned !== undefined) {
    message.pinnedAt = payload.pinned ? new Date().toISOString() : null;
    emitConversationEvent('message:pinned', current.conversationId, { messageId, pinnedAt: message.pinnedAt }, await listConversationParticipantIds(current.conversationId));
  }
  const preferenceIndex = socialStore.state.messagePreferences.findIndex((preference) => preference.messageId === messageId && preference.userId === userId);
  if (payload.starred === true) {
    const existing = socialStore.state.messagePreferences[preferenceIndex];
    if (existing) existing.starredAt = new Date().toISOString();
    else socialStore.state.messagePreferences.push({
      id: `message_preference_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      messageId,
      userId,
      starredAt: new Date().toISOString(),
    });
  } else if (payload.starred === false && preferenceIndex >= 0) {
    socialStore.state.messagePreferences.splice(preferenceIndex, 1);
  }
  const preferences = socialStore.state.messagePreferences.filter((preference) => preference.messageId === messageId && preference.userId === userId);
  return res.json({ message: messageToPublicShape({ ...message, preferences }) });
});

messagesRouter.get('/messages/search', requireAuth, async (req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const conversationId = typeof req.query.conversationId === 'string' ? req.query.conversationId : undefined;
  if (query.length < 2 || query.length > 100) return res.status(400).json({ message: 'Search query must be 2 to 100 characters.' });
  const dbAvailable = await isDatabaseAvailable();
  if (conversationId && !(await canViewConversation(conversationId, req.user!.id))) return res.status(403).json({ message: 'You do not have access to this conversation.' });
  if (dbAvailable) {
    const messages = await prisma.message.findMany({
      where: {
        deletedAt: null,
        moderationHiddenAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        text: { contains: query, mode: 'insensitive' },
        ...(conversationId ? { conversationId } : { conversation: { participants: { some: { userId: req.user!.id } } } }),
      },
      include: { reactions: true, preferences: { where: { userId: req.user!.id }, select: { starredAt: true } } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return res.json({ messages: messages.map((message) => messageToPublicShape(message, req.user!.id)) });
  }
  const allowedConversationIds = new Set(socialStore.state.conversationParticipants.filter((entry) => entry.userId === req.user!.id).map((entry) => entry.conversationId));
  const messages = socialStore.state.messages.filter((message) =>
    message.text.toLowerCase().includes(query.toLowerCase()) && !message.deletedAt && !message.moderationHiddenAt &&
    (!message.expiresAt || new Date(message.expiresAt).getTime() > Date.now()) &&
    (conversationId ? message.conversationId === conversationId : allowedConversationIds.has(message.conversationId)))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 50);
  return res.json({ messages: messages.map((message) => messageToPublicShape({
    ...message,
    preferences: socialStore.state.messagePreferences.filter((preference) => preference.messageId === message.id && preference.userId === req.user!.id),
  })) });
});

messagesRouter.get('/conversations/:id/media', requireAuth, async (req, res) => {
  const conversationId = String(req.params.id);
  if (!(await canViewConversation(conversationId, req.user!.id))) return res.status(403).json({ message: 'You do not have access to this conversation.' });
  const dbAvailable = await isDatabaseAvailable();
  const allowedTypes = ['IMAGE', 'VIDEO', 'DOCUMENT', 'VOICE', 'GIF', 'STICKER'];
  const media = dbAvailable
    ? await prisma.message.findMany({ where: { conversationId, contentType: { in: allowedTypes }, deletedAt: null, moderationHiddenAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, include: { reactions: true, preferences: { where: { userId: req.user!.id }, select: { starredAt: true } } }, orderBy: { createdAt: 'desc' }, take: 200 })
    : socialStore.state.messages.filter((entry) => entry.conversationId === conversationId && allowedTypes.includes(entry.contentType ?? 'TEXT') && !entry.deletedAt && !entry.moderationHiddenAt && (!entry.expiresAt || new Date(entry.expiresAt).getTime() > Date.now())).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 200);
  return res.json({ media: media.map((message) => messageToPublicShape(dbAvailable ? message : {
    ...message,
    preferences: socialStore.state.messagePreferences.filter((preference) => preference.messageId === message.id && preference.userId === req.user!.id),
  })) });
});

messagesRouter.post('/messages/:id/report', requireAuth, async (req, res) => {
  const messageId = String(req.params.id);
  const payload = reportSchema.parse(req.body ?? {});
  const dbAvailable = await isDatabaseAvailable();
  const message = dbAvailable
    ? await prisma.message.findUnique({ where: { id: messageId }, select: { id: true, conversationId: true, senderId: true } })
    : socialStore.state.messages.find((entry) => entry.id === messageId);
  if (!message) return res.status(404).json({ message: 'Message not found.' });
  if (!(await canViewConversation(message.conversationId, req.user!.id))) return res.status(403).json({ message: 'You do not have access to this message.' });
  if (message.senderId === req.user!.id) return res.status(400).json({ message: 'You cannot report your own message.' });
  const details = `Message report: ${messageId} in ${message.conversationId}\n\n${payload.reason}`;
  if (dbAvailable) {
    const report = await prisma.report.create({ data: { reporterId: req.user!.id, targetUserId: message.senderId, messageId, category: payload.category, details } });
    return res.status(201).json({ report, message: 'Report submitted.' });
  }
  const report = { id: `report_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, reporterId: req.user!.id, targetType: 'message' as const, targetId: messageId, messageId, category: payload.category, reason: details, createdAt: new Date().toISOString() };
  socialStore.state.reports.push(report);
  return res.status(201).json({ report, message: 'Report submitted.' });
});

messagesRouter.patch('/conversations/:id/preferences', requireAuth, async (req, res) => {
  const conversationId = String(req.params.id);
  const payload = conversationPreferenceSchema.parse(req.body ?? {});
  const userId = req.user!.id;
  if (!(await canViewConversation(conversationId, userId))) return res.status(403).json({ message: 'You do not have access to this conversation.' });
  const dbAvailable = await isDatabaseAvailable();
  if (dbAvailable) {
    const [participant, conversation] = await Promise.all([
      prisma.conversationParticipant.findUnique({ where: { conversationId_userId: { conversationId, userId } } }),
      payload.disappearingAfterSeconds === undefined ? null : prisma.conversation.findUnique({ where: { id: conversationId }, select: { ownerId: true } }),
    ]);
    if (!participant) return res.status(404).json({ message: 'Conversation membership not found.' });
    if (conversation && conversation.ownerId !== userId && participant.role !== 'MODERATOR') return res.status(403).json({ message: 'Only group admins can change disappearing-message settings.' });
    const updated = await prisma.conversationParticipant.update({
      where: { conversationId_userId: { conversationId, userId } },
      data: {
        ...(payload.pinned === undefined ? {} : { pinnedAt: payload.pinned ? new Date() : null }),
        ...(payload.archived === undefined ? {} : { archivedAt: payload.archived ? new Date() : null }),
        ...(payload.starred === undefined ? {} : { starredAt: payload.starred ? new Date() : null }),
        ...(payload.mutedUntil === undefined ? {} : { mutedUntil: payload.mutedUntil ? new Date(payload.mutedUntil) : null }),
      },
    });
    if (payload.disappearingAfterSeconds !== undefined) await prisma.conversation.update({ where: { id: conversationId }, data: { disappearingAfterSeconds: payload.disappearingAfterSeconds } });
    return res.json({ preferences: updated, disappearingAfterSeconds: payload.disappearingAfterSeconds });
  }
  const participant = socialStore.state.conversationParticipants.find((entry) => entry.conversationId === conversationId && entry.userId === userId);
  const conversation = socialStore.state.conversations.find((entry) => entry.id === conversationId);
  if (!participant || !conversation) return res.status(404).json({ message: 'Conversation membership not found.' });
  if (payload.disappearingAfterSeconds !== undefined && participant.role !== 'OWNER' && participant.role !== 'MODERATOR') return res.status(403).json({ message: 'Only group admins can change disappearing-message settings.' });
  if (payload.pinned !== undefined) participant.pinnedAt = payload.pinned ? new Date().toISOString() : null;
  if (payload.archived !== undefined) participant.archivedAt = payload.archived ? new Date().toISOString() : null;
  if (payload.starred !== undefined) participant.starredAt = payload.starred ? new Date().toISOString() : null;
  if (payload.mutedUntil !== undefined) participant.mutedUntil = payload.mutedUntil;
  if (payload.disappearingAfterSeconds !== undefined) conversation.disappearingAfterSeconds = payload.disappearingAfterSeconds;
  return res.json({ preferences: participant, disappearingAfterSeconds: conversation.disappearingAfterSeconds });
});

messagesRouter.post('/conversations/:id/participants', requireAuth, async (req, res) => {
  const conversationId = String(req.params.id);
  const validation = addParticipantSchema.safeParse(req.body ?? {});
if (!validation.success) {
return res.status(400).json({ message: validation.error.issues[0]?.message ?? "Invalid participants." });
}
const { participantIds } = validation.data;
  const userId = req.user!.id;
  const dbAvailable = await isDatabaseAvailable();
  if (dbAvailable) {
    const actor = await prisma.conversationParticipant.findFirst({ where: { conversationId, userId, leftAt: null }, select: { role: true } });
    const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { id: true, ownerId: true, isGroup: true, isChannel: true } });
    if (!actor || !conversation) return res.status(404).json({ message: 'Conversation not found.' });
    if (!conversation.isGroup && !conversation.isChannel) return res.status(400).json({ message: 'Members can only be added to group conversations.' });
    const isOwner = actor.role === 'OWNER' || isConversationOwner(conversation, userId);
    const canAddParticipants = conversation.isChannel ? isOwner : canManageGroupMembers(conversation, actor, userId);
    if (!canAddParticipants) return res.status(403).json({ message: conversation.isChannel ? 'Only channel owners can add participants.' : 'Only group admins can add participants.' });
    const found = await prisma.user.findMany({ where: { id: { in: participantIds } }, select: { id: true } });
    if (found.length !== participantIds.length) return res.status(404).json({ message: 'User not found.' });
    const currentParticipants = await prisma.conversationParticipant.findMany({ where: { conversationId, userId: { in: participantIds } }, select: { id: true, userId: true, leftAt: true } });
    const newParticipantIds = participantIds.filter((targetId) => !currentParticipants.some((participant) => participant.userId === targetId && participant.leftAt === null));
    for (const targetId of newParticipantIds) if (await isBlocked(userId, targetId)) return res.status(403).json({ message: 'You cannot add a blocked user.' });
    const rejoining = currentParticipants.filter((participant) => participant.leftAt !== null && newParticipantIds.includes(participant.userId));
    for (const participant of rejoining) {
      await prisma.conversationParticipant.update({ where: { id: participant.id }, data: { leftAt: null, role: 'MEMBER', joinedAt: new Date() } });
    }
    const newMemberships = newParticipantIds.filter((targetId) => !rejoining.some((participant) => participant.userId === targetId));
    if (newMemberships.length) await prisma.conversationParticipant.createMany({ data: newMemberships.map((targetId) => ({ conversationId, userId: targetId, role: 'MEMBER' })), skipDuplicates: true });
    return res.status(201).json({ added: newParticipantIds });
  }
  const actor = socialStore.state.conversationParticipants.find((entry) => entry.conversationId === conversationId && entry.userId === userId && !entry.leftAt);
  const conversation = socialStore.state.conversations.find((entry) => entry.id === conversationId);
  if (!actor || !conversation) return res.status(404).json({ message: 'Conversation not found.' });
  if (!conversation.isGroup && !conversation.isChannel) return res.status(400).json({ message: 'Members can only be added to group conversations.' });
  const isOwner = actor.role === 'OWNER' || isConversationOwner(conversation, userId);
  const canAddParticipants = conversation.isChannel ? isOwner : canManageGroupMembers(conversation, actor, userId);
  if (!canAddParticipants) return res.status(403).json({ message: conversation.isChannel ? 'Only channel owners can add participants.' : 'Only group admins can add participants.' });
  for (const targetId of participantIds) if (!findUserById(targetId)) return res.status(404).json({ message: 'User not found.' });
  const newParticipantIds = participantIds.filter((targetId) => !socialStore.state.conversationParticipants.some((entry) => entry.conversationId === conversationId && entry.userId === targetId && !entry.leftAt));
  for (const targetId of newParticipantIds) if (await isBlocked(userId, targetId)) return res.status(403).json({ message: 'You cannot add a blocked user.' });
  for (const targetId of newParticipantIds) {
    const former = socialStore.state.conversationParticipants.find((entry) => entry.conversationId === conversationId && entry.userId === targetId);
    if (former) Object.assign(former, { role: 'MEMBER', joinedAt: new Date().toISOString(), leftAt: null });
    else socialStore.state.conversationParticipants.push({ id: `participant_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, conversationId, userId: targetId, role: 'MEMBER', joinedAt: new Date().toISOString(), lastReadAt: null, leftAt: null });
  }
  return res.status(201).json({ added: newParticipantIds });
});

messagesRouter.patch('/conversations/:id/group', requireAuth, async (req, res) => {
  const conversationId = String(req.params.id);
  const validation = groupDetailsSchema.safeParse(req.body ?? {});
  if (!validation.success) return res.status(400).json({ message: validation.error.issues[0]?.message ?? 'Invalid group details.' });

  const userId = req.user!.id;
  const dbAvailable = await isDatabaseAvailable();
  const conversation = dbAvailable
    ? await prisma.conversation.findUnique({ where: { id: conversationId }, select: { id: true, ownerId: true, isGroup: true, isChannel: true } })
    : socialStore.state.conversations.find((entry) => entry.id === conversationId);
  const actor = dbAvailable
    ? await prisma.conversationParticipant.findFirst({ where: { conversationId, userId, leftAt: null }, select: { role: true } })
    : socialStore.state.conversationParticipants.find((entry) => entry.conversationId === conversationId && entry.userId === userId && !entry.leftAt);

  if (!conversation || !actor) return res.status(404).json({ message: 'Group conversation not found.' });
  if (!conversation.isGroup || conversation.isChannel) return res.status(400).json({ message: 'Only group conversations have group profile settings.' });
  if (!canManageGroupMembers(conversation, actor, userId)) return res.status(403).json({ message: 'Only group admins can update group settings.' });

  const { name, description, imageUrl } = validation.data;
  if (imageUrl && !(await uploadedMediaBelongsTo(imageUrl, userId, process.env.NODE_ENV ?? 'development'))) {
    return res.status(403).json({ message: 'You can only use images that you uploaded.' });
  }
  const updates = {
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(imageUrl === undefined ? {} : { imageUrl: imageUrl || null }),
  };
  if (dbAvailable) {
    const updated = await prisma.conversation.update({ where: { id: conversationId }, data: updates });
    return res.json({ group: { id: updated.id, name: updated.name, description: updated.description, imageUrl: updated.imageUrl } });
  }
  const updated = Object.assign(conversation, updates, { updatedAt: new Date().toISOString() });
  return res.json({ group: { id: updated.id, name: updated.name, description: updated.description ?? null, imageUrl: updated.imageUrl ?? null } });
});

messagesRouter.patch('/conversations/:id/participants/:userId', requireAuth, async (req, res) => {
  const conversationId = String(req.params.id);
  const targetId = String(req.params.userId);
  const { role } = roleSchema.parse(req.body ?? {});
  const dbAvailable = await isDatabaseAvailable();
  const conversation = dbAvailable
    ? await prisma.conversation.findUnique({ where: { id: conversationId }, select: { ownerId: true, isGroup: true, isChannel: true } })
    : socialStore.state.conversations.find((entry) => entry.id === conversationId);
  const actor = dbAvailable
    ? await prisma.conversationParticipant.findFirst({ where: { conversationId, userId: req.user!.id, leftAt: null }, select: { role: true } })
    : socialStore.state.conversationParticipants.find((entry) => entry.conversationId === conversationId && entry.userId === req.user!.id && !entry.leftAt);
  const target = dbAvailable
    ? await prisma.conversationParticipant.findFirst({ where: { conversationId, userId: targetId, leftAt: null } })
    : socialStore.state.conversationParticipants.find((entry) => entry.conversationId === conversationId && entry.userId === targetId && !entry.leftAt);
  if (!conversation || !actor || !target) return res.status(404).json({ message: 'Conversation member not found.' });
  if (!conversation.isGroup && !conversation.isChannel) return res.status(400).json({ message: 'Roles can only be changed in group conversations.' });
  const isOwner = actor.role === 'OWNER' || isConversationOwner(conversation, req.user!.id);
  const canManageRoles = conversation.isChannel ? isOwner : canManageGroupMembers(conversation, actor, req.user!.id);
  if (!canManageRoles) return res.status(403).json({ message: conversation.isChannel ? 'Only channel owners can change member roles.' : 'Only group admins can change member roles.' });
  if (target.role === 'OWNER' || isConversationOwner(conversation, targetId)) return res.status(409).json({ message: 'The owner role cannot be changed.' });
  if (dbAvailable) return res.json({ participant: await prisma.conversationParticipant.update({ where: { conversationId_userId: { conversationId, userId: targetId } }, data: { role } }) });
  target.role = role;
  return res.json({ participant: target });
});

messagesRouter.delete('/conversations/:id/participants/:userId', requireAuth, async (req, res) => {
  const conversationId = String(req.params.id);
  const targetId = String(req.params.userId);
  const userId = req.user!.id;
  const dbAvailable = await isDatabaseAvailable();
  const actor = dbAvailable
    ? await prisma.conversationParticipant.findFirst({ where: { conversationId, userId, leftAt: null }, select: { role: true } })
    : socialStore.state.conversationParticipants.find((entry) => entry.conversationId === conversationId && entry.userId === userId && !entry.leftAt);
  const target = dbAvailable
    ? await prisma.conversationParticipant.findFirst({ where: { conversationId, userId: targetId, leftAt: null } })
    : socialStore.state.conversationParticipants.find((entry) => entry.conversationId === conversationId && entry.userId === targetId);
  const conversation = dbAvailable
    ? await prisma.conversation.findUnique({ where: { id: conversationId }, select: { ownerId: true } })
    : socialStore.state.conversations.find((entry) => entry.id === conversationId);
  if (!actor || !target || !conversation) return res.status(404).json({ message: 'Conversation member not found.' });
  const selfLeave = targetId === userId;
  if (!selfLeave && actor.role !== 'OWNER' && actor.role !== 'MODERATOR') return res.status(403).json({ message: 'Only group admins can remove members.' });
  if (target.role === 'OWNER' || isConversationOwner(conversation, targetId)) return res.status(409).json({ message: 'The owner cannot leave or be removed before transferring ownership.' });
  if (dbAvailable) await prisma.conversationParticipant.delete({ where: { conversationId_userId: { conversationId, userId: targetId } } });
  else socialStore.state.conversationParticipants.splice(socialStore.state.conversationParticipants.findIndex((participant) => participant.id === target.id), 1);
  return res.json({ removed: targetId });
});

export default messagesRouter;

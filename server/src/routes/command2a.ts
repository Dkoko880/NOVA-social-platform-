import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireActiveAccountIfAuthenticated } from '../middleware/auth.js';
import { createAiProvider, createCallSession, createLiveSession, createNotification, getCallSession, getLiveSession, getNotificationPreferences, listCallHistory, listLiveSessions, markAllNotificationsRead, markNotificationRead, setNotificationPreferences, setPresence, setTypingState, updateCallSession, updateLiveSession } from '../lib/platform.js';
import { socialStore } from '../lib/socialStore.js';
import { findUserById } from '../lib/fallbackStore.js';
import { prisma, isDatabaseAvailable } from '../lib/prisma.js';
import { reviewContentForSafety } from '../lib/moderation.js';

const command2aRouter = Router();
command2aRouter.use(requireActiveAccountIfAuthenticated);

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
  targetUserIds: z.array(z.string().min(1)).min(1).max(49).optional(),
  conversationId: z.string().min(1).optional(),
  type: z.enum(['voice', 'video']).default('voice'),
});
const callControlSchema = z.object({ muted: z.boolean().optional(), cameraOn: z.boolean().optional(), speakerOn: z.boolean().optional() });

const liveCreateSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).optional(),
  visibility: z.enum(['public', 'private']).default('public'),
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
const liveViewerControlSchema = z.object({ isMuted: z.boolean() });

async function canViewConversation(conversationId: string, userId: string) {
  const dbAvailable = await isDatabaseAvailable();
  if (dbAvailable) {
    const participant = await prisma.conversationParticipant.findFirst({ where: { conversationId, userId }, select: { id: true } });
    return Boolean(participant);
  }
  return socialStore.state.conversationParticipants.some((participant) => participant.conversationId === conversationId && participant.userId === userId);
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
  return res.json({ preferences: getNotificationPreferences(req.user!.id) });
});

command2aRouter.put('/notifications/preferences', requireAuth, async (req, res) => {
  const payload = notificationPreferenceSchema.parse(req.body ?? {});
  const next = setNotificationPreferences(req.user!.id, { [payload.key]: { enabled: payload.enabled, channel: payload.channel } });
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
  const payload = callSchema.parse(req.body ?? {});
  const callerId = req.user!.id;
  const targetSources = Number(Boolean(payload.targetUserId)) + Number(Boolean(payload.targetUserIds)) + Number(Boolean(payload.conversationId));
  if (targetSources !== 1) return res.status(400).json({ message: 'Provide one user, a user list, or a conversation.' });
  let targetIds = payload.targetUserIds ?? (payload.targetUserId ? [payload.targetUserId] : []);
  if (payload.conversationId) {
    if (!(await canViewConversation(payload.conversationId, callerId))) return res.status(403).json({ message: 'You do not have access to this conversation.' });
    targetIds = await (async () => await isDatabaseAvailable()
      ? (await prisma.conversationParticipant.findMany({ where: { conversationId: payload.conversationId }, select: { userId: true } })).map((participant) => participant.userId)
      : socialStore.state.conversationParticipants.filter((participant) => participant.conversationId === payload.conversationId).map((participant) => participant.userId))();
  }
  targetIds = [...new Set(targetIds)].filter((targetId) => targetId !== callerId);
  if (!targetIds.length || targetIds.length > 49) return res.status(400).json({ message: 'A call must include at least one other participant and no more than 50 people.' });

  const targetUsers: Array<{ id: string; name: string }> = [];
  for (const targetId of targetIds) {
    if (await isBlocked(callerId, targetId)) return res.status(403).json({ message: 'You cannot call a user who has blocked you or who you have blocked.' });
    const target = await (async () => await isDatabaseAvailable()
      ? prisma.user.findUnique({ where: { id: targetId }, select: { id: true, name: true } })
      : findUserById(targetId))();
    if (!target) return res.status(404).json({ message: 'User not found.' });
    targetUsers.push(target);
  }

  const participants = [
    { userId: callerId, status: 'connected' as const, muted: false, cameraOn: payload.type === 'video', speakerOn: true },
    ...targetIds.map((userId) => ({ userId, status: 'pending' as const, muted: false, cameraOn: payload.type === 'video', speakerOn: true })),
  ];
  const call = createCallSession({ callerId, targetUserId: targetIds.length === 1 ? targetIds[0] : null, type: payload.type, participants });
  await Promise.all(targetUsers.map((target) => createNotification(target.id, callerId, 'call', `${req.user!.name} started a ${payload.type} call.`)));
  return res.json({ call, message: 'Call started.' });
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

command2aRouter.post('/calls/:id/accept', requireAuth, async (req, res) => {
  const call = getCallSession(String(req.params.id));
  if (!call) {
    return res.status(404).json({ message: 'Call not found.' });
  }
  if (!isCallParticipant(call, req.user!.id)) {
    return res.status(403).json({ message: 'You do not have access to this call.' });
  }

  const next = updateCallSession(call.id, { status: 'connected' }, [
    { userId: req.user!.id, status: 'connected' },
  ]);
  return res.json({ call: next, message: 'Call accepted.' });
});

command2aRouter.post('/calls/:id/reject', requireAuth, async (req, res) => {
  const call = getCallSession(String(req.params.id));
  if (!call) {
    return res.status(404).json({ message: 'Call not found.' });
  }
  if (!isCallParticipant(call, req.user!.id)) {
    return res.status(403).json({ message: 'You do not have access to this call.' });
  }
  const allOthersLeft = call.participants.every((participant) => participant.userId === req.user!.id || participant.status === 'left');
  const next = updateCallSession(call.id, allOthersLeft ? { status: 'rejected' } : {}, [{ userId: req.user!.id, status: 'left' }]);
  return res.json({ call: next, message: allOthersLeft ? 'Call rejected.' : 'Call declined.' });
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
  const allOthersLeft = call.participants.every((participant) => participant.userId === req.user!.id || participant.status === 'left');
  const next = updateCallSession(call.id, allOthersLeft ? { status: 'ended' } : {}, [{ userId: req.user!.id, status: 'left' }]);
  return res.json({ call: next, message: allOthersLeft ? 'Call ended.' : 'You left the call.' });
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
  const live = createLiveSession({ hostId: req.user!.id, title: payload.title, description: payload.description, visibility: payload.visibility });
  return res.status(201).json({ live, message: 'Live session created.' });
});

command2aRouter.get('/live', requireAuth, async (req, res) => {
  const lives = listLiveSessions().filter((live) => live.visibility === 'public' || canManageLive(live, req.user!.id) || live.viewers.some((viewer) => viewer.userId === req.user!.id));
  return res.json({ lives });
});

command2aRouter.get('/live/:id', requireAuth, async (req, res) => {
  const live = getLiveSession(String(req.params.id));
  if (!live) {
    return res.status(404).json({ message: 'Live session not found.' });
  }
  if (live.visibility === 'private' && !canManageLive(live, req.user!.id) && !live.viewers.some((viewer) => viewer.userId === req.user!.id)) {
    return res.status(404).json({ message: 'Live session not found.' });
  }
  return res.json({ live });
});

command2aRouter.post('/live/:id/start', requireAuth, async (req, res) => {
  const live = getLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (live.hostId !== req.user!.id) return res.status(403).json({ message: 'Only the host can start this live session.' });
  const next = updateLiveSession(live.id, (session) => ({ ...session, status: 'live', viewerCount: Math.max(0, session.viewerCount) }));
  return res.json({ live: next, message: 'Live session started.' });
});

command2aRouter.post('/live/:id/end', requireAuth, async (req, res) => {
  const live = getLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (live.hostId !== req.user!.id) return res.status(403).json({ message: 'Only the host can end this live session.' });
  const next = updateLiveSession(live.id, (session) => ({ ...session, status: 'ended' }));
  return res.json({ live: next, message: 'Live session ended.' });
});

command2aRouter.post('/live/:id/comment', requireAuth, async (req, res) => {
  const live = getLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (live.status !== 'live') return res.status(409).json({ message: 'Comments are available while the live session is running.' });
  if (await isBlocked(req.user!.id, live.hostId)) return res.status(403).json({ message: 'You cannot interact with this live session.' });
  const payload = liveCommentSchema.parse(req.body ?? {});
  const moderation = reviewContentForSafety({ type: 'comment', text: payload.text, userId: req.user!.id });
  if (moderation === 'REMOVE') return res.status(400).json({ message: 'This comment violates NOVA Community & Safety Rules.' });
  if (moderation === 'REVIEW') return res.status(422).json({ message: 'This comment requires moderator review.' });
  const next = updateLiveSession(live.id, (session) => ({
    ...session,
    comments: [...session.comments, { id: `live_comment_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, userId: req.user!.id, text: payload.text, createdAt: new Date().toISOString() }],
  }));
  return res.status(201).json({ comment: next!.comments[next!.comments.length - 1] });
});

command2aRouter.post('/live/:id/react', requireAuth, async (req, res) => {
  const live = getLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (live.status !== 'live') return res.status(409).json({ message: 'Reactions are available while the live session is running.' });
  const payload = liveReactionSchema.parse(req.body ?? {});
  const next = updateLiveSession(live.id, (session) => ({
    ...session,
    reactions: [...session.reactions, { id: `live_reaction_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, userId: req.user!.id, type: payload.type, createdAt: new Date().toISOString() }],
  }));
  return res.status(201).json({ reaction: next!.reactions[next!.reactions.length - 1] });
});

command2aRouter.post('/live/:id/viewer/:userId/remove', requireAuth, async (req, res) => {
  const live = getLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (!canManageLive(live, req.user!.id)) {
    return res.status(403).json({ message: 'Only the host or moderator can remove viewers.' });
  }
  const viewerId = String(req.params.userId);
  const next = updateLiveSession(live.id, (session) => ({
    ...session,
    viewers: session.viewers.filter((viewer) => viewer.userId !== viewerId),
    viewerCount: session.viewers.some((viewer) => viewer.userId === viewerId) ? Math.max(0, session.viewerCount - 1) : session.viewerCount,
  }));
  return res.json({ live: next, message: 'Viewer removed.' });
});

command2aRouter.post('/live/:id/viewer/:userId/mute', requireAuth, async (req, res) => {
  const live = getLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (!canManageLive(live, req.user!.id)) return res.status(403).json({ message: 'Only the host or a moderator can mute viewers.' });
  const userId = String(req.params.userId);
  const payload = liveViewerControlSchema.parse(req.body ?? {});
  if (!live.viewers.some((viewer) => viewer.userId === userId)) return res.status(404).json({ message: 'Viewer not found.' });
  const next = updateLiveSession(live.id, (session) => ({ ...session, viewers: session.viewers.map((viewer) => viewer.userId === userId ? { ...viewer, isMuted: payload.isMuted } : viewer) }));
  return res.json({ live: next, viewer: next?.viewers.find((viewer) => viewer.userId === userId) });
});

command2aRouter.post('/live/:id/comments/:commentId/remove', requireAuth, async (req, res) => {
  const live = getLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (!canManageLive(live, req.user!.id)) return res.status(403).json({ message: 'Only the host or a moderator can remove comments.' });
  const commentId = String(req.params.commentId);
  if (!live.comments.some((comment) => comment.id === commentId)) return res.status(404).json({ message: 'Comment not found.' });
  const next = updateLiveSession(live.id, (session) => ({ ...session, comments: session.comments.filter((comment) => comment.id !== commentId) }));
  return res.json({ live: next, removed: commentId });
});

command2aRouter.post('/live/:id/moderators/:userId/add', requireAuth, async (req, res) => {
  const live = getLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (live.hostId !== req.user!.id) return res.status(403).json({ message: 'Only the host can assign moderators.' });
  const next = updateLiveSession(live.id, (session) => ({
    ...session,
    moderators: Array.from(new Set([...session.moderators, String(req.params.userId)])),
  }));
  return res.json({ live: next, message: 'Moderator added.' });
});

command2aRouter.post('/live/:id/moderators/:userId/remove', requireAuth, async (req, res) => {
  const live = getLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (live.hostId !== req.user!.id) return res.status(403).json({ message: 'Only the host can remove moderators.' });
  const userId = String(req.params.userId);
  const next = updateLiveSession(live.id, (session) => ({ ...session, moderators: session.moderators.filter((moderatorId) => moderatorId !== userId) }));
  return res.json({ live: next, message: 'Moderator removed.' });
});

command2aRouter.post('/live/:id/viewers/join', requireAuth, async (req, res) => {
  const live = getLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (live.status !== 'live') return res.status(409).json({ message: 'This live session is not running.' });
  if (live.visibility === 'private' && !canManageLive(live, req.user!.id)) return res.status(403).json({ message: 'This live session is private.' });
  if (await isBlocked(req.user!.id, live.hostId)) return res.status(403).json({ message: 'You cannot join this live session.' });
  const existing = live.viewers.find((viewer) => viewer.userId === req.user!.id);
  if (existing) return res.json({ viewer: existing, live });
  const viewer = { userId: req.user!.id, isMuted: false, isBlocked: false, joinedAt: new Date().toISOString() };
  const next = updateLiveSession(live.id, (session) => ({ ...session, viewers: [...session.viewers, viewer], viewerCount: session.viewers.length + 1 }));
  await createNotification(live.hostId, req.user!.id, 'live_viewer', `${req.user!.name} joined your live session.`);
  return res.status(201).json({ viewer, live: next });
});

command2aRouter.post('/live/:id/viewers/leave', requireAuth, async (req, res) => {
  const live = getLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  const wasViewer = live.viewers.some((viewer) => viewer.userId === req.user!.id);
  const next = updateLiveSession(live.id, (session) => ({
    ...session,
    viewers: session.viewers.filter((viewer) => viewer.userId !== req.user!.id),
    viewerCount: wasViewer ? Math.max(0, session.viewerCount - 1) : session.viewerCount,
  }));
  return res.json({ left: wasViewer, live: next });
});

command2aRouter.post('/live/:id/guests/request', requireAuth, async (req, res) => {
  const live = getLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (live.status !== 'live') return res.status(409).json({ message: 'Guest requests are available while the live session is running.' });
  if (live.hostId === req.user!.id) return res.status(400).json({ message: 'The host is already on stage.' });
  if (await isBlocked(req.user!.id, live.hostId)) return res.status(403).json({ message: 'You cannot request to join this live session.' });
  const payload = liveGuestSchema.parse(req.body ?? {});
  if (live.guests.some((guest) => guest.userId === req.user!.id && guest.status !== 'REMOVED')) return res.status(409).json({ message: 'A guest request already exists.' });
  const guest = { userId: req.user!.id, role: payload.role, status: 'REQUESTED' as const, requestedAt: new Date().toISOString() };
  const next = updateLiveSession(live.id, (session) => ({ ...session, guests: [...session.guests.filter((entry) => entry.userId !== req.user!.id), guest] }));
  await createNotification(live.hostId, req.user!.id, 'live_guest_request', `${req.user!.name} requested to join your live session.`);
  return res.status(201).json({ guest, live: next });
});

command2aRouter.post('/live/:id/guests/:userId/approve', requireAuth, async (req, res) => {
  const live = getLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (!canManageLive(live, req.user!.id)) return res.status(403).json({ message: 'Only the host or a moderator can approve guests.' });
  const userId = String(req.params.userId);
  const requested = live.guests.find((guest) => guest.userId === userId && guest.status === 'REQUESTED');
  if (!requested) return res.status(404).json({ message: 'Guest request not found.' });
  const next = updateLiveSession(live.id, (session) => ({
    ...session,
    guests: session.guests.map((guest) => guest.userId === userId ? { ...guest, status: 'LIVE' } : guest),
  }));
  return res.json({ guest: next!.guests.find((guest) => guest.userId === userId), live: next });
});

command2aRouter.post('/live/:id/guests/:userId/remove', requireAuth, async (req, res) => {
  const live = getLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (!canManageLive(live, req.user!.id)) return res.status(403).json({ message: 'Only the host or a moderator can remove guests.' });
  const userId = String(req.params.userId);
  const next = updateLiveSession(live.id, (session) => ({
    ...session,
    guests: session.guests.map((guest) => guest.userId === userId ? { ...guest, status: 'REMOVED' } : guest),
  }));
  return res.json({ live: next });
});

command2aRouter.post('/live/:id/follow', requireAuth, async (req, res) => {
  const live = getLiveSession(String(req.params.id));
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
  const live = getLiveSession(String(req.params.id));
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
  const live = getLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (!canManageLive(live, req.user!.id)) return res.status(403).json({ message: 'Only the host or a moderator can block viewers.' });
  const userId = String(req.params.userId);
  if (userId === live.hostId) return res.status(400).json({ message: 'The host cannot be blocked from their own session.' });
  if (await isDatabaseAvailable()) {
    const existing = await prisma.block.findUnique({ where: { blockerId_blockedId: { blockerId: req.user!.id, blockedId: userId } }, select: { id: true } });
    if (!existing) await prisma.block.create({ data: { blockerId: req.user!.id, blockedId: userId } });
  } else if (!socialStore.state.blocks.some((block) => block.blockerId === req.user!.id && block.blockedId === userId)) {
    socialStore.state.blocks.push({ id: `block_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, blockerId: req.user!.id, blockedId: userId, createdAt: new Date().toISOString() });
  }
  const next = updateLiveSession(live.id, (session) => ({
    ...session,
    viewers: session.viewers.filter((viewer) => viewer.userId !== userId),
    viewerCount: session.viewers.some((viewer) => viewer.userId === userId) ? Math.max(0, session.viewerCount - 1) : session.viewerCount,
    guests: session.guests.map((guest) => guest.userId === userId ? { ...guest, status: 'REMOVED' } : guest),
  }));
  return res.json({ blocked: true, live: next });
});

command2aRouter.post('/live/:id/recording/start', requireAuth, async (req, res) => {
  const live = getLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (!canManageLive(live, req.user!.id)) return res.status(403).json({ message: 'Only the host or a moderator can control recording.' });
  if (live.status !== 'live') return res.status(409).json({ message: 'Recording requires a running live session.' });
  if (live.recordingStatus === 'RECORDING') return res.status(409).json({ message: 'Recording is already active.' });
  const next = updateLiveSession(live.id, (session) => ({ ...session, recordingStatus: 'RECORDING' }));
  return res.json({ live: next, providerConfigured: live.providerConfigured });
});

command2aRouter.post('/live/:id/recording/stop', requireAuth, async (req, res) => {
  const live = getLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  if (!canManageLive(live, req.user!.id)) return res.status(403).json({ message: 'Only the host or a moderator can control recording.' });
  if (live.recordingStatus !== 'RECORDING') return res.status(409).json({ message: 'No recording is active.' });
  const next = updateLiveSession(live.id, (session) => ({ ...session, recordingStatus: session.providerConfigured ? 'READY' : 'UNAVAILABLE' }));
  return res.json({ live: next, replayReady: Boolean(next?.replayUrl) });
});

command2aRouter.post('/live/:id/share', requireAuth, async (req, res) => {
  const live = getLiveSession(String(req.params.id));
  if (!live) return res.status(404).json({ message: 'Live session not found.' });
  await createNotification(live.hostId, req.user!.id, 'live', `${req.user!.name} shared your live session.`);
  return res.json({ shared: true, live });
});

command2aRouter.post('/ai/summarize', async (req, res) => {
  const provider = createAiProvider();
  const content = typeof req.body?.content === 'string' ? req.body.content : '';
  const result = await provider.summarizeText(content);
  return res.json(result);
});

command2aRouter.post('/ai/translate', async (req, res) => {
  const provider = createAiProvider();
  const result = await provider.translateText(String(req.body?.text ?? ''), String(req.body?.language ?? 'en'));
  return res.json(result);
});

command2aRouter.post('/ai/speech-to-text', async (req, res) => {
  const provider = createAiProvider();
  const result = await provider.transcribeSpeech(String(req.body?.audioBase64 ?? ''));
  return res.json(result);
});

command2aRouter.post('/ai/smart-replies', async (req, res) => {
  const provider = createAiProvider();
  const result = await provider.generateSmartReply(String(req.body?.text ?? ''));
  return res.json(result);
});

command2aRouter.post('/ai/captions', async (req, res) => {
  const provider = createAiProvider();
  const result = await provider.generateCaptions(String(req.body?.text ?? ''));
  return res.json(result);
});

command2aRouter.post('/ai/moderate', async (req, res) => {
  const provider = createAiProvider();
  const result = await provider.moderateContent({ text: String(req.body?.text ?? ''), type: String(req.body?.type ?? 'content') });
  return res.json(result);
});

command2aRouter.post('/ai/spam-scam-detect', async (req, res) => {
  const provider = createAiProvider();
  const result = await provider.detectSpamScam({ text: String(req.body?.text ?? ''), source: String(req.body?.source ?? 'chat') });
  return res.json(result);
});

export { command2aRouter };

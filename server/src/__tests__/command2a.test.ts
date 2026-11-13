import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { TokenVerifier, TrackSource } from 'livekit-server-sdk';
import { app } from '../app.js';
import { fallbackStore } from '../lib/fallbackStore.js';
import { getLiveKitParticipants, removeLiveKitParticipant } from '../lib/livekit.js';
import { CALL_RING_TIMEOUT_MS, clearCommand2AStores, createCallSession, getCallSession, updateLiveSession } from '../lib/platform.js';
import { registerRealtimeConnection, subscribeToUserEvents } from '../lib/realtime.js';
import { socialStore } from '../lib/socialStore.js';

vi.mock('../lib/livekit.js', async (importOriginal) => {
  const livekit = await importOriginal<typeof import('../lib/livekit.js')>();
  return { ...livekit, getLiveKitParticipants: vi.fn(), removeLiveKitParticipant: vi.fn() };
});

function getCookieHeader(response: { headers: Record<string, string | string[] | undefined> }) {
  const value = response.headers['set-cookie'];
  return Array.isArray(value) ? value.join('; ') : (value ?? '');
}

async function register(name: string) {
  const email = `${name.toLowerCase()}@example.com`;
  await request(app).post('/api/auth/register').send({
    name,
    email,
    password: 'Password123',
    communityRulesAccepted: true,
  });
  const login = await request(app).post('/api/auth/login').send({ email, password: 'Password123' });
  return { auth: getCookieHeader(login), user: login.body.user as { id: string } };
}

describe('command 2a foundation', () => {
  beforeEach(() => {
    fallbackStore.clear();
    socialStore.clear();
    clearCommand2AStores();
  });

  it('marks unanswered call invitations missed after the ring timeout', async () => {
    vi.useFakeTimers();
    try {
      const call = createCallSession('caller', ['recipient'], 'voice');
      await vi.advanceTimersByTimeAsync(CALL_RING_TIMEOUT_MS);
      expect(getCallSession(call.id)?.status).toBe('missed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('creates and reads notification state and unread counts', async () => {
    await request(app).post('/api/auth/register').send({
      name: 'Alice',
      email: 'alice@example.com',
      password: 'Password123',
      communityRulesAccepted: true,
    });

    await request(app).post('/api/auth/register').send({
      name: 'Bob',
      email: 'bob@example.com',
      password: 'Password123',
      communityRulesAccepted: true,
    });

    const aliceLogin = await request(app).post('/api/auth/login').send({
      email: 'alice@example.com',
      password: 'Password123',
    });

    const bobUser = (await request(app).get('/api/users')).body.users.find((user: { name: string }) => user.name === 'Bob');
    const postResponse = await request(app)
      .post('/api/posts')
      .set('Cookie', getCookieHeader(aliceLogin))
      .send({ content: 'Test notification' });

    await request(app)
      .post(`/api/posts/${postResponse.body.post.id}/react`)
      .set('Cookie', getCookieHeader(aliceLogin))
      .send({ type: 'LIKE' });

    const bobLogin = await request(app).post('/api/auth/login').send({
      email: 'bob@example.com',
      password: 'Password123',
    });

    const followResponse = await request(app)
      .post(`/api/users/${bobUser.id}/follow`)
      .set('Cookie', getCookieHeader(aliceLogin));

    expect(followResponse.status).toBe(200);

    const notifications = await request(app)
      .get('/api/notifications')
      .set('Cookie', getCookieHeader(bobLogin));

    expect(notifications.status).toBe(200);
    expect(notifications.body.unreadCount).toBeGreaterThanOrEqual(1);
    expect(notifications.body.notifications.length).toBeGreaterThan(0);
  });

  it('notifies only followers when a public live broadcast starts', async () => {
    const host = await register('LiveHost');
    const follower = await register('LiveFollower');
    const publicViewer = await register('LivePublicViewer');
    const followedByHostId = 'user-only-followed-by-host';
    const now = new Date().toISOString();
    socialStore.state.follows.push(
      { id: 'follower-to-host', followerId: follower.user.id, followingId: host.user.id, createdAt: now },
      { id: 'host-to-followed', followerId: host.user.id, followingId: followedByHostId, createdAt: now },
    );
    const feedEvents: Array<{ event?: string; live?: { id: string; viewers?: unknown }; allowedUserIds?: string[] }> = [];
    const unsubscribe = subscribeToUserEvents(follower.user.id, (event) => { feedEvents.push(event as typeof feedEvents[number]); });
    const unsubscribePublicViewer = subscribeToUserEvents(publicViewer.user.id, (event) => { feedEvents.push(event as typeof feedEvents[number]); });
    vi.mocked(getLiveKitParticipants).mockResolvedValue([{
      identity: host.user.id,
      tracks: [
        { source: TrackSource.CAMERA, muted: false },
        { source: TrackSource.MICROPHONE, muted: false },
      ],
    } as Awaited<ReturnType<typeof getLiveKitParticipants>>[number]]);

    const created = await request(app).post('/api/live/create').set('Cookie', host.auth).send({ title: 'Follower notification test' });
    const started = await request(app).post(`/api/live/${created.body.live.id}/start`).set('Cookie', host.auth);

    expect(started.status).toBe(200);
    expect(feedEvents.some((event) =>
      event.event === 'live:feed:update'
      && event.live?.id === created.body.live.id
      && event.allowedUserIds?.includes(publicViewer.user.id)
      && event.live !== undefined
      && !('viewers' in event.live),
    )).toBe(true);
    const followerNotifications = await request(app).get('/api/notifications').set('Cookie', follower.auth);
    expect(followerNotifications.body.notifications.some((notification: { type: string }) => notification.type === 'live_started')).toBe(true);
    expect(socialStore.state.notifications.filter((notification) => notification.type === 'live_started').map((notification) => notification.recipientId))
      .toEqual([follower.user.id]);

    const followersOnly = await request(app).post('/api/live/create').set('Cookie', host.auth).send({ title: 'Followers-only notification test', visibility: 'followers' });
    const followersOnlyStarted = await request(app).post(`/api/live/${followersOnly.body.live.id}/start`).set('Cookie', host.auth);

    expect(followersOnlyStarted.status).toBe(200);
    expect(socialStore.state.notifications.filter((notification) => notification.type === 'live_started').map((notification) => notification.recipientId))
      .toEqual([follower.user.id, follower.user.id]);
    expect(feedEvents.some((event) => event.event === 'live:feed:update' && event.live?.id === followersOnly.body.live.id)).toBe(true);
    unsubscribe();
    unsubscribePublicViewer();
  }, 15_000);

  it('persists notification category preferences through the API', async () => {
    await request(app).post('/api/auth/register').send({
      name: 'Alice',
      email: 'alice@example.com',
      password: 'Password123',
      communityRulesAccepted: true,
    });
    const login = await request(app).post('/api/auth/login').send({ email: 'alice@example.com', password: 'Password123' });
    const auth = getCookieHeader(login);

    const initial = await request(app).get('/api/notifications/preferences').set('Cookie', auth);
    expect(initial.status).toBe(200);
    expect(initial.body.preferences.find((item: { key: string }) => item.key === 'messages').enabled).toBe(true);

    const updated = await request(app).put('/api/notifications/preferences').set('Cookie', auth).send({ key: 'messages', enabled: false });
    expect(updated.status).toBe(200);
    expect(updated.body.preferences.find((item: { key: string }) => item.key === 'messages').enabled).toBe(false);

    const refreshed = await request(app).get('/api/notifications/preferences').set('Cookie', auth);
    expect(refreshed.body.preferences.find((item: { key: string }) => item.key === 'messages').enabled).toBe(false);

    await request(app).put('/api/notifications/preferences').set('Cookie', auth).send({ key: 'calls', enabled: false });
    await request(app).post('/api/auth/register').send({ name: 'Bob', email: 'bob@example.com', password: 'Password123', communityRulesAccepted: true });
    const bobLogin = await request(app).post('/api/auth/login').send({ email: 'bob@example.com', password: 'Password123' });
    const alice = login.body.user as { id: string };
    await request(app).post('/api/calls/start').set('Cookie', getCookieHeader(bobLogin)).send({ targetUserId: alice.id, type: 'voice' });
    const notifications = await request(app).get('/api/notifications').set('Cookie', auth);
    expect(notifications.body.notifications.some((item: { type: string }) => item.type === 'call')).toBe(false);
    await request(app).put('/api/notifications/preferences').set('Cookie', auth).send({ key: 'calls', enabled: true });
  });

  it('updates presence and typing authorization for conversation participants', async () => {
    await request(app).post('/api/auth/register').send({
      name: 'Alice',
      email: 'alice@example.com',
      password: 'Password123',
      communityRulesAccepted: true,
    });
    await request(app).post('/api/auth/register').send({
      name: 'Bob',
      email: 'bob@example.com',
      password: 'Password123',
      communityRulesAccepted: true,
    });

    const aliceLogin = await request(app).post('/api/auth/login').send({
      email: 'alice@example.com',
      password: 'Password123',
    });
    const bobUser = (await request(app).get('/api/users')).body.users.find((user: { name: string }) => user.name === 'Bob');

    const convo = await request(app)
      .post('/api/conversations')
      .set('Cookie', getCookieHeader(aliceLogin))
      .send({ participantId: bobUser.id });

    const bobEvents: Array<Record<string, unknown>> = [];
    const stopListening = subscribeToUserEvents(bobUser.id, (event) => { bobEvents.push(event as Record<string, unknown>); });
    const spoofedPresence = await request(app)
      .post('/api/presence')
      .set('Cookie', getCookieHeader(aliceLogin))
      .send({ online: true, status: 'available' });
    expect(spoofedPresence.status).toBe(410);
    const presenceTransitions: boolean[] = [];
    const disconnect = registerRealtimeConnection(aliceLogin.body.user.id, (online) => { presenceTransitions.push(online); });
    const livePresence = await request(app)
      .get(`/api/presence/${aliceLogin.body.user.id}`)
      .set('Cookie', getCookieHeader(await request(app).post('/api/auth/login').send({ email: 'bob@example.com', password: 'Password123' })));
    expect(livePresence.status).toBe(200);
    expect(livePresence.body.presence).toMatchObject({ online: true, lastSeenAt: null });
    const privatePresence = await request(app)
      .patch('/api/messaging/preferences')
      .set('Cookie', getCookieHeader(aliceLogin))
      .send({ presenceVisibility: 'NOBODY' });
    expect(privatePresence.status).toBe(200);
    const hiddenPresence = await request(app)
      .get(`/api/presence/${aliceLogin.body.user.id}`)
      .set('Cookie', getCookieHeader(await request(app).post('/api/auth/login').send({ email: 'bob@example.com', password: 'Password123' })));
    expect(hiddenPresence.status).toBe(404);
    disconnect();
    expect(presenceTransitions).toEqual([true, false]);

    const typingResponse = await request(app)
      .post(`/api/conversations/${convo.body.conversation.id}/typing`)
      .set('Cookie', getCookieHeader(aliceLogin))
      .send({ isTyping: true });

    expect(typingResponse.status).toBe(200);
    expect(typingResponse.body.typing.isTyping).toBe(true);
    expect(bobEvents).toContainEqual(expect.objectContaining({
      event: 'typing:start',
      conversationId: convo.body.conversation.id,
      userId: aliceLogin.body.user.id,
    }));

    const unauthorized = await request(app)
      .post(`/api/conversations/unknown/typing`)
      .set('Cookie', getCookieHeader(aliceLogin))
      .send({ isTyping: true });

    expect(unauthorized.status).toBe(404);
    stopListening();
  });

  it('creates configured LiveKit calls and still applies existing block controls', async () => {
    await request(app).post('/api/auth/register').send({
      name: 'Alice',
      email: 'alice@example.com',
      password: 'Password123',
      communityRulesAccepted: true,
    });
    await request(app).post('/api/auth/register').send({
      name: 'Bob',
      email: 'bob@example.com',
      password: 'Password123',
      communityRulesAccepted: true,
    });

    const aliceLogin = await request(app).post('/api/auth/login').send({
      email: 'alice@example.com',
      password: 'Password123',
    });
    const bobUser = (await request(app).get('/api/users')).body.users.find((user: { name: string }) => user.name === 'Bob');

    const parallelStarts = await Promise.all([
      request(app).post('/api/calls/start').set('Cookie', getCookieHeader(aliceLogin)).send({ targetUserId: bobUser.id, type: 'voice' }),
      request(app).post('/api/calls/start').set('Cookie', getCookieHeader(aliceLogin)).send({ targetUserId: bobUser.id, type: 'voice' }),
    ]);
    expect(parallelStarts.map((response) => response.status).sort()).toEqual([201, 409]);
    const started = parallelStarts.find((response) => response.status === 201)!;

    expect(started.status).toBe(201);
    expect(started.body.call.provider).toBe('livekit');

    const simultaneous = await request(app)
      .post('/api/calls/start')
      .set('Cookie', getCookieHeader(aliceLogin))
      .send({ targetUserId: bobUser.id, type: 'video' });
    expect(simultaneous.status).toBe(409);
    expect(simultaneous.body.message).toMatch(/already in another call/);

    await request(app)
      .post(`/api/users/${bobUser.id}/block`)
      .set('Cookie', getCookieHeader(aliceLogin));

    const blocked = await request(app)
      .post('/api/calls/start')
      .set('Cookie', getCookieHeader(aliceLogin))
      .send({ targetUserId: bobUser.id, type: 'video' });

    expect(blocked.status).toBe(403);
    expect((await request(app).get('/api/calls/history').set('Cookie', getCookieHeader(aliceLogin))).body.calls).toHaveLength(1);
  });

  it('creates LiveKit live sessions in the existing paused lifecycle state', async () => {
    await request(app).post('/api/auth/register').send({
      name: 'Alice',
      email: 'alice@example.com',
      password: 'Password123',
      communityRulesAccepted: true,
    });
    await request(app).post('/api/auth/register').send({
      name: 'Bob',
      email: 'bob@example.com',
      password: 'Password123',
      communityRulesAccepted: true,
    });

    const aliceLogin = await request(app).post('/api/auth/login').send({
      email: 'alice@example.com',
      password: 'Password123',
    });
    const live = await request(app)
      .post('/api/live/create')
      .set('Cookie', getCookieHeader(aliceLogin))
      .send({ title: 'Launch stream', visibility: 'public' });

    expect(live.status).toBe(201);
    expect(live.body.live.provider).toBe('livekit');
    expect(live.body.live.status).toBe('paused');
    expect((await request(app).get('/api/live').set('Cookie', getCookieHeader(aliceLogin))).body.lives).toHaveLength(1);
  });

  it('enforces follower and private live audience permissions before media access', async () => {
    const host = await register('AudienceHost');
    const follower = await register('AudienceFollower');
    const outsider = await register('AudienceOutsider');
    socialStore.state.follows.push({
      id: 'audience-follow',
      followerId: follower.user.id,
      followingId: host.user.id,
      createdAt: new Date().toISOString(),
    });

    const followerLive = await request(app).post('/api/live/create').set('Cookie', host.auth).send({ title: 'Followers only', visibility: 'followers' });
    updateLiveSession(followerLive.body.live.id, (live) => ({ ...live, status: 'live' }));
    const followerLives = await request(app).get('/api/live').set('Cookie', follower.auth);
    const outsiderLives = await request(app).get('/api/live').set('Cookie', outsider.auth);

    expect(followerLives.body.lives.map((live: { id: string }) => live.id)).toContain(followerLive.body.live.id);
    expect(outsiderLives.body.lives.map((live: { id: string }) => live.id)).not.toContain(followerLive.body.live.id);
    expect((await request(app).get(`/api/live/${followerLive.body.live.id}`).set('Cookie', outsider.auth)).status).toBe(404);
    expect((await request(app).post(`/api/live/${followerLive.body.live.id}/viewers/join`).set('Cookie', outsider.auth)).status).toBe(403);
    expect((await request(app).post(`/api/live/${followerLive.body.live.id}/viewers/join`).set('Cookie', follower.auth)).status).toBe(201);
    expect((await request(app).post(`/api/live/${followerLive.body.live.id}/token`).set('Cookie', follower.auth)).status).toBe(200);
    expect((await request(app).post(`/api/live/${followerLive.body.live.id}/token`).set('Cookie', outsider.auth)).status).toBe(403);

    const privateLive = await request(app).post('/api/live/create').set('Cookie', host.auth).send({ title: 'Private session', visibility: 'private' });
    updateLiveSession(privateLive.body.live.id, (live) => ({ ...live, status: 'live' }));
    expect((await request(app).get(`/api/live/${privateLive.body.live.id}`).set('Cookie', outsider.auth)).status).toBe(404);
    expect((await request(app).post(`/api/live/${privateLive.body.live.id}/viewers/join`).set('Cookie', outsider.auth)).status).toBe(403);
    expect((await request(app).post(`/api/live/${privateLive.body.live.id}/token`).set('Cookie', outsider.auth)).status).toBe(403);
    expect((await request(app).post(`/api/live/${privateLive.body.live.id}/token`).set('Cookie', host.auth)).status).toBe(200);
  });

  it('prevents muted viewers from interacting and removes moderated viewers from LiveKit', async () => {
    const host = await register('ModerationHost');
    const viewer = await register('ModerationViewer');
    const created = await request(app).post('/api/live/create').set('Cookie', host.auth).send({ title: 'Moderated audience' });
    const liveId = created.body.live.id;
    updateLiveSession(liveId, (live) => ({
      ...live,
      status: 'live',
      viewers: [{ userId: viewer.user.id, isMuted: false, isBlocked: false, joinedAt: new Date().toISOString() }],
      viewerCount: 1,
    }));

    const muted = await request(app).post(`/api/live/${liveId}/viewer/${viewer.user.id}/mute`).set('Cookie', host.auth).send({ isMuted: true });
    expect(muted.status).toBe(200);
    expect((await request(app).post(`/api/live/${liveId}/comment`).set('Cookie', viewer.auth).send({ text: 'Muted comment' })).status).toBe(403);
    expect((await request(app).post(`/api/live/${liveId}/react`).set('Cookie', viewer.auth).send({ type: 'LIKE' })).status).toBe(403);
    expect(fallbackStore.listAdminActions().some((action) => action.actionType === 'LIVE_VIEWER_MUTED' && action.targetUserId === viewer.user.id)).toBe(true);

    const removed = await request(app).post(`/api/live/${liveId}/viewer/${viewer.user.id}/remove`).set('Cookie', host.auth);
    expect(removed.status).toBe(200);
    expect(vi.mocked(removeLiveKitParticipant)).toHaveBeenCalledWith(`nova-live-${liveId}`, viewer.user.id);
    expect(removed.body.live.viewers).toHaveLength(0);
  });

  it('lets an approved guest publish to the live room and denies publish after mute', async () => {
    const host = await register('GuestStageHost');
    const guest = await register('GuestStageMember');
    const created = await request(app).post('/api/live/create').set('Cookie', host.auth).send({ title: 'Guest stage' });
    const liveId = created.body.live.id;
    updateLiveSession(liveId, (live) => ({ ...live, status: 'live' }));

    expect((await request(app).post(`/api/live/${liveId}/guests/request`).set('Cookie', guest.auth).send({ role: 'COHOST' })).status).toBe(201);
    const approved = await request(app).post(`/api/live/${liveId}/guests/${guest.user.id}/approve`).set('Cookie', host.auth);
    expect(approved.status).toBe(200);
    expect(approved.body.guest).toMatchObject({ role: 'COHOST', status: 'LIVE' });
    expect((await request(app).post(`/api/live/${liveId}/viewers/join`).set('Cookie', guest.auth)).status).toBe(201);

    const viewerToken = await request(app).post(`/api/live/${liveId}/token`).set('Cookie', guest.auth);
    expect(viewerToken.status).toBe(200);
    expect((await new TokenVerifier('test-livekit-key', 'test-livekit-secret-that-is-only-used-in-tests').verify(viewerToken.body.token)).video)
      .toMatchObject({ canPublish: false, canSubscribe: true });
    expect((await request(app).post(`/api/live/${liveId}/stage/token`).set('Cookie', guest.auth)).status).toBe(403);

    const admitted = await request(app).post(`/api/live/${liveId}/guests/stage/join`).set('Cookie', guest.auth);
    expect(admitted.status).toBe(200);
    expect(admitted.body.guest).toMatchObject({ role: 'COHOST', status: 'LIVE' });
    expect(admitted.body.guest.admittedAt).toEqual(expect.any(String));
    const stageToken = await request(app).post(`/api/live/${liveId}/stage/token`).set('Cookie', guest.auth);
    expect(stageToken.status).toBe(200);
    expect(stageToken.body.role).toBe('cohost');
    const claims = await new TokenVerifier('test-livekit-key', 'test-livekit-secret-that-is-only-used-in-tests').verify(stageToken.body.token);
    expect(claims.video).toMatchObject({
      roomJoin: true,
      room: `nova-live-${liveId}`,
      canPublish: true,
      canSubscribe: true,
    });

    await request(app).post(`/api/live/${liveId}/viewer/${guest.user.id}/mute`).set('Cookie', host.auth).send({ isMuted: true });
    expect((await request(app).post(`/api/live/${liveId}/token`).set('Cookie', guest.auth)).status).toBe(403);
  });

  it('keeps session blocks out of the public Feed and prevents a blocked viewer rejoining', async () => {
    const host = await register('LiveBlockHost');
    const viewer = await register('LiveBlockViewer');
    const live = await request(app).post('/api/live/create').set('Cookie', host.auth).send({ title: 'Restricted broadcast' });
    const liveId = live.body.live.id;
    updateLiveSession(liveId, (session) => ({
      ...session,
      status: 'live',
      viewers: [{ userId: viewer.user.id, isMuted: false, isBlocked: false, joinedAt: new Date().toISOString() }],
      viewerCount: 1,
    }));
    socialStore.state.posts.push({
      id: 'blocked-live-post',
      authorId: host.user.id,
      content: 'Restricted broadcast',
      imageUrl: null,
      visibility: 'PUBLIC',
      sourceLiveBroadcastId: liveId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect((await request(app).post(`/api/live/${liveId}/block/${viewer.user.id}`).set('Cookie', host.auth)).status).toBe(200);
    expect((await request(app).post(`/api/live/${liveId}/viewers/join`).set('Cookie', viewer.auth)).status).toBe(403);
    expect((await request(app).get('/api/posts').set('Cookie', viewer.auth)).body.posts).toHaveLength(0);
    expect(fallbackStore.listAdminActions().some((action) => action.actionType === 'LIVE_VIEWER_BLOCKED')).toBe(true);
  });

  it('reports AI assistance unavailable instead of returning fabricated generated content', async () => {
    const response = await request(app)
      .post('/api/ai/summarize')
      .send({ content: 'This should summarize cleanly.' });

    expect(response.status).toBe(503);
    expect(response.body.message).toMatch(/no AI provider is configured/i);
    expect(response.body.summary).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toMatch(/sk-|api[_-]?key|secret/i);
  });
});

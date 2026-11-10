import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const liveKitMocks = vi.hoisted(() => ({
  endLiveKitRoom: vi.fn(),
  getLiveKitParticipants: vi.fn(),
  isLiveKitConfigured: vi.fn(),
}));

vi.mock('../lib/livekit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/livekit.js')>();
  return {
    ...actual,
    endLiveKitRoom: liveKitMocks.endLiveKitRoom,
    getLiveKitParticipants: liveKitMocks.getLiveKitParticipants,
    isLiveKitConfigured: liveKitMocks.isLiveKitConfigured,
  };
});

import { TrackSource } from 'livekit-server-sdk';
import { app } from '../app.js';
import { fallbackStore } from '../lib/fallbackStore.js';
import { socialStore } from '../lib/socialStore.js';
import { clearCommand2AStores, updateLiveSession } from '../lib/platform.js';
import { canDeleteLiveReplayMedia, isLiveReplayOwner } from '../lib/liveReplayPolicy.js';

function cookie(response: { headers: Record<string, string | string[] | undefined> }) {
  const value = response.headers['set-cookie'];
  return Array.isArray(value) ? value.join('; ') : value ?? '';
}

async function register(name: string) {
  const email = `${name.toLowerCase()}@example.com`;
  await request(app).post('/api/auth/register').send({ name, email, password: 'Password123', communityRulesAccepted: true });
  const login = await request(app).post('/api/auth/login').send({ email, password: 'Password123' });
  const user = await request(app).get(`/api/users/${login.body.user.id}`);
  return { auth: cookie(login), user: user.body.user };
}

describe('live broadcast lifecycle', () => {
  beforeEach(() => {
    fallbackStore.clear();
    socialStore.clear();
    clearCommand2AStores();
    liveKitMocks.endLiveKitRoom.mockReset().mockResolvedValue(undefined);
    liveKitMocks.getLiveKitParticipants.mockReset();
    liveKitMocks.isLiveKitConfigured.mockReset().mockReturnValue(true);
  });

  it('publishes one linked Feed post when the broadcast starts, including on repeated start requests', async () => {
    const host = await register('LiveFeedHost');
    const created = await request(app).post('/api/live/create').set('Cookie', host.auth).send({
      title: 'Town hall',
      description: 'Live community questions',
    });
    const liveId = created.body.live.id;
    liveKitMocks.isLiveKitConfigured.mockReturnValue(true);
    liveKitMocks.getLiveKitParticipants.mockResolvedValue([{
      identity: host.user.id,
      tracks: [
        { source: TrackSource.CAMERA, muted: false },
        { source: TrackSource.MICROPHONE, muted: false },
      ],
    }]);

    const started = await request(app).post(`/api/live/${liveId}/start`).set('Cookie', host.auth);
    const repeatedStart = await request(app).post(`/api/live/${liveId}/start`).set('Cookie', host.auth);
    const feed = await request(app).get('/api/posts').set('Cookie', host.auth);

    expect(started.status).toBe(200);
    expect(repeatedStart.status).toBe(200);
    expect(feed.body.posts.filter((post: { live?: { id: string } }) => post.live?.id === liveId)).toHaveLength(1);
    expect(feed.body.posts[0]).toMatchObject({
      content: 'Town hall\n\nLive community questions',
      live: { id: liveId, title: 'Town hall', status: 'live' },
    });
    const linkedPostId = feed.body.posts[0].id;
    expect((await request(app).patch(`/api/posts/${linkedPostId}`).set('Cookie', host.auth).send({
      visibility: 'PUBLIC',
      content: 'Changed audience',
    })).status).toBe(409);
    expect((await request(app).delete(`/api/posts/${linkedPostId}`).set('Cookie', host.auth)).status).toBe(409);
    expect((await request(app).get('/api/posts').set('Cookie', host.auth)).body.posts).toHaveLength(1);
  });

  it('refreshes viewer presence only after LiveKit confirms the viewer connection', async () => {
    const host = await register('HeartbeatHost');
    const viewer = await register('HeartbeatViewer');
    const created = await request(app).post('/api/live/create').set('Cookie', host.auth).send({ title: 'Heartbeat check' });
    const liveId = created.body.live.id;
    updateLiveSession(liveId, (live) => ({ ...live, status: 'live' }));
    liveKitMocks.getLiveKitParticipants.mockResolvedValue([]);

    expect((await request(app).post(`/api/live/${liveId}/viewers/join`).set('Cookie', viewer.auth)).status).toBe(201);
    const disconnected = await request(app).post(`/api/live/${liveId}/viewers/heartbeat`).set('Cookie', viewer.auth);
    expect(disconnected.status).toBe(409);

    liveKitMocks.getLiveKitParticipants.mockResolvedValue([{ identity: viewer.user.id, tracks: [] }]);
    const connected = await request(app).post(`/api/live/${liveId}/viewers/heartbeat`).set('Cookie', viewer.auth);
    expect(connected.status).toBe(200);
    expect(connected.body.live.viewerCount).toBe(1);
  });

  it('hides moderator, viewer, and pending guest state from ordinary live viewers', async () => {
    const host = await register('PrivacyHost');
    const viewer = await register('PrivacyViewer');
    const created = await request(app).post('/api/live/create').set('Cookie', host.auth).send({ title: 'Public session' });
    updateLiveSession(created.body.live.id, (live) => ({
      ...live,
      status: 'live',
      moderators: ['moderator-id'],
      blockedUserIds: ['blocked-id'],
      mutedUserIds: ['muted-id'],
      viewers: [{ userId: 'other-viewer', isMuted: false, isBlocked: false, joinedAt: new Date().toISOString() }],
      guests: [
        { userId: 'pending-guest', role: 'GUEST', status: 'REQUESTED', requestedAt: new Date().toISOString() },
        { userId: 'live-guest', role: 'COHOST', status: 'LIVE', requestedAt: new Date().toISOString() },
      ],
    }));

    const response = await request(app).get(`/api/live/${created.body.live.id}`).set('Cookie', viewer.auth);

    expect(response.status).toBe(200);
    expect(response.body.live).toMatchObject({
      moderators: [],
      blockedUserIds: [],
      mutedUserIds: [],
      viewers: [],
      guests: [{ userId: 'live-guest', status: 'LIVE' }],
    });
  });

  it('stops the LiveKit room and ends a live session with zero viewers', async () => {
    const host = await register('LifecycleHost');
    const created = await request(app).post('/api/live/create').set('Cookie', host.auth).send({ title: 'Session to end' });
    const liveId = created.body.live.id;
    updateLiveSession(liveId, (live) => ({
      ...live,
      status: 'live',
      recordingStatus: 'RECORDING',
      viewerCount: 2,
      viewers: [
        { userId: 'viewer-1', isMuted: false, isBlocked: false, joinedAt: new Date().toISOString() },
        { userId: 'viewer-2', isMuted: false, isBlocked: false, joinedAt: new Date().toISOString() },
      ],
    }));

    const response = await request(app).post(`/api/live/${liveId}/end`).set('Cookie', host.auth);

    expect(response.status).toBe(200);
    expect(liveKitMocks.endLiveKitRoom).toHaveBeenCalledWith(`nova-live-${liveId}`);
    expect(response.body.live).toMatchObject({ status: 'ended', viewerCount: 0, viewers: [] });
    expect((await request(app).get('/api/live').set('Cookie', host.auth)).body.lives[0]).toMatchObject({
      id: liveId,
      status: 'ended',
      recordingStatus: 'RECORDING',
    });
  });

  it('does not allow another account to end a broadcast', async () => {
    const host = await register('LifecycleOwner');
    const other = await register('LifecycleOther');
    const created = await request(app).post('/api/live/create').set('Cookie', host.auth).send({ title: 'Owned session' });
    updateLiveSession(created.body.live.id, (live) => ({ ...live, status: 'live' }));

    const response = await request(app).post(`/api/live/${created.body.live.id}/end`).set('Cookie', other.auth);

    expect(response.status).toBe(403);
    expect(liveKitMocks.endLiveKitRoom).not.toHaveBeenCalled();
  });

  it('keeps the session active and returns a retryable error when LiveKit cannot be stopped', async () => {
    const host = await register('LifecycleRetryHost');
    const created = await request(app).post('/api/live/create').set('Cookie', host.auth).send({ title: 'Retry end' });
    const liveId = created.body.live.id;
    updateLiveSession(liveId, (live) => ({ ...live, status: 'live' }));
    liveKitMocks.endLiveKitRoom.mockRejectedValueOnce(new Error('LiveKit unavailable'));

    const response = await request(app).post(`/api/live/${liveId}/end`).set('Cookie', host.auth);

    expect(response.status).toBe(503);
    expect(response.body.message).toContain('retry ending it');
    expect((await request(app).get(`/api/live/${liveId}`).set('Cookie', host.auth)).body.live.status).toBe('live');
  });

  it('reports the exact persistent replay server setup required when unavailable', async () => {
    const host = await register('ReplayInfraOwner');

    const response = await request(app).get('/api/live/replays').set('Cookie', host.auth);

    expect(response.status).toBe(503);
    expect(response.body.message).toContain('DATABASE_URL');
    expect(response.body.message).toContain('apply Prisma migrations');
  });

  it('restricts replay publishing and deletion to the recording owner', () => {
    const replay = { hostId: 'creator-1' };
    expect(isLiveReplayOwner(replay, 'creator-1')).toBe(true);
    expect(isLiveReplayOwner(replay, 'another-user')).toBe(false);
    expect(canDeleteLiveReplayMedia('READY', { contentType: 'video/webm', ownerUserId: 'creator-1' }, 'creator-1')).toBe(true);
    expect(canDeleteLiveReplayMedia('READY', null, 'creator-1')).toBe(false);
    expect(canDeleteLiveReplayMedia('DELETING', null, 'creator-1')).toBe(true);
    expect(canDeleteLiveReplayMedia('DELETING', { contentType: 'video/webm', ownerUserId: 'another-user' }, 'creator-1')).toBe(false);
    expect(canDeleteLiveReplayMedia('DELETING', { contentType: 'application/pdf', ownerUserId: 'creator-1' }, 'creator-1')).toBe(false);
  });
});

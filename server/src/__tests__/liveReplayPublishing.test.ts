import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const databaseMocks = vi.hoisted(() => ({
  isDatabaseAvailable: vi.fn(),
  transaction: vi.fn(),
  liveReplayFindUnique: vi.fn(),
  liveReplayUpdate: vi.fn(),
  liveBroadcastFindUnique: vi.fn(),
  liveBroadcastCommentFindMany: vi.fn(),
  liveBroadcastReactionFindMany: vi.fn(),
  blockFindUnique: vi.fn(),
  postFindUnique: vi.fn(),
  postCreate: vi.fn(),
  sessionFindFirst: vi.fn(),
  userFindUnique: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({
  isDatabaseAvailable: databaseMocks.isDatabaseAvailable,
  prisma: {
    $transaction: databaseMocks.transaction,
    liveReplay: {
      findUnique: databaseMocks.liveReplayFindUnique,
      update: databaseMocks.liveReplayUpdate,
    },
    liveBroadcast: { findUnique: databaseMocks.liveBroadcastFindUnique },
    liveBroadcastComment: { findMany: databaseMocks.liveBroadcastCommentFindMany },
    liveBroadcastReaction: { findMany: databaseMocks.liveBroadcastReactionFindMany },
    block: { findUnique: databaseMocks.blockFindUnique },
    post: {
      findUnique: databaseMocks.postFindUnique,
      create: databaseMocks.postCreate,
    },
    session: { findFirst: databaseMocks.sessionFindFirst },
    user: { findUnique: databaseMocks.userFindUnique },
  },
}));

import { app } from '../app.js';
import { fallbackStore } from '../lib/fallbackStore.js';
import { getMediaStorage } from '../lib/mediaStorage.js';
import { clearCommand2AStores, getLiveSession } from '../lib/platform.js';
import { socialStore } from '../lib/socialStore.js';

function cookie(response: { headers: Record<string, string | string[] | undefined> }) {
  const value = response.headers['set-cookie'];
  return Array.isArray(value) ? value.join('; ') : value ?? '';
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
  return { auth: cookie(login), user: login.body.user as { id: string; email: string; name: string; role: string; status: string } };
}

describe('linked Live replay publishing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    databaseMocks.isDatabaseAvailable.mockResolvedValue(false);
    databaseMocks.sessionFindFirst.mockResolvedValue({ id: 'database-session' });
    fallbackStore.clear();
    socialStore.clear();
    clearCommand2AStores();
  });

  it('attaches a replay to its original Feed post and returns that post on retries', async () => {
    const host = await register('ReplayFeedHost');
    const created = await request(app).post('/api/live/create').set('Cookie', host.auth).send({
      title: 'Town hall',
      description: 'Live community questions',
    });
    const liveId = created.body.live.id as string;
    const uploaded = await getMediaStorage('test').putAttachment(
      Buffer.from('webm replay'),
      'video/webm',
      'webm',
      host.user.id,
    );

    let replay = {
      id: liveId,
      hostId: host.user.id,
      title: 'Town hall',
      status: 'READY',
      mediaUrl: uploaded.publicUrl,
      publishedPostId: null as string | null,
    };
    const linkedPost = {
      id: 'original-live-post',
      authorId: host.user.id,
      content: 'Town hall\n\nLive community questions',
      imageUrl: null as string | null,
      visibility: 'PUBLIC',
      sourceLiveBroadcastId: liveId,
    };
    const transaction = {
      liveReplay: {
        findUnique: vi.fn(async () => replay),
        update: vi.fn(async ({ data }: { data: Partial<typeof replay> }) => {
          replay = { ...replay, ...data };
          return replay;
        }),
      },
      post: {
        findUnique: vi.fn(async ({ where }: { where: { id?: string; sourceLiveBroadcastId?: string } }) =>
          where.id === linkedPost.id || where.sourceLiveBroadcastId === liveId ? linkedPost : null),
        update: vi.fn(async ({ data }: { data: Partial<typeof linkedPost> }) => {
          Object.assign(linkedPost, data);
          return linkedPost;
        }),
        create: vi.fn(),
      },
    };
    databaseMocks.isDatabaseAvailable.mockResolvedValue(true);
    databaseMocks.userFindUnique.mockResolvedValue(host.user);
    databaseMocks.liveReplayFindUnique.mockImplementation(async () => replay);
    databaseMocks.liveReplayUpdate.mockImplementation(async ({ data }: { data: Partial<typeof replay> }) => {
      replay = { ...replay, ...data };
      return replay;
    });
    databaseMocks.postFindUnique.mockImplementation(async ({ where }: { where: { id?: string; sourceLiveBroadcastId?: string } }) =>
      where.id === linkedPost.id || where.sourceLiveBroadcastId === liveId ? linkedPost : null);
    databaseMocks.transaction.mockImplementation(async (operation: (client: typeof transaction) => Promise<unknown>) => operation(transaction));

    const firstPublish = await request(app)
      .post(`/api/live/${liveId}/replay/publish`)
      .set('Cookie', host.auth)
      .send({});

    expect(firstPublish.status).toBe(201);
    expect(firstPublish.body.post).toMatchObject({
      id: 'original-live-post',
      content: 'Town hall\n\nLive community questions',
      visibility: 'PUBLIC',
      imageUrl: uploaded.publicUrl,
    });
    expect(transaction.post.findUnique).toHaveBeenCalledWith({ where: { sourceLiveBroadcastId: liveId } });
    expect(transaction.post.update).toHaveBeenCalledTimes(1);
    expect(transaction.post.create).not.toHaveBeenCalled();

    const retry = await request(app)
      .post(`/api/live/${liveId}/replay/publish`)
      .set('Cookie', host.auth)
      .send({});

    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({
      duplicate: true,
      replay: { status: 'PUBLISHED', publishedPostId: 'original-live-post' },
      post: { id: 'original-live-post' },
    });
    expect(databaseMocks.postCreate).not.toHaveBeenCalled();
  });

  it('hydrates persisted comments before restoring a database-backed live session', async () => {
    const host = await register('PersistedLiveHost');
    const created = await request(app).post('/api/live/create').set('Cookie', host.auth).send({
      title: 'Community questions',
    });
    const liveId = created.body.live.id as string;
    const comment = {
      id: 'persisted-comment',
      liveId,
      userId: host.user.id,
      text: 'Welcome to the stream.',
      createdAt: new Date(),
    };
    const record = {
      id: liveId,
      hostId: host.user.id,
      title: 'Community questions',
      description: null,
      visibility: 'public',
      status: 'live',
      recordingStatus: 'UNAVAILABLE',
      replayUrl: null,
      moderators: [],
      blockedUserIds: [],
      mutedUserIds: [],
      guests: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      viewers: [],
    };
    databaseMocks.isDatabaseAvailable.mockResolvedValue(true);
    databaseMocks.userFindUnique.mockResolvedValue(host.user);
    databaseMocks.blockFindUnique.mockResolvedValue(null);
    databaseMocks.liveBroadcastFindUnique.mockResolvedValue(record);
    databaseMocks.liveBroadcastCommentFindMany.mockResolvedValue([comment]);
    databaseMocks.liveBroadcastReactionFindMany.mockResolvedValue([]);

    const response = await request(app).get(`/api/live/${liveId}`).set('Cookie', host.auth);

    expect(response.status).toBe(200);
    expect(response.body.live.comments).toMatchObject([
      { id: comment.id, userId: host.user.id, text: comment.text },
    ]);
    expect(getLiveSession(liveId)?.comments).toMatchObject([
      { id: comment.id, userId: host.user.id, text: comment.text },
    ]);
  });
});

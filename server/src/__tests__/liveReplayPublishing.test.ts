import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const databaseMocks = vi.hoisted(() => ({
  isDatabaseAvailable: vi.fn(),
  transaction: vi.fn(),
  liveReplayFindUnique: vi.fn(),
  liveReplayUpdate: vi.fn(),
  liveBroadcastFindUnique: vi.fn(),
  liveBroadcastFindFirst: vi.fn(),
  liveBroadcastCommentFindMany: vi.fn(),
  liveBroadcastReactionFindMany: vi.fn(),
  blockFindUnique: vi.fn(),
  postFindUnique: vi.fn(),
  postCount: vi.fn(),
  postCreate: vi.fn(),
  postDelete: vi.fn(),
  liveBroadcastUpdateMany: vi.fn(),
  liveReplayCount: vi.fn(),
  storyFindFirst: vi.fn(),
  messageFindFirst: vi.fn(),
  sessionFindFirst: vi.fn(),
  userFindUnique: vi.fn(),
  profileFindFirst: vi.fn(),
}));

const egressMocks = vi.hoisted(() => ({
  deleteFile: vi.fn(),
  stop: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({
  isDatabaseAvailable: databaseMocks.isDatabaseAvailable,
  prisma: {
    $transaction: databaseMocks.transaction,
    liveReplay: {
      findUnique: databaseMocks.liveReplayFindUnique,
      update: databaseMocks.liveReplayUpdate,
      count: databaseMocks.liveReplayCount,
    },
    liveBroadcast: {
      findUnique: databaseMocks.liveBroadcastFindUnique,
      findFirst: databaseMocks.liveBroadcastFindFirst,
      updateMany: databaseMocks.liveBroadcastUpdateMany,
    },
    liveBroadcastComment: { findMany: databaseMocks.liveBroadcastCommentFindMany },
    liveBroadcastReaction: { findMany: databaseMocks.liveBroadcastReactionFindMany },
    block: { findUnique: databaseMocks.blockFindUnique },
    post: {
      findUnique: databaseMocks.postFindUnique,
      count: databaseMocks.postCount,
      create: databaseMocks.postCreate,
      delete: databaseMocks.postDelete,
    },
    story: { findFirst: databaseMocks.storyFindFirst },
    message: { findFirst: databaseMocks.messageFindFirst },
    profile: { findFirst: databaseMocks.profileFindFirst },
    session: { findFirst: databaseMocks.sessionFindFirst },
    user: { findUnique: databaseMocks.userFindUnique },
  },
}));

vi.mock('../lib/livekitEgress.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/livekitEgress.js')>();
  return {
    ...actual,
    deleteLiveKitEgressFile: egressMocks.deleteFile,
    stopLiveKitEgress: egressMocks.stop,
  };
});

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

  it('lets only the post owner delete a published replay and removes its file and replay references', async () => {
    const host = await register('ReplayDeleteHost');
    const other = await register('ReplayDeleteOther');
    const stored = await getMediaStorage('test').putAttachment(
      Buffer.from('published replay'),
      'video/webm',
      'webm',
      host.user.id,
    );
    const post = {
      id: 'published-replay-post',
      authorId: host.user.id,
      sourceLiveReplayId: null,
      sourceLiveBroadcastId: 'live-delete-1',
    };
    const replay = {
      id: 'live-delete-1',
      hostId: host.user.id,
      title: 'Town hall',
      status: 'PUBLISHED',
      mediaUrl: stored.publicUrl,
      publishedPostId: post.id as string | null,
      deletedPostId: null as string | null,
    };
    let postExists = true;
    const broadcast = {
      replayUrl: stored.publicUrl as string | null,
      egressId: 'egress-delete-test' as string | null,
      egressOutputKey: 'live-recordings/live-delete-1/recording.mp4' as string | null,
      recordingStatus: 'READY',
    };
    const transaction = {
      post: {
        findUnique: vi.fn(async () => postExists ? post : null),
        delete: vi.fn(async () => {
          postExists = false;
          return post;
        }),
      },
      liveReplay: {
        findUnique: vi.fn(async () => replay),
        update: vi.fn(async ({ data }: { data: Partial<typeof replay> }) => {
          Object.assign(replay, data);
          return replay;
        }),
      },
      liveBroadcast: {
        updateMany: vi.fn(async ({ data }: { data: Partial<typeof broadcast> }) => {
          Object.assign(broadcast, data);
          return { count: 1 };
        }),
      },
    };
    databaseMocks.isDatabaseAvailable.mockResolvedValue(true);
    databaseMocks.postFindUnique.mockImplementation(async () => postExists ? post : null);
    databaseMocks.postCount.mockResolvedValue(0);
    databaseMocks.liveReplayFindUnique.mockImplementation(async ({ where }: { where: { id?: string; publishedPostId?: string; deletedPostId?: string } }) =>
      where.deletedPostId === post.id && replay.deletedPostId === post.id ? replay
        : where.id === replay.id || where.publishedPostId === post.id ? replay : null);
    databaseMocks.liveReplayCount.mockResolvedValue(0);
    databaseMocks.storyFindFirst.mockResolvedValue(null);
    databaseMocks.messageFindFirst.mockResolvedValue(null);
    databaseMocks.profileFindFirst.mockResolvedValue(null);
    databaseMocks.liveBroadcastFindFirst.mockResolvedValue(null);
    databaseMocks.liveBroadcastFindUnique.mockImplementation(async () => broadcast);
    databaseMocks.userFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === host.user.id ? host.user : where.id === other.user.id ? other.user : null);
    databaseMocks.liveReplayUpdate.mockImplementation(async ({ data }: { data: Partial<typeof replay> }) => {
      Object.assign(replay, data);
      return replay;
    });
    databaseMocks.transaction.mockImplementation(async (operation: (client: typeof transaction) => Promise<unknown>) => operation(transaction));

    const denied = await request(app).delete(`/api/posts/${post.id}`).set('Cookie', other.auth);
    expect(denied.status).toBe(403);
    expect(await getMediaStorage('test').getMetadata(stored.key)).not.toBeNull();

    const deleted = await request(app).delete(`/api/posts/${post.id}`).set('Cookie', host.auth);
    expect(deleted.status).toBe(200);
    expect(await getMediaStorage('test').getMetadata(stored.key)).toBeNull();
    expect(await getMediaStorage('test').get(stored.key)).toBeNull();
    expect(replay).toMatchObject({ status: 'DELETED', publishedPostId: null, deletedPostId: post.id });
    expect(deleted.body).toMatchObject({ mediaDeleted: true, sharedMediaPreserved: false });
    expect(transaction.post.delete).toHaveBeenCalledWith({ where: { id: post.id } });
    expect(transaction.liveBroadcast.updateMany).toHaveBeenCalledWith({
      where: { id: post.sourceLiveBroadcastId, replayUrl: stored.publicUrl },
      data: { replayUrl: null, recordingStatus: 'UNAVAILABLE' },
    });
    expect(egressMocks.stop).toHaveBeenCalledWith('egress-delete-test');
    expect(egressMocks.deleteFile).toHaveBeenCalledWith('live-recordings/live-delete-1/recording.mp4');
    expect(broadcast).toMatchObject({ replayUrl: null, egressId: null, egressOutputKey: null });

    const retry = await request(app).delete(`/api/posts/${post.id}`).set('Cookie', host.auth);
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ alreadyDeleted: true });
    expect(transaction.post.delete).toHaveBeenCalledTimes(1);
    expect(await getMediaStorage('test').get(stored.key)).toBeNull();
  });

  it('preserves replay bytes still referenced by another Feed post', async () => {
    const host = await register('ReplaySharedMediaOwner');
    const stored = await getMediaStorage('test').putAttachment(
      Buffer.from('shared replay'),
      'video/webm',
      'webm',
      host.user.id,
    );
    const post = {
      id: 'shared-replay-post',
      authorId: host.user.id,
      sourceLiveReplayId: null,
      sourceLiveBroadcastId: 'live-shared-1',
    };
    const replay = {
      id: 'live-shared-1',
      hostId: host.user.id,
      title: 'Shared replay',
      status: 'PUBLISHED',
      mediaUrl: stored.publicUrl,
      publishedPostId: post.id as string | null,
      deletedPostId: null as string | null,
    };
    const broadcast = {
      replayUrl: stored.publicUrl as string | null,
      egressId: null as string | null,
      egressOutputKey: null as string | null,
      recordingStatus: 'READY',
    };
    let postExists = true;
    const transaction = {
      post: {
        findUnique: vi.fn(async () => postExists ? post : null),
        delete: vi.fn(async () => {
          postExists = false;
          return post;
        }),
      },
      liveReplay: {
        findUnique: vi.fn(async () => replay),
        update: vi.fn(async ({ data }: { data: Partial<typeof replay> }) => {
          Object.assign(replay, data);
          return replay;
        }),
      },
      liveBroadcast: {
        updateMany: vi.fn(async ({ data }: { data: Partial<typeof broadcast> }) => {
          Object.assign(broadcast, data);
          return { count: 1 };
        }),
      },
    };
    databaseMocks.isDatabaseAvailable.mockResolvedValue(true);
    databaseMocks.postFindUnique.mockImplementation(async () => postExists ? post : null);
    databaseMocks.postCount.mockResolvedValue(1);
    databaseMocks.liveReplayFindUnique.mockImplementation(async ({ where }: { where: { id?: string; publishedPostId?: string; deletedPostId?: string } }) =>
      where.deletedPostId === post.id && replay.deletedPostId === post.id ? replay
        : where.id === replay.id || where.publishedPostId === post.id ? replay : null);
    databaseMocks.liveReplayCount.mockResolvedValue(0);
    databaseMocks.storyFindFirst.mockResolvedValue(null);
    databaseMocks.messageFindFirst.mockResolvedValue(null);
    databaseMocks.profileFindFirst.mockResolvedValue(null);
    databaseMocks.liveBroadcastFindFirst.mockResolvedValue(null);
    databaseMocks.liveBroadcastFindUnique.mockImplementation(async () => broadcast);
    databaseMocks.liveReplayUpdate.mockImplementation(async ({ data }: { data: Partial<typeof replay> }) => {
      Object.assign(replay, data);
      return replay;
    });
    databaseMocks.transaction.mockImplementation(async (operation: (client: typeof transaction) => Promise<unknown>) => operation(transaction));

    const deleted = await request(app).delete(`/api/posts/${post.id}`).set('Cookie', host.auth);

    expect(deleted.status).toBe(200);
    expect(deleted.body).toMatchObject({ mediaDeleted: false, sharedMediaPreserved: true });
    expect(await getMediaStorage('test').get(stored.key)).not.toBeNull();
    expect(transaction.post.delete).toHaveBeenCalledWith({ where: { id: post.id } });
  });
});

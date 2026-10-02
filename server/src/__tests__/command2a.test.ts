import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { fallbackStore } from '../lib/fallbackStore.js';
import { socialStore } from '../lib/socialStore.js';

function getCookieHeader(response: { headers: Record<string, string | string[] | undefined> }) {
  const value = response.headers['set-cookie'];
  return Array.isArray(value) ? value.join('; ') : (value ?? '');
}

describe('command 2a foundation', () => {
  beforeEach(() => {
    fallbackStore.clear();
    socialStore.clear();
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

    const bobUser = (await request(app).get('/api/users')).body.users.find((user: { email: string }) => user.email === 'bob@example.com');
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
    const bobUser = (await request(app).get('/api/users')).body.users.find((user: { email: string }) => user.email === 'bob@example.com');

    const convo = await request(app)
      .post('/api/conversations')
      .set('Cookie', getCookieHeader(aliceLogin))
      .send({ participantId: bobUser.id });

    const presence = await request(app)
      .post('/api/presence')
      .set('Cookie', getCookieHeader(aliceLogin))
      .send({ online: true, status: 'available' });

    expect(presence.status).toBe(200);
    expect(presence.body.presence.online).toBe(true);

    const typingResponse = await request(app)
      .post(`/api/conversations/${convo.body.conversation.id}/typing`)
      .set('Cookie', getCookieHeader(aliceLogin))
      .send({ isTyping: true });

    expect(typingResponse.status).toBe(200);
    expect(typingResponse.body.typing.isTyping).toBe(true);

    const unauthorized = await request(app)
      .post(`/api/conversations/unknown/typing`)
      .set('Cookie', getCookieHeader(aliceLogin))
      .send({ isTyping: true });

    expect(unauthorized.status).toBe(404);
  });

  it('enforces call authorization and blocked user restrictions', async () => {
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
    const bobUser = (await request(app).get('/api/users')).body.users.find((user: { email: string }) => user.email === 'bob@example.com');

    const started = await request(app)
      .post('/api/calls/start')
      .set('Cookie', getCookieHeader(aliceLogin))
      .send({ targetUserId: bobUser.id, type: 'voice' });

    expect(started.status).toBe(200);
    expect(started.body.call.type).toBe('voice');
    expect(['ringing', 'outgoing', 'connected']).toContain(started.body.call.status);

    await request(app)
      .post(`/api/users/${bobUser.id}/block`)
      .set('Cookie', getCookieHeader(aliceLogin));

    const blocked = await request(app)
      .post('/api/calls/start')
      .set('Cookie', getCookieHeader(aliceLogin))
      .send({ targetUserId: bobUser.id, type: 'video' });

    expect(blocked.status).toBe(403);
    expect(blocked.body.message).toMatch(/blocked|block/i);
  });

  it('enforces live host and moderator permissions', async () => {
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
    const bobUser = (await request(app).get('/api/users')).body.users.find((user: { email: string }) => user.email === 'bob@example.com');

    const live = await request(app)
      .post('/api/live/create')
      .set('Cookie', getCookieHeader(aliceLogin))
      .send({ title: 'Launch stream', visibility: 'public' });

    expect(live.status).toBe(201);

    const bobLogin = await request(app).post('/api/auth/login').send({
      email: 'bob@example.com',
      password: 'Password123',
    });

    const viewerKick = await request(app)
      .post(`/api/live/${live.body.live.id}/viewer/${bobUser.id}/remove`)
      .set('Cookie', getCookieHeader(bobLogin));

    expect(viewerKick.status).toBe(403);

    const hostEnd = await request(app)
      .post(`/api/live/${live.body.live.id}/end`)
      .set('Cookie', getCookieHeader(aliceLogin));

    expect(hostEnd.status).toBe(200);
    expect(hostEnd.body.live.status).toBe('ended');
  });

  it('exposes the AI provider abstraction without exposing keys', async () => {
    const response = await request(app)
      .post('/api/ai/summarize')
      .send({ content: 'This should summarize cleanly.' });

    expect(response.status).toBe(200);
    expect(response.body.provider).toMatch(/mock|local|development/i);
    expect(JSON.stringify(response.body)).not.toMatch(/sk-|api[_-]?key|secret/i);
  });
});

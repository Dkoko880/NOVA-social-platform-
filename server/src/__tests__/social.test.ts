import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { fallbackStore } from '../lib/fallbackStore.js';
import { socialStore } from '../lib/socialStore.js';

function getCookieHeader(response: { headers: Record<string, string | string[] | undefined> }) {
  const value = response.headers['set-cookie'];

  if (Array.isArray(value)) {
    return value.join('; ');
  }

  return value ?? '';
}

describe('social platform features', () => {
  beforeEach(() => {
    fallbackStore.clear();
    socialStore.clear();
  });

  it('authenticated user can create a post', async () => {
    await request(app).post('/api/auth/register').send({
      name: 'Alice',
      email: 'alice@example.com',
      password: 'Password123',
      communityRulesAccepted: true,
    });

    const loginResponse = await request(app).post('/api/auth/login').send({
      email: 'alice@example.com',
      password: 'Password123',
    });

    const response = await request(app)
      .post('/api/posts')
      .set('Cookie', getCookieHeader(loginResponse))
      .send({
        content: 'Hello NOVA!',
        imageUrl: 'https://example.com/post.jpg',
      });

    expect(response.status).toBe(201);
    expect(response.body.post.content).toBe('Hello NOVA!');
    expect(response.body.post.author.name).toBe('Alice');
  });

  it('does not publish content that requires moderator review', async () => {
    await request(app).post('/api/auth/register').send({
      name: 'Alice',
      email: 'alice@example.com',
      password: 'Password123',
      communityRulesAccepted: true,
    });
    const login = await request(app).post('/api/auth/login').send({
      email: 'alice@example.com',
      password: 'Password123',
    });

    const response = await request(app)
      .post('/api/posts')
      .set('Cookie', getCookieHeader(login))
      .send({ content: 'sexual '.repeat(37) });

    expect(response.status).toBe(422);
  });

  it('unauthenticated user cannot create a post', async () => {
    const response = await request(app).post('/api/posts').send({ content: 'Nope' });

    expect(response.status).toBe(401);
  });

  it('user can follow another user', async () => {
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

    const target = await request(app)
      .post(`/api/users/${(await request(app).get('/api/users')).body.users[1].id}/follow`)
      .set('Cookie', getCookieHeader(aliceLogin));

    expect(target.status).toBe(200);
    expect(target.body.following).toBe(true);
  });

  it('duplicate follow is prevented', async () => {
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

    const targetUser = (await request(app).get('/api/users')).body.users.find((user: { name: string }) => user.name === 'Bob');

    const first = await request(app)
      .post(`/api/users/${targetUser.id}/follow`)
      .set('Cookie', getCookieHeader(aliceLogin));

    const second = await request(app)
      .post(`/api/users/${targetUser.id}/follow`)
      .set('Cookie', getCookieHeader(aliceLogin));

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
  });

  it('user can react to a post', async () => {
    await request(app).post('/api/auth/register').send({
      name: 'Alice',
      email: 'alice@example.com',
      password: 'Password123',
      communityRulesAccepted: true,
    });

    const loginResponse = await request(app).post('/api/auth/login').send({
      email: 'alice@example.com',
      password: 'Password123',
    });

    const createdPost = await request(app)
      .post('/api/posts')
      .set('Cookie', getCookieHeader(loginResponse))
      .send({ content: 'Hello world' });

    const response = await request(app)
      .post(`/api/posts/${createdPost.body.post.id}/react`)
      .set('Cookie', getCookieHeader(loginResponse))
      .send({ type: 'LIKE' });

    expect(response.status).toBe(200);
    expect(response.body.reaction.type).toBe('LIKE');
    expect(response.body.reactionCounts.LIKE).toBe(1);
  });

  it('duplicate reaction is prevented or updated', async () => {
    await request(app).post('/api/auth/register').send({
      name: 'Alice',
      email: 'alice@example.com',
      password: 'Password123',
      communityRulesAccepted: true,
    });

    const loginResponse = await request(app).post('/api/auth/login').send({
      email: 'alice@example.com',
      password: 'Password123',
    });

    const createdPost = await request(app)
      .post('/api/posts')
      .set('Cookie', getCookieHeader(loginResponse))
      .send({ content: 'Hello world' });

    await request(app)
      .post(`/api/posts/${createdPost.body.post.id}/react`)
      .set('Cookie', getCookieHeader(loginResponse))
      .send({ type: 'LIKE' });

    const updated = await request(app)
      .post(`/api/posts/${createdPost.body.post.id}/react`)
      .set('Cookie', getCookieHeader(loginResponse))
      .send({ type: 'LOVE' });

    expect(updated.status).toBe(200);
    expect(updated.body.reaction.type).toBe('LOVE');
    expect(updated.body.reactionCounts.LIKE).toBe(0);
    expect(updated.body.reactionCounts.LOVE).toBe(1);
  });

  it('user can comment', async () => {
    await request(app).post('/api/auth/register').send({
      name: 'Alice',
      email: 'alice@example.com',
      password: 'Password123',
      communityRulesAccepted: true,
    });

    const loginResponse = await request(app).post('/api/auth/login').send({
      email: 'alice@example.com',
      password: 'Password123',
    });

    const createdPost = await request(app)
      .post('/api/posts')
      .set('Cookie', getCookieHeader(loginResponse))
      .send({ content: 'The first post' });

    const response = await request(app)
      .post(`/api/posts/${createdPost.body.post.id}/comments`)
      .set('Cookie', getCookieHeader(loginResponse))
      .send({ content: 'Nice post!' });

    expect(response.status).toBe(201);
    expect(response.body.comment.content).toBe('Nice post!');
  });

  it('user cannot delete another user post', async () => {
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

    const bobLogin = await request(app).post('/api/auth/login').send({
      email: 'bob@example.com',
      password: 'Password123',
    });

    const createdPost = await request(app)
      .post('/api/posts')
      .set('Cookie', getCookieHeader(aliceLogin))
      .send({ content: 'Alice post' });

    const forbidden = await request(app)
      .delete(`/api/posts/${createdPost.body.post.id}`)
      .set('Cookie', getCookieHeader(bobLogin));

    expect(forbidden.status).toBe(403);
  });

  it('creates a private conversation and sends a message', async () => {
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

    const conversation = await request(app)
      .post('/api/conversations')
      .set('Cookie', getCookieHeader(aliceLogin))
      .send({ participantId: bobUser.id });

    const message = await request(app)
      .post(`/api/conversations/${conversation.body.conversation.id}/messages`)
      .set('Cookie', getCookieHeader(aliceLogin))
      .send({ text: 'Hello Bob, can we coordinate the volunteer plan?' });

    expect(conversation.status).toBe(201);
    expect(message.status).toBe(201);
    expect(message.body.message.text).toContain('volunteer plan');
  });

  it('does not create a conversation with a missing user', async () => {
    await request(app).post('/api/auth/register').send({
      name: 'Alice',
      email: 'alice@example.com',
      password: 'Password123',
      communityRulesAccepted: true,
    });

    const aliceLogin = await request(app).post('/api/auth/login').send({
      email: 'alice@example.com',
      password: 'Password123',
    });

    const response = await request(app)
      .post('/api/conversations')
      .set('Cookie', getCookieHeader(aliceLogin))
      .send({ participantId: 'missing-user' });

    expect(response.status).toBe(404);
  });

  it('creates a group conversation with all requested participants', async () => {
    for (const user of [
      { name: 'Alice', email: 'alice@example.com' },
      { name: 'Bob', email: 'bob@example.com' },
      { name: 'Cara', email: 'cara@example.com' },
    ]) {
      await request(app).post('/api/auth/register').send({
        ...user,
        password: 'Password123',
        communityRulesAccepted: true,
      });
    }

    const aliceLogin = await request(app).post('/api/auth/login').send({
      email: 'alice@example.com',
      password: 'Password123',
    });
    const users = (await request(app).get('/api/users')).body.users as { id: string; name: string }[];
    const bob = users.find((user) => user.name === 'Bob')!;
    const cara = users.find((user) => user.name === 'Cara')!;

    const created = await request(app)
      .post('/api/conversations')
      .set('Cookie', getCookieHeader(aliceLogin))
      .send({ participantIds: [bob.id, cara.id], name: 'Volunteer Team' });
    const details = await request(app)
      .get(`/api/conversations/${created.body.conversation.id}`)
      .set('Cookie', getCookieHeader(aliceLogin));

    expect(created.status).toBe(201);
    expect(details.body.conversation.participants.map((participant: { userId: string }) => participant.userId).sort())
      .toEqual([aliceLogin.body.user.id, bob.id, cara.id].sort());
  });

  it('prevents sending to a group member who has blocked the sender', async () => {
    for (const user of [
      { name: 'Alice', email: 'alice@example.com' },
      { name: 'Bob', email: 'bob@example.com' },
      { name: 'Cara', email: 'cara@example.com' },
    ]) {
      await request(app).post('/api/auth/register').send({
        ...user,
        password: 'Password123',
        communityRulesAccepted: true,
      });
    }

    const aliceLogin = await request(app).post('/api/auth/login').send({
      email: 'alice@example.com',
      password: 'Password123',
    });
    const caraLogin = await request(app).post('/api/auth/login').send({
      email: 'cara@example.com',
      password: 'Password123',
    });
    const users = (await request(app).get('/api/users')).body.users as { id: string; name: string }[];
    const bob = users.find((user) => user.name === 'Bob')!;
    const cara = users.find((user) => user.name === 'Cara')!;
    const created = await request(app)
      .post('/api/conversations')
      .set('Cookie', getCookieHeader(aliceLogin))
      .send({ participantIds: [bob.id, cara.id] });

    await request(app)
      .post(`/api/users/${aliceLogin.body.user.id}/block`)
      .set('Cookie', getCookieHeader(caraLogin));
    const response = await request(app)
      .post(`/api/conversations/${created.body.conversation.id}/messages`)
      .set('Cookie', getCookieHeader(aliceLogin))
      .send({ text: 'A group update' });

    expect(response.status).toBe(403);
  });

  it('report requires authentication', async () => {
    const response = await request(app).post('/api/reports').send({
      targetType: 'post',
      targetId: 'missing',
      category: 'SPAM',
      reason: 'This is spam',
    });

    expect(response.status).toBe(401);
  });
});

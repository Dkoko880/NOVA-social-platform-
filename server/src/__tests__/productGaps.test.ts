import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { fallbackStore } from '../lib/fallbackStore.js';
import { socialStore } from '../lib/socialStore.js';
import { clearCommand2AStores } from '../lib/platform.js';

function cookie(response: { headers: Record<string, string | string[] | undefined> }) {
  const value = response.headers['set-cookie'];
  return Array.isArray(value) ? value.join('; ') : value ?? '';
}

async function register(name: string) {
  const email = `${name.toLowerCase()}@example.com`;
  await request(app).post('/api/auth/register').send({ name, email, password: 'Password123', communityRulesAccepted: true });
  const login = await request(app).post('/api/auth/login').send({ email, password: 'Password123' });
  const users = await request(app).get('/api/users');
  return { auth: cookie(login), user: users.body.users.find((entry: { email: string }) => entry.email === email) };
}

describe('product area gaps', () => {
  beforeEach(() => {
    fallbackStore.clear();
    socialStore.clear();
    clearCommand2AStores();
  });

  it('supports structured messages, replies, edits, reactions, search, gallery, and chat controls', async () => {
    const alice = await register('GapAlice');
    const bob = await register('GapBob');
    const conversation = await request(app).post('/api/conversations').set('Cookie', alice.auth).send({ participantId: bob.user.id });
    const conversationId = conversation.body.conversation.id;

    const image = await request(app).post(`/api/conversations/${conversationId}/messages`).set('Cookie', alice.auth).send({ contentType: 'IMAGE', mediaUrl: 'https://example.com/photo.jpg', text: 'garden' });
    expect(image.status).toBe(201);
    expect(image.body.message.contentType).toBe('IMAGE');
    const reply = await request(app).post(`/api/conversations/${conversationId}/messages`).set('Cookie', bob.auth).send({ text: 'Nice photo', replyToId: image.body.message.id });
    expect(reply.body.message.replyToId).toBe(image.body.message.id);

    const edited = await request(app).patch(`/api/messages/${reply.body.message.id}`).set('Cookie', bob.auth).send({ text: 'Really nice photo' });
    expect(edited.body.message.text).toBe('Really nice photo');
    expect(edited.body.message.editedAt).toBeTruthy();
    const reacted = await request(app).post(`/api/messages/${image.body.message.id}/reactions`).set('Cookie', bob.auth).send({ type: '❤️' });
    expect(reacted.body.reactions).toHaveLength(1);
    expect((await request(app).get('/api/messages/search?q=Really%20nice').set('Cookie', alice.auth)).body.messages).toHaveLength(1);
    expect((await request(app).get(`/api/conversations/${conversationId}/media`).set('Cookie', bob.auth)).body.media).toHaveLength(1);

    const preferences = await request(app).patch(`/api/conversations/${conversationId}/preferences`).set('Cookie', alice.auth).send({ pinned: true, archived: true, starred: true, disappearingAfterSeconds: 3600 });
    expect(preferences.status).toBe(200);
    const expiring = await request(app).post(`/api/conversations/${conversationId}/messages`).set('Cookie', alice.auth).send({ text: 'This will disappear' });
    expect(Date.parse(expiring.body.message.expiresAt)).toBeGreaterThan(Date.now());

    const charlie = await register('GapCharlie');
    const destination = await request(app).post('/api/conversations').set('Cookie', alice.auth).send({ participantId: charlie.user.id });
    const forwarded = await request(app).post(`/api/messages/${image.body.message.id}/forward`).set('Cookie', alice.auth).send({ conversationId: destination.body.conversation.id });
    expect(forwarded.status).toBe(201);
    expect(forwarded.body.message.forwardedFromId).toBe(image.body.message.id);
    expect((await request(app).post(`/api/messages/${image.body.message.id}/report`).set('Cookie', bob.auth).send({ category: 'SPAM', reason: 'Unwanted promotional content.' })).status).toBe(201);
  });

  it('enforces channel posting and group member administration', async () => {
    const owner = await register('GapOwner');
    const moderator = await register('GapModerator');
    const guest = await register('GapGuest');
    const created = await request(app).post('/api/conversations').set('Cookie', owner.auth).send({ participantIds: [moderator.user.id], isChannel: true, name: 'Updates' });
    const channelId = created.body.conversation.id;
    expect((await request(app).post(`/api/conversations/${channelId}/messages`).set('Cookie', moderator.auth).send({ text: 'Unauthorized update' })).status).toBe(403);
    expect((await request(app).post(`/api/conversations/${channelId}/participants`).set('Cookie', owner.auth).send({ participantIds: [guest.user.id] })).status).toBe(201);
    expect((await request(app).patch(`/api/conversations/${channelId}/participants/${moderator.user.id}`).set('Cookie', owner.auth).send({ role: 'MODERATOR' })).status).toBe(200);
    expect((await request(app).post(`/api/conversations/${channelId}/messages`).set('Cookie', moderator.auth).send({ text: 'Official update' })).status).toBe(201);
    expect((await request(app).delete(`/api/conversations/${channelId}/participants/${guest.user.id}`).set('Cookie', moderator.auth)).status).toBe(200);
  });

  it('supports private community channels through invitation-only membership', async () => {
    const owner = await register('PrivateSpaceOwner');
    const member = await register('PrivateSpaceMember');
    const created = await request(app).post('/api/communities').set('Cookie', owner.auth).send({ name: 'Private Updates', type: 'CHANNEL', isPrivate: true });
    expect(created.body.community.type).toBe('CHANNEL');
    expect(created.body.community.isPrivate).toBe(true);
    expect((await request(app).get('/api/communities').set('Cookie', member.auth)).body.communities).toHaveLength(0);
    expect((await request(app).post(`/api/communities/${created.body.community.id}/join`).set('Cookie', member.auth)).status).toBe(403);
    expect((await request(app).post(`/api/communities/${created.body.community.id}/invites`).set('Cookie', owner.auth).send({ userId: member.user.id })).status).toBe(201);
    const detail = await request(app).get(`/api/communities/${created.body.community.id}`).set('Cookie', member.auth);
    expect(detail.body.community.joined).toBe(true);
    expect((await request(app).delete(`/api/communities/${created.body.community.id}/members/${member.user.id}`).set('Cookie', owner.auth)).status).toBe(200);
  });

  it('refuses to create a group call when no real media/signaling service exists', async () => {
    const caller = await register('CallCaller');
    const one = await register('CallOne');
    const two = await register('CallTwo');
    const started = await request(app).post('/api/calls/start').set('Cookie', caller.auth).send({ targetUserIds: [one.user.id, two.user.id], type: 'video' });
    expect(started.status).toBe(503);
    expect(started.body.message).toMatch(/media and signaling/i);
    expect((await request(app).get('/api/calls/history').set('Cookie', caller.auth)).body.calls).toHaveLength(0);
  });

  it('does not create a live session or viewers without real media service', async () => {
    const host = await register('LiveHost');
    const viewer = await register('LiveGuest');
    const created = await request(app).post('/api/live/create').set('Cookie', host.auth).send({ title: 'Community stream' });
    expect(created.status).toBe(503);
    expect(created.body.message).toMatch(/real-time media/i);
    expect((await request(app).get('/api/live').set('Cookie', viewer.auth)).body.lives).toHaveLength(0);
  });
});

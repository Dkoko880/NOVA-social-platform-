import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import sharp from 'sharp';
import { app } from '../app.js';
import { fallbackStore } from '../lib/fallbackStore.js';
import { socialStore } from '../lib/socialStore.js';

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

describe('authenticated media uploads', () => {
  beforeEach(() => {
    fallbackStore.clear();
    socialStore.clear();
  });

  it('validates, stores, and serves owned images only to their owner or authorized story viewers', async () => {
    const alice = await register('MediaAlice');
    const bob = await register('MediaBob');
    const carol = await register('MediaCarol');
    const image = await sharp({
      create: { width: 4, height: 4, channels: 3, background: '#3756a8' },
    }).png().toBuffer();

    expect((await request(app).post('/api/media/uploads').attach('file', image, { filename: 'avatar.svg', contentType: 'image/svg+xml' }).set('Cookie', alice.auth)).status).toBe(400);
    expect((await request(app).post('/api/media/uploads').attach('file', image, { filename: 'image.png', contentType: 'image/png' })).status).toBe(401);
    expect((await request(app)
      .post('/api/media/uploads')
      .set('Cookie', alice.auth)
      .attach('file', Buffer.alloc(10 * 1024 * 1024 + 1), { filename: 'large.png', contentType: 'image/png' })).status).toBe(413);

    const upload = await request(app)
      .post('/api/media/uploads')
      .set('Cookie', alice.auth)
      .attach('file', image, { filename: 'story.png', contentType: 'image/png' });
    expect(upload.status).toBe(201);
    expect(upload.body.contentType).toBe('image/webp');

    const key = upload.body.mediaUrl.split('/').at(-1);
    expect((await request(app).get(upload.body.mediaUrl).set('Cookie', alice.auth)).status).toBe(200);
    expect((await request(app).get(upload.body.mediaUrl)).status).toBe(404);
    expect((await request(app).get(upload.body.mediaUrl).set('Cookie', bob.auth)).status).toBe(404);
    expect((await request(app).post('/api/stories').set('Cookie', bob.auth).send({ mediaUrl: upload.body.mediaUrl })).status).toBe(403);

    const story = await request(app).post('/api/stories').set('Cookie', alice.auth).send({ mediaUrl: upload.body.mediaUrl });
    expect(story.status).toBe(201);
    expect((await request(app).get(`/api/media/avatars/${key}`).set('Cookie', bob.auth)).status).toBe(404);

    await request(app).post(`/api/users/${alice.user.id}/follow`).set('Cookie', bob.auth);
    expect((await request(app).get(`/api/media/avatars/${key}`).set('Cookie', bob.auth)).status).toBe(200);

    const messageUpload = await request(app)
      .post('/api/media/uploads')
      .set('Cookie', alice.auth)
      .attach('file', image, { filename: 'message.png', contentType: 'image/png' });
    expect(messageUpload.status).toBe(201);
    const conversation = await request(app).post('/api/conversations').set('Cookie', alice.auth).send({ participantId: carol.user.id });
    const sent = await request(app)
      .post(`/api/conversations/${conversation.body.conversation.id}/messages`)
      .set('Cookie', alice.auth)
      .send({ contentType: 'IMAGE', mediaUrl: messageUpload.body.mediaUrl });
    expect(sent.status).toBe(201);
    expect((await request(app).get(messageUpload.body.mediaUrl).set('Cookie', carol.auth)).status).toBe(200);
    expect((await request(app).get(messageUpload.body.mediaUrl).set('Cookie', bob.auth)).status).toBe(404);
  });
});

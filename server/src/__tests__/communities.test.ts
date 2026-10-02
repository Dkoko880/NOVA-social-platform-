import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { fallbackStore } from '../lib/fallbackStore.js';
import { socialStore } from '../lib/socialStore.js';

function cookie(response: { headers: Record<string, string | string[] | undefined> }) {
  const value = response.headers['set-cookie'];
  return Array.isArray(value) ? value.join('; ') : value ?? '';
}

async function register(name: string) {
  const email = `${name.toLowerCase()}@example.com`;
  const result = await request(app).post('/api/auth/register').send({ name, email, password: 'Password123', communityRulesAccepted: true });
  const login = await request(app).post('/api/auth/login').send({ email, password: 'Password123' });
  return { user: result.body.user, auth: cookie(login) };
}

describe('community management', () => {
  beforeEach(() => {
    fallbackStore.clear();
    socialStore.clear();
  });

  it('creates communities and enforces membership, moderator, and announcement permissions', async () => {
    const owner = await register('CommunityOwner');
    const member = await register('CommunityMember');
    const created = await request(app).post('/api/communities').set('Cookie', owner.auth).send({ name: 'Garden Club', description: 'Local growers' });
    expect(created.status).toBe(201);
    expect(created.body.community.myRole).toBe('OWNER');

    const joined = await request(app).post(`/api/communities/${created.body.community.id}/join`).set('Cookie', member.auth);
    expect(joined.status).toBe(201);
    expect((await request(app).post(`/api/communities/${created.body.community.id}/announcements`).set('Cookie', member.auth).send({ content: 'Meet this weekend.' })).status).toBe(403);

    const promoted = await request(app).patch(`/api/communities/${created.body.community.id}/members/${member.user.id}`).set('Cookie', owner.auth).send({ role: 'MODERATOR' });
    expect(promoted.status).toBe(200);
    const announcement = await request(app).post(`/api/communities/${created.body.community.id}/announcements`).set('Cookie', member.auth).send({ content: 'Meet this weekend.' });
    expect(announcement.status).toBe(201);
    expect((await request(app).get(`/api/communities/${created.body.community.id}`).set('Cookie', owner.auth)).body.community.posts).toHaveLength(1);
  });

  it('allows moderators to invite members and accepts community reports', async () => {
    const owner = await register('InviteOwner');
    const member = await register('InvitedMember');
    const reporter = await register('CommunityReporter');
    const created = await request(app).post('/api/communities').set('Cookie', owner.auth).send({ name: 'Book Circle' });
    const invited = await request(app).post(`/api/communities/${created.body.community.id}/invites`).set('Cookie', owner.auth).send({ userId: member.user.id });
    expect(invited.status).toBe(201);
    expect((await request(app).get('/api/communities').set('Cookie', member.auth)).body.communities[0].joined).toBe(true);
    const report = await request(app).post(`/api/communities/${created.body.community.id}/report`).set('Cookie', reporter.auth).send({ category: 'SPAM', reason: 'Repeated unwanted promotional posts.' });
    expect(report.status).toBe(201);
  });
});
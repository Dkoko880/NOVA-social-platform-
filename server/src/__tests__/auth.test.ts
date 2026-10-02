import { describe, expect, it, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { fallbackStore } from '../lib/fallbackStore.js';
import { clearPhoneLoginChallengesForTests } from '../routes/auth.js';

describe('auth routes', () => {
  beforeEach(() => {
    fallbackStore.clear();
    clearPhoneLoginChallengesForTests();
  });

  it('registers a new user and sets an http-only session cookie', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Nova User',
        email: 'nova@example.com',
        password: 'Password123',
        communityRulesAccepted: true,
      });

    expect(response.status).toBe(201);
    expect(response.body.user.email).toBe('nova@example.com');
    expect(String(response.headers['set-cookie'])).toContain('nova_session=');
    expect(response.body).not.toHaveProperty('token');
  });

  it('logs in an existing user', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Nova User',
        email: 'login@example.com',
        password: 'Password123',
        communityRulesAccepted: true,
      });

    const response = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'login@example.com',
        password: 'Password123',
      });

    expect(response.status).toBe(200);
    expect(response.body.user.email).toBe('login@example.com');
    expect(String(response.headers['set-cookie'])).toContain('nova_session=');
    expect(response.body).not.toHaveProperty('token');
  });

  it('requires community safety rules acceptance during registration', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Nova User',
        email: 'community@example.com',
        password: 'Password123',
        communityRulesAccepted: false,
      });

    expect(response.status).toBe(400);
    expect(response.body.message).toContain('Community & Safety Rules');
  });

  it('rejects explicit sexual content in posts', async () => {
    const register = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Nova User',
        email: 'safety@example.com',
        password: 'Password123',
        communityRulesAccepted: true,
      });

    const response = await request(app)
      .post('/api/posts')
      .set('Cookie', register.headers['set-cookie'])
      .send({
        content: 'This is explicit sexual content and should be blocked.',
      });

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/community.*safety.*rules|violates/i);
  });

  it('returns an error for invalid credentials', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'missing@example.com',
        password: 'Password123',
      });

    expect(response.status).toBe(401);
    expect(response.body.message).toBe('Invalid email or password.');
  });

  it('logs in a verified phone account with a one-time OTP and establishes a session', async () => {
    fallbackStore.create({
      email: null,
      name: 'Phone User',
      passwordHash: '',
      role: 'USER',
      status: 'ACTIVE',
      communityRulesAccepted: true,
      communityRulesAcceptedAt: new Date().toISOString(),
      rulesVersion: null,
      phoneE164: '+2348031234567',
      phoneVerifiedAt: new Date().toISOString(),
    });

    const started = await request(app).post('/api/auth/phone/start').send({ countryCode: 'NG', phone: '08031234567' });
    expect(started.status).toBe(202);
    expect(started.body).not.toHaveProperty('code');

    const verified = await request(app).post('/api/auth/phone/verify').send({ challengeId: started.body.challengeId, code: '123456' });
    expect(verified.status).toBe(200);
    expect(verified.body.user.phoneE164).toBe('+2348031234567');
    expect(verified.body).not.toHaveProperty('token');
    expect(String(verified.headers['set-cookie'])).toContain('nova_session=');

    const currentUser = await request(app).get('/api/auth/me').set('Cookie', verified.headers['set-cookie']);
    expect(currentUser.status).toBe(200);
    expect(currentUser.body.user.id).toBe(verified.body.user.id);

    const replay = await request(app).post('/api/auth/phone/verify').send({ challengeId: started.body.challengeId, code: '123456' });
    expect(replay.status).toBe(401);
  });

  it('uses the same phone-login response for known and unknown phone numbers', async () => {
    fallbackStore.create({
      email: null,
      name: 'Phone User',
      passwordHash: '',
      role: 'USER',
      status: 'ACTIVE',
      communityRulesAccepted: true,
      communityRulesAcceptedAt: new Date().toISOString(),
      rulesVersion: null,
      phoneE164: '+2348031234567',
      phoneVerifiedAt: new Date().toISOString(),
    });

    const known = await request(app).post('/api/auth/phone/start').send({ countryCode: 'NG', phone: '08031234567' });
    const unknown = await request(app).post('/api/auth/phone/start').send({ countryCode: 'NG', phone: '08031234568' });

    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(known.body.message).toBe(unknown.body.message);
    expect(known.body).not.toHaveProperty('userExists');
  });

  it('locks phone OTP verification after five incorrect attempts', async () => {
    const started = await request(app).post('/api/auth/phone/start').send({ countryCode: 'NG', phone: '08031234569' });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const invalid = await request(app).post('/api/auth/phone/verify').send({ challengeId: started.body.challengeId, code: '000000' });
      expect(invalid.status).toBe(401);
    }

    const locked = await request(app).post('/api/auth/phone/verify').send({ challengeId: started.body.challengeId, code: '000000' });
    expect(locked.status).toBe(429);
    const correctAfterLock = await request(app).post('/api/auth/phone/verify').send({ challengeId: started.body.challengeId, code: '123456' });
    expect(correctAfterLock.status).toBe(401);
  });

  it('lists sessions and supports per-device revocation and logout-all', async () => {
    const registration = await request(app).post('/api/auth/register').send({
      name: 'Session User',
      email: 'sessions@example.com',
      password: 'Password123',
      communityRulesAccepted: true,
    });
    const login = await request(app).post('/api/auth/login').send({ email: 'sessions@example.com', password: 'Password123' });
    const cookie = login.headers['set-cookie'];

    const listed = await request(app).get('/api/auth/sessions').set('Cookie', cookie);
    expect(listed.status).toBe(200);
    expect(listed.body.sessions).toHaveLength(2);
    expect(listed.body.sessions[0]).not.toHaveProperty('tokenHash');

    const registrationSession = listed.body.sessions.find((session: { id: string }) => session.id !== listed.body.sessions[0].id);
    const revoked = await request(app).delete(`/api/auth/sessions/${registrationSession.id}`).set('Cookie', cookie);
    expect(revoked.status).toBe(200);
    expect((await request(app).get('/api/auth/me').set('Cookie', registration.headers['set-cookie'])).status).toBe(401);
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).status).toBe(200);

    const logoutAll = await request(app).post('/api/auth/logout-all').set('Cookie', cookie);
    expect(logoutAll.status).toBe(200);
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).status).toBe(401);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import sharp from 'sharp';
import { app } from '../app.js';
import { fallbackStore } from '../lib/fallbackStore.js';
import { clearRegistrationStateForTests } from '../routes/registration.js';
import { socialStore } from '../lib/socialStore.js';

function cookieHeader(response: { headers: Record<string, string | string[] | undefined> }) {
  const setCookie = response.headers['set-cookie'];
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return cookies.map((cookie) => cookie.split(';')[0]).join('; ');
}

async function startRegistration(phone = '08031234567') {
  return request(app).post('/api/auth/register/start').send({
    countryCode: 'NG',
    phone,
    fullName: 'NOVA Test User',
  });
}

async function verifyRegistration(challengeId: string) {
  return request(app).post('/api/auth/register/verify').send({ challengeId, code: '123456' });
}

async function completeStages(cookie: string, username = 'Nova_Test_1') {
  const stageTwo = await request(app)
    .patch('/api/auth/register/stage/2')
    .set('Cookie', cookie)
    .send({
      dateOfBirth: '1990-01-01',
      countryCode: 'NG',
      region: 'Lagos',
      city: 'Ikeja',
      address: '12 Private Road',
    });
  expect(stageTwo.status).toBe(200);

  const stageThree = await request(app)
    .patch('/api/auth/register/stage/3')
    .set('Cookie', cookie)
    .send({ skipAvatar: true });
  expect(stageThree.status).toBe(200);

  const stageFour = await request(app)
    .patch('/api/auth/register/stage/4')
    .set('Cookie', cookie)
    .send({ username, termsAccepted: true, privacyAccepted: true, guidelinesAccepted: true });
  expect(stageFour.status).toBe(200);
  return request(app).post('/api/auth/register/complete').set('Cookie', cookie);
}

describe('phone-first registration', () => {
  beforeEach(() => {
    fallbackStore.clear();
    socialStore.clear();
    clearRegistrationStateForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('completes all five stages and creates one verified phone account', async () => {
    const start = await startRegistration();
    expect(start.status).toBe(202);
    expect(start.body.deliveryMode).toBe('development');
    expect(start.body).not.toHaveProperty('code');

    const verify = await verifyRegistration(start.body.challengeId);
    expect(verify.status).toBe(200);
    expect(verify.body.stage).toBe(2);
    expect(verify.body).not.toHaveProperty('registrationToken');
    const cookie = cookieHeader(verify);
    expect(cookie).toContain('nova_registration=');

    const complete = await completeStages(cookie);
    expect(complete.status).toBe(201);
    expect(complete.body.user.phoneE164).toBe('+2348031234567');
    expect(complete.body.user.email).toBeNull();
    expect(complete.body).not.toHaveProperty('token');
    expect(complete.body.user).not.toHaveProperty('dateOfBirth');
    expect(JSON.stringify(complete.body)).not.toContain('12 Private Road');
    expect(fallbackStore.list()).toHaveLength(1);
    expect(cookieHeader(complete)).toContain('nova_session=');
  });

  it('rejects a malformed international phone number', async () => {
    const response = await startRegistration('not-a-phone');
    expect(response.status).toBe(400);
  });

  it('rejects invalid or underage dates before saving stage 2', async () => {
    const start = await startRegistration();
    const verify = await verifyRegistration(start.body.challengeId);
    const response = await request(app)
      .patch('/api/auth/register/stage/2')
      .set('Cookie', cookieHeader(verify))
      .send({ dateOfBirth: '2018-02-31', countryCode: 'NG', region: 'Lagos', city: 'Ikeja', address: '12 Private Road' });
    expect(response.status).toBe(400);
  });

  it('rejects unauthorized access to private registration stages', async () => {
    const response = await request(app)
      .patch('/api/auth/register/stage/2')
      .send({ dateOfBirth: '1990-01-01', countryCode: 'NG', region: 'Lagos', city: 'Ikeja', address: '12 Private Road' });
    expect(response.status).toBe(401);
  });

  it('rejects expired OTPs and single-use OTP reuse', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
    const start = await startRegistration();
    vi.setSystemTime(new Date('2026-10-01T12:11:00Z'));
    const expired = await verifyRegistration(start.body.challengeId);
    expect(expired.status).toBe(400);

    vi.useRealTimers();
    clearRegistrationStateForTests();
    const next = await startRegistration();
    const firstUse = await verifyRegistration(next.body.challengeId);
    const reuse = await verifyRegistration(next.body.challengeId);
    expect(firstUse.status).toBe(200);
    expect(reuse.status).toBe(400);
  });

  it('locks OTP verification after five incorrect attempts', async () => {
    const start = await startRegistration();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const invalid = await request(app).post('/api/auth/register/verify').send({ challengeId: start.body.challengeId, code: '000000' });
      expect(invalid.status).toBe(400);
    }
    const locked = await request(app).post('/api/auth/register/verify').send({ challengeId: start.body.challengeId, code: '000000' });
    expect(locked.status).toBe(429);
    const correctAfterLock = await verifyRegistration(start.body.challengeId);
    expect(correctAfterLock.status).toBe(429);
  });

  it('applies resend cooldown and allows resend after the cooldown', async () => {
    const start = await startRegistration();
    const tooSoon = await request(app).post('/api/auth/register/resend').send({ challengeId: start.body.challengeId });
    expect(tooSoon.status).toBe(429);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 61_000));
    const resent = await request(app).post('/api/auth/register/resend').send({ challengeId: start.body.challengeId });
    expect(resent.status).toBe(200);
  });

  it('does not reveal whether a phone is already registered', async () => {
    const start = await startRegistration();
    const verified = await verifyRegistration(start.body.challengeId);
    await completeStages(cookieHeader(verified));
    const duplicate = await startRegistration();
    expect(duplicate.status).toBe(202);
    expect(duplicate.body.message).toBe(start.body.message);
    const invalid = await verifyRegistration(duplicate.body.challengeId);
    expect(invalid.status).toBe(400);
    expect(fallbackStore.list()).toHaveLength(1);
  });

  it('normalizes usernames, blocks reserved names, and requires every consent', async () => {
    const start = await startRegistration();
    const verified = await verifyRegistration(start.body.challengeId);
    const cookie = cookieHeader(verified);
    await request(app).patch('/api/auth/register/stage/2').set('Cookie', cookie).send({
      dateOfBirth: '1990-01-01', countryCode: 'NG', region: 'Lagos', city: 'Ikeja', address: '12 Private Road',
    });
    await request(app).patch('/api/auth/register/stage/3').set('Cookie', cookie).send({ skipAvatar: true });

    const unavailable = await request(app).get('/api/auth/register/username-availability?username=SUPPORT');
    expect(unavailable.body.available).toBe(false);
    const missingConsent = await request(app).patch('/api/auth/register/stage/4').set('Cookie', cookie).send({
      username: 'NOVA_Test_1', termsAccepted: true, privacyAccepted: true, guidelinesAccepted: false,
    });
    expect(missingConsent.status).toBe(400);
    const accepted = await request(app).patch('/api/auth/register/stage/4').set('Cookie', cookie).send({
      username: 'NOVA_Test_1', termsAccepted: true, privacyAccepted: true, guidelinesAccepted: true,
    });
    expect(accepted.status).toBe(200);
    const complete = await request(app).post('/api/auth/register/complete').set('Cookie', cookie);
    expect(complete.status).toBe(201);
    expect(fallbackStore.list()[0].username).toBe('nova_test_1');
  });

  it('re-encodes valid avatars and rejects spoofed or malformed uploads', async () => {
    const start = await startRegistration();
    const verified = await verifyRegistration(start.body.challengeId);
    const cookie = cookieHeader(verified);
    await request(app).patch('/api/auth/register/stage/2').set('Cookie', cookie).send({
      dateOfBirth: '1990-01-01', countryCode: 'NG', region: 'Lagos', city: 'Ikeja', address: '12 Private Road',
    });
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#fff' } }).png().toBuffer();
    const uploaded = await request(app).post('/api/auth/register/avatar').set('Cookie', cookie).attach('avatar', png, { filename: '../avatar.png', contentType: 'image/png' });
    expect(uploaded.status).toBe(200);
    expect(uploaded.body.avatarUrl).toMatch(/^\/api\/media\/avatars\/[0-9a-f-]+\.webp$/);
    expect((await request(app).get(uploaded.body.avatarUrl)).status).toBe(404);
    await request(app).patch('/api/auth/register/stage/4').set('Cookie', cookie).send({
      username: 'media_owner', termsAccepted: true, privacyAccepted: true, guidelinesAccepted: true,
    });
    const completed = await request(app).post('/api/auth/register/complete').set('Cookie', cookie);
    expect(completed.status).toBe(201);
    expect((await request(app).get(uploaded.body.avatarUrl).set('Cookie', cookieHeader(completed))).status).toBe(200);

    const another = await startRegistration('08031234568');
    const nextVerified = await verifyRegistration(another.body.challengeId);
    const nextCookie = cookieHeader(nextVerified);
    await request(app).patch('/api/auth/register/stage/2').set('Cookie', nextCookie).send({
      dateOfBirth: '1990-01-01', countryCode: 'NG', region: 'Lagos', city: 'Ikeja', address: '12 Private Road',
    });
    const malicious = await request(app).post('/api/auth/register/avatar').set('Cookie', nextCookie).attach('avatar', Buffer.from('<script>bad()</script>'), { filename: 'avatar.png', contentType: 'image/png' });
    expect(malicious.status).toBe(400);
  });
});
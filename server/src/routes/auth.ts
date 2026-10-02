import { Router } from 'express';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import env from '../config/env.js';
import { hashPassword, hashSessionToken, sanitizeUser, signAccessToken, verifyPassword } from '../lib/auth.js';
import { createUser, fallbackStore, getUserByEmail } from '../lib/fallbackStore.js';
import { getOtpProvider, OtpProviderUnavailableError } from '../lib/otpProvider.js';
import { prisma, isDatabaseAvailable } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';

const registerSchema = z.object({
  name: z.string().min(2).max(100),
  email: z.string().email(),
  password: z.string().min(8).max(128),
  communityRulesAccepted: z.boolean().refine((value) => value === true, {
    message: 'You must accept the NOVA Community & Safety Rules before creating an account.',
  }),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
});

const phoneLoginStartSchema = z.object({
  countryCode: z.string().length(2).transform((value) => value.toUpperCase()),
  phone: z.string().trim().min(5).max(40),
});

const phoneLoginVerifySchema = z.object({ challengeId: z.string().uuid(), code: z.string().regex(/^\d{6}$/) });
const phoneLoginOtpHash = (id: string, code: string) => createHmac('sha256', env.JWT_SECRET).update(`login:${id}:${code}`).digest('hex');
type MemoryPhoneLoginChallenge = { id: string; phoneE164: string; otpHash: string; expiresAt: Date; attempts: number; userId: string | null; consumedAt: Date | null; createdAt: Date };
const memoryPhoneLoginChallenges = new Map<string, MemoryPhoneLoginChallenge>();

export function clearPhoneLoginChallengesForTests() {
  memoryPhoneLoginChallenges.clear();
}

export const authRouter = Router();

async function getUserRecordByEmail(email: string) {
  const dbAvailable = await isDatabaseAvailable();
  if (dbAvailable) {
    return prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        name: true,
        passwordHash: true,
        role: true,
        status: true,
      },
    });
  }

  return getUserByEmail(email);
}

async function persistUser(record: {
  email: string;
  name: string;
  passwordHash: string;
  role?: string;
  status?: string;
  communityRulesAccepted?: boolean;
  communityRulesAcceptedAt?: string | null;
  rulesVersion?: string | null;
}) {
  const dbAvailable = await isDatabaseAvailable();

  if (dbAvailable) {
    return prisma.user.create({
      data: {
        email: record.email,
        name: record.name,
        passwordHash: record.passwordHash,
        role: (record.role as 'USER' | 'MODERATOR' | 'ADMIN' | 'SUPER_ADMIN') ?? 'USER',
        status: (record.status as 'ACTIVE' | 'SUSPENDED' | 'BANNED' | 'DEACTIVATED') ?? 'ACTIVE',
        communityRulesAccepted: Boolean(record.communityRulesAccepted),
        communityRulesAcceptedAt: record.communityRulesAcceptedAt ? new Date(record.communityRulesAcceptedAt) : null,
        rulesVersion: record.rulesVersion ?? 'nova-community-safety-v1',
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        status: true,
        communityRulesAccepted: true,
        communityRulesAcceptedAt: true,
        rulesVersion: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  return createUser({
    email: record.email,
    name: record.name,
    passwordHash: record.passwordHash,
    role: (record.role as 'USER' | 'MODERATOR' | 'ADMIN' | 'SUPER_ADMIN') ?? 'USER',
    status: (record.status as 'ACTIVE' | 'SUSPENDED' | 'BANNED' | 'DEACTIVATED') ?? 'ACTIVE',
    communityRulesAccepted: Boolean(record.communityRulesAccepted),
    communityRulesAcceptedAt: record.communityRulesAcceptedAt ?? (record.communityRulesAccepted ? new Date().toISOString() : null),
    rulesVersion: record.rulesVersion ?? 'nova-community-safety-v1',
  });
}

function buildAuthResponse(res: any, user: { id: string; email: string | null; name: string; role: string; status: string }, token: string) {
  res.cookie(env.COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: env.COOKIE_SAME_SITE,
    secure: env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  const safeUser = sanitizeUser(user);
  return res.status(201).json({
    user: safeUser,
  });
}

async function persistSession(req: any, userId: string, token: string) {
  const session = {
    userId,
    tokenHash: hashSessionToken(token),
    userAgent: req.get('user-agent')?.slice(0, 300) ?? null,
    deviceName: req.get('x-device-name')?.slice(0, 100) ?? null,
    ipAddress: req.ip ?? null,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    lastSeenAt: new Date(),
  };
  if (await isDatabaseAvailable()) {
    await prisma.session.create({ data: session });
    return;
  }
  fallbackStore.createSession({ ...session, expiresAt: session.expiresAt.toISOString(), lastSeenAt: session.lastSeenAt.toISOString() });
}

authRouter.post('/register', async (req, res, next) => {
  try {
    const payload = registerSchema.parse(req.body);
    const existingUser = await getUserRecordByEmail(payload.email);

    if (existingUser) {
      return res.status(409).json({ message: 'An account with this email already exists.' });
    }

    const passwordHash = await hashPassword(payload.password);
    const user = await persistUser({
      email: payload.email,
      name: payload.name,
      passwordHash,
      communityRulesAccepted: payload.communityRulesAccepted,
      communityRulesAcceptedAt: new Date().toISOString(),
      rulesVersion: 'nova-community-safety-v1',
    });

    const token = signAccessToken({
      sub: user.id,
      email: user.email,
      role: user.role,
    });

    await persistSession(req, user.id, token);

    return buildAuthResponse(res, user, token);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const hasCommunityRuleIssue = error.issues.some((issue) => issue.path.includes('communityRulesAccepted') || issue.message.toLowerCase().includes('community') || issue.message.toLowerCase().includes('safety'));

      if (hasCommunityRuleIssue) {
        return res.status(400).json({ message: 'You must accept the NOVA Community & Safety Rules before creating an account.' });
      }

      return res.status(400).json({ message: 'Invalid registration payload.', errors: error.flatten() });
    }

    return next(error);
  }
});

authRouter.post('/login', async (req, res, next) => {
  try {
    const payload = loginSchema.parse(req.body);
    const user = await getUserRecordByEmail(payload.email);

    if (!user || !(await verifyPassword(payload.password, user.passwordHash))) {
      return res.status(401).json({ message: 'Invalid email or password.' });
    }

    const token = signAccessToken({
      sub: user.id,
      email: user.email,
      role: user.role,
    });

    await persistSession(req, user.id, token);

    res.cookie(env.COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: env.COOKIE_SAME_SITE,
      secure: env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return res.json({
      user: sanitizeUser(user),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ message: 'Invalid login payload.', errors: error.flatten() });
    }

    return next(error);
  }
});

authRouter.post('/phone/start', async (req, res, next) => {
  try {
    const payload = phoneLoginStartSchema.parse(req.body ?? {});
    const parsedPhone = parsePhoneNumberFromString(payload.phone, payload.countryCode as CountryCode);
    if (!parsedPhone?.isValid() || (parsedPhone.country && parsedPhone.country !== payload.countryCode)) {
      return res.status(400).json({ message: 'Enter a valid phone number for the selected country.' });
    }
    const provider = getOtpProvider(env.NODE_ENV);
    const phoneE164 = parsedPhone.number;
    const dbAvailable = await isDatabaseAvailable();
    const user = dbAvailable
      ? await prisma.user.findUnique({ where: { phoneE164 }, select: { id: true } })
      : fallbackStore.list().find((entry) => entry.phoneE164 === phoneE164) ?? null;
    const latestChallenge = dbAvailable
      ? await prisma.authOtpChallenge.findFirst({ where: { phoneE164 }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } })
      : [...memoryPhoneLoginChallenges.values()].reverse().find((item) => item.phoneE164 === phoneE164 && item.expiresAt.getTime() > Date.now());
    const latestCreatedAt = latestChallenge?.createdAt.getTime();
    if (latestCreatedAt !== undefined && Date.now() - latestCreatedAt < 60_000) {
      return res.status(202).json({ message: 'If this number has an account, a verification code will be sent shortly.', deliveryMode: provider.mode });
    }

    const id = randomUUID();
    const code = provider.generateCode();
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    if (dbAvailable) {
      await prisma.authOtpChallenge.create({
        data: { id, phoneE164, otpHash: phoneLoginOtpHash(id, code), expiresAt, userId: user?.id ?? null },
      });
    } else {
      memoryPhoneLoginChallenges.set(id, { id, phoneE164, otpHash: phoneLoginOtpHash(id, code), expiresAt, attempts: 0, userId: user?.id ?? null, consumedAt: null, createdAt: new Date() });
    }
    if (user) await provider.sendCode(phoneE164, code);
    return res.status(202).json({ challengeId: id, message: 'If this number has an account, a verification code will be sent shortly.', deliveryMode: provider.mode });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ message: 'Invalid phone login request.' });
    if (error instanceof OtpProviderUnavailableError) return res.status(503).json({ message: 'Phone verification is temporarily unavailable.' });
    return next(error);
  }
});

authRouter.post('/phone/verify', async (req, res, next) => {
  try {
    const payload = phoneLoginVerifySchema.parse(req.body ?? {});
    const dbAvailable = await isDatabaseAvailable();
    const challenge = dbAvailable
      ? await prisma.authOtpChallenge.findUnique({ where: { id: payload.challengeId } })
      : memoryPhoneLoginChallenges.get(payload.challengeId) ?? null;
    if (!challenge || challenge.consumedAt || challenge.expiresAt <= new Date() || challenge.attempts >= 5) {
      return res.status(401).json({ message: 'Phone verification failed.' });
    }
    const submittedHash = Buffer.from(phoneLoginOtpHash(payload.challengeId, payload.code), 'hex');
    const savedHash = Buffer.from(challenge.otpHash, 'hex');
    const matches = submittedHash.length === savedHash.length && timingSafeEqual(submittedHash, savedHash);
    if (!matches) {
      const attemptedCount = challenge.attempts + 1;
      if (dbAvailable) {
        await prisma.authOtpChallenge.updateMany({ where: { id: challenge.id, consumedAt: null, attempts: { lt: 5 } }, data: { attempts: { increment: 1 } } });
      } else {
        challenge.attempts += 1;
      }
      return res.status(attemptedCount >= 5 ? 429 : 401).json({ message: 'Phone verification failed.' });
    }

    const now = new Date();
    let user = null as any;
    if (dbAvailable) {
      const result = await prisma.$transaction(async (tx) => {
        const claimed = await tx.authOtpChallenge.updateMany({
          where: { id: challenge.id, consumedAt: null, expiresAt: { gt: now }, attempts: { lt: 5 } },
          data: { consumedAt: now },
        });
        if (!claimed.count) return null;
        const account = challenge.userId ? await tx.user.findUnique({ where: { id: challenge.userId } }) : null;
        if (!account || account.status !== 'ACTIVE') return null;
        const token = signAccessToken({ sub: account.id, email: account.email, role: account.role });
        await tx.session.create({
          data: {
            userId: account.id,
            tokenHash: hashSessionToken(token),
            userAgent: req.get('user-agent')?.slice(0, 300) ?? null,
            deviceName: req.get('x-device-name')?.slice(0, 100) ?? null,
            ipAddress: req.ip ?? null,
            expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
            lastSeenAt: now,
          },
        });
        return { account, token };
      }, { isolationLevel: 'Serializable' });
      if (!result) return res.status(401).json({ message: 'Phone verification failed.' });
      user = result.account;
      res.cookie(env.COOKIE_NAME, result.token, {
        httpOnly: true,
        secure: env.NODE_ENV === 'production',
        sameSite: env.COOKIE_SAME_SITE,
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });
    } else {
      const memoryChallenge = memoryPhoneLoginChallenges.get(payload.challengeId)!;
      memoryPhoneLoginChallenges.delete(payload.challengeId);
      user = memoryChallenge.userId ? fallbackStore.findById(memoryChallenge.userId) : null;
      if (!user || user.status !== 'ACTIVE') return res.status(401).json({ message: 'Phone verification failed.' });
      const token = signAccessToken({ sub: user.id, email: user.email, role: user.role });
      await persistSession(req, user.id, token);
      res.cookie(env.COOKIE_NAME, token, {
        httpOnly: true,
        secure: env.NODE_ENV === 'production',
        sameSite: env.COOKIE_SAME_SITE,
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });
    }
    return res.json({ user: sanitizeUser(user) });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ message: 'Invalid phone verification request.' });
    return next(error);
  }
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const user = req.user;

  if (!user) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  return res.json({ user });
});

authRouter.post('/logout', async (req, res, next) => {
  try {
    const token = req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : req.cookies?.[env.COOKIE_NAME];
    if (token && await isDatabaseAvailable()) {
      await prisma.session.updateMany({
        where: { tokenHash: hashSessionToken(token), revokedAt: null },
        data: { revokedAt: new Date() },
      });
    } else if (token) {
      fallbackStore.revokeSessionByTokenHash(hashSessionToken(token));
    }
  res.clearCookie(env.COOKIE_NAME);
  return res.json({ message: 'Logged out successfully.' });
  } catch (error) {
    return next(error);
  }
});

authRouter.get('/sessions', requireAuth, async (req, res, next) => {
  try {
    if (!(await isDatabaseAvailable())) {
      const sessions = fallbackStore.listSessions(req.user!.id).map(({ id, userAgent, deviceName, ipAddress, createdAt, lastSeenAt, expiresAt }) => ({
        id, userAgent, deviceName, ipAddress, createdAt, lastSeenAt, expiresAt,
      }));
      return res.json({ sessions });
    }
    const sessions = await prisma.session.findMany({
      where: { userId: req.user!.id, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true, userAgent: true, deviceName: true, ipAddress: true, createdAt: true, lastSeenAt: true, expiresAt: true },
      orderBy: { createdAt: 'desc' },
    });
    return res.json({ sessions });
  } catch (error) {
    return next(error);
  }
});

authRouter.delete('/sessions/:id', requireAuth, async (req, res, next) => {
  try {
    if (await isDatabaseAvailable()) {
      const result = await prisma.session.updateMany({
        where: { id: String(req.params.id), userId: req.user!.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (!result.count) return res.status(404).json({ message: 'Session not found.' });
    } else if (!fallbackStore.revokeSession(String(req.params.id), req.user!.id)) {
      return res.status(404).json({ message: 'Session not found.' });
    }
    return res.json({ message: 'Session revoked.' });
  } catch (error) {
    return next(error);
  }
});

authRouter.post('/logout-all', requireAuth, async (req, res, next) => {
  try {
    if (await isDatabaseAvailable()) {
      await prisma.session.updateMany({
        where: { userId: req.user!.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    } else {
      fallbackStore.revokeAllSessions(req.user!.id);
    }
    res.clearCookie(env.COOKIE_NAME);
    return res.json({ message: 'All sessions have been logged out.' });
  } catch (error) {
    return next(error);
  }
});

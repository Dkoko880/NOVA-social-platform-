import { Router } from 'express';
import { z } from 'zod';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import env from '../config/env.js';
import { hashPassword, hashSessionToken, sanitizeUser, signAccessToken, verifyPassword } from '../lib/auth.js';
import { createUser, fallbackStore, getUserByEmail } from '../lib/fallbackStore.js';
import { prisma, isDatabaseAvailable } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';

const registerSchema = z.object({
  name: z.string().trim().min(2).max(100),
  username: z.string().trim().min(3).max(30).regex(/^[a-zA-Z0-9_]+$/).transform((value) => value.toLowerCase()).optional(),
  email: z.preprocess(
    (value) => typeof value === 'string' && !value.trim() ? undefined : value,
    z.string().trim().email().transform((value) => value.toLowerCase()).optional(),
  ),
  phone: z.preprocess(
    (value) => typeof value === 'string' && !value.trim() ? undefined : value,
    z.string().trim().min(5).max(40).optional().transform((value) => {
      if (!value) return undefined;
      const phone = parsePhoneNumberFromString(value);
      return phone?.isValid() ? phone.number : null;
    }),
  ).refine((value) => value !== null, 'Enter a valid phone number in international format.'),
  password: z.string().min(8).max(128),
  communityRulesAccepted: z.boolean().refine((value) => value === true, {
    message: 'You must accept the NOVA Community & Safety Rules before creating an account.',
  }),
}).refine((payload) => Boolean(payload.username || payload.email || payload.phone), {
  message: 'Choose a username, email address, or phone number for your account.',
});

const loginSchema = z.object({
  identifier: z.string().trim().min(3).max(254).optional(),
  email: z.string().trim().email().optional(),
  password: z.string().min(8).max(128),
}).refine((payload) => Boolean(payload.identifier || payload.email), {
  message: 'Enter your username, phone number, or email address.',
});

export const authRouter = Router();

async function getUserRecordByIdentifier(identifier: string) {
  const normalizedIdentifier = identifier.trim();
  const phone = normalizedIdentifier.startsWith('+')
    ? parsePhoneNumberFromString(normalizedIdentifier)
    : null;
  const lookup = phone?.isValid()
    ? { phoneE164: phone.number }
    : normalizedIdentifier.includes('@')
      ? { email: normalizedIdentifier.toLowerCase() }
      : { profile: { is: { username: { equals: normalizedIdentifier.toLowerCase(), mode: 'insensitive' as const } } } };

  const dbAvailable = await isDatabaseAvailable();
  if (dbAvailable) {
    return prisma.user.findFirst({
      where: lookup,
      select: {
        id: true,
        email: true,
        phoneE164: true,
        name: true,
        passwordHash: true,
        role: true,
        status: true,
      },
    });
  }

  if (phone?.isValid()) return fallbackStore.list().find((user) => user.phoneE164 === phone.number) ?? null;
  if (normalizedIdentifier.includes('@')) return getUserByEmail(normalizedIdentifier.toLowerCase());
  return fallbackStore.list().find((user) => user.username?.toLowerCase() === normalizedIdentifier.toLowerCase()) ?? null;
}

async function persistUser(record: {
  email: string | null;
  phoneE164?: string;
  username?: string;
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
        phoneE164: record.phoneE164,
        name: record.name,
        passwordHash: record.passwordHash,
        role: (record.role as 'USER' | 'MODERATOR' | 'ADMIN' | 'SUPER_ADMIN') ?? 'USER',
        status: (record.status as 'ACTIVE' | 'SUSPENDED' | 'BANNED' | 'DEACTIVATED') ?? 'ACTIVE',
        communityRulesAccepted: Boolean(record.communityRulesAccepted),
        communityRulesAcceptedAt: record.communityRulesAcceptedAt ? new Date(record.communityRulesAcceptedAt) : null,
        rulesVersion: record.rulesVersion ?? 'nova-community-safety-v1',
        ...(record.username ? {
          profile: {
            create: {
              username: record.username,
              displayName: record.name,
            },
          },
        } : {}),
      },
      select: {
        id: true,
        email: true,
        phoneE164: true,
        name: true,
        role: true,
        status: true,
        communityRulesAccepted: true,
        communityRulesAcceptedAt: true,
        rulesVersion: true,
        createdAt: true,
        updatedAt: true,
        profile: { select: { username: true } },
      },
    });
  }

  return createUser({
    email: record.email,
    phoneE164: record.phoneE164,
    username: record.username,
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

function isUniqueConstraintError(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
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
    const existingIdentifiers = await Promise.all(
      [payload.email, payload.phone, payload.username].filter((value): value is string => Boolean(value))
        .map((identifier) => getUserRecordByIdentifier(identifier)),
    );

    if (existingIdentifiers.some(Boolean)) {
      return res.status(409).json({ message: 'That username, email, or phone number is already in use.' });
    }

    const passwordHash = await hashPassword(payload.password);
    const user = await persistUser({
      email: payload.email ?? null,
      phoneE164: payload.phone ?? undefined,
      username: payload.username,
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

    if (isUniqueConstraintError(error)) {
      return res.status(409).json({ message: 'That username, email, or phone number is already in use.' });
    }

    return next(error);
  }
});

authRouter.post('/login', async (req, res, next) => {
  try {
    const payload = loginSchema.parse(req.body);
    const identifier = payload.identifier ?? payload.email;
    if (!identifier) {
      return res.status(400).json({ message: 'Enter your username, phone number, or email address.' });
    }
    const user = await getUserRecordByIdentifier(identifier);

    if (!user || !(await verifyPassword(payload.password, user.passwordHash))) {
      return res.status(401).json({ message: 'Invalid username, phone number, email, or password.' });
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

    if (token) {
      if (await isDatabaseAvailable()) {
        await prisma.session.updateMany({
          where: { tokenHash: hashSessionToken(token), revokedAt: null },
          data: { revokedAt: new Date() },
        });
      } else {
        fallbackStore.revokeSessionByTokenHash(hashSessionToken(token));
      }
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

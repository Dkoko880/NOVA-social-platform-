import { createCipheriv, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import { z } from 'zod';
import env from '../config/env.js';
import { fallbackStore } from '../lib/fallbackStore.js';
import { getMediaStorage, MediaStorageUnavailableError } from '../lib/mediaStorage.js';
import { getOtpProvider, OtpProviderUnavailableError } from '../lib/otpProvider.js';
import { hashSessionToken, sanitizeUser, signAccessToken } from '../lib/auth.js';
import { isDatabaseAvailable, prisma } from '../lib/prisma.js';

const OTP_TTL_MS = 10 * 60 * 1000;
const DRAFT_TTL_MS = 30 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;
const MAX_AVATAR_BYTES = 4 * 1024 * 1024;
const CONSENT_VERSION = 'novakoko-2026-01';
const REGISTRATION_COOKIE = 'nova_registration';
const RESERVED_USERNAMES = new Set([
  'admin', 'administrator', 'help', 'moderator', 'novakoko', 'nova', 'official', 'security', 'staff', 'support', 'system', 'verified',
]);

type MemoryDraft = {
  id: string;
  phoneE164: string;
  countryCode: string;
  fullName: string;
  otpHash: string;
  otpExpiresAt: Date;
  resendAllowedAt: Date;
  otpAttempts: number;
  verifiedAt: Date | null;
  sessionTokenHash: string | null;
  stage: number;
  dateOfBirth: Date | null;
  region: string | null;
  city: string | null;
  addressCiphertext: string | null;
  addressIv: string | null;
  addressTag: string | null;
  avatarStorageKey: string | null;
  username: string | null;
  termsAcceptedAt: Date | null;
  privacyAcceptedAt: Date | null;
  guidelinesAcceptedAt: Date | null;
  consentVersion: string | null;
  expiresAt: Date;
  consumedAt: Date | null;
  userId: string | null;
};

const drafts = new Map<string, MemoryDraft>();
const otpHash = (id: string, code: string) => createHmac('sha256', env.JWT_SECRET).update(`${id}:${code}`).digest('hex');
const registrationRouter = Router();

export function clearRegistrationStateForTests() {
  drafts.clear();
}

const startSchema = z.object({
  countryCode: z.string().trim().length(2).transform((value) => value.toUpperCase()),
  phone: z.string().trim().min(5).max(40),
  fullName: z.string().trim().min(2).max(100),
});

const privateDetailsSchema = z.object({
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  countryCode: z.string().trim().length(2).transform((value) => value.toUpperCase()),
  region: z.string().trim().min(1).max(100),
  city: z.string().trim().min(1).max(100),
  address: z.string().trim().min(3).max(300),
});

const usernameSchema = z.string().trim().min(3).max(30).regex(/^[a-zA-Z0-9_]+$/);

function genericStartResponse(res: Response, challengeId: string, mode: string) {
  return res.status(202).json({
    challengeId,
    deliveryMode: mode,
    message: 'If this number can receive a verification code, one will be sent shortly.',
  });
}

function validCodeHash(id: string, code: string, storedHash: string) {
  const submitted = Buffer.from(otpHash(id, code), 'hex');
  const expected = Buffer.from(storedHash, 'hex');
  return submitted.length === expected.length && timingSafeEqual(submitted, expected);
}

async function databaseEnabled() {
  return env.NODE_ENV === 'test' ? false : isDatabaseAvailable();
}

function normalizePhone(countryCode: string, input: string) {
  const phone = parsePhoneNumberFromString(input, countryCode as CountryCode);
  if (!phone?.isValid() || (phone.country && phone.country !== countryCode)) return null;
  return phone.number;
}

function encryptPrivateDetails(value: z.infer<typeof privateDetailsSchema>) {
  const configuredKey = process.env.REGISTRATION_DATA_ENCRYPTION_KEY;
  if (env.NODE_ENV === 'production' && (!configuredKey || configuredKey.length < 32 || configuredKey === env.JWT_SECRET)) {
    const error = new Error('Private profile encryption is not configured.') as Error & { statusCode: number };
    error.statusCode = 503;
    throw error;
  }
  const keyMaterial = configuredKey ?? env.JWT_SECRET;
  const key = createHmac('sha256', keyMaterial).update('NOVA private registration data v1').digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(value));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    addressCiphertext: ciphertext.toString('base64url'),
    addressIv: iv.toString('base64url'),
    addressTag: cipher.getAuthTag().toString('base64url'),
  };
}

function isOldEnough(dateString: string) {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== dateString) return false;
  const now = new Date();
  const cutoff = new Date(Date.UTC(now.getUTCFullYear() - 13, now.getUTCMonth(), now.getUTCDate()));
  return date <= cutoff && date.getTime() > Date.UTC(1900, 0, 1);
}

function normalizeUsername(input: string) {
  return input.trim().toLowerCase();
}

function registrationCookieOptions() {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: env.NODE_ENV === 'production' ? 'none' as const : 'strict' as const,
    maxAge: DRAFT_TTL_MS,
    path: '/api/auth/register',
  };
}

async function findDraftById(id: string): Promise<MemoryDraft | any | null> {
  if (await databaseEnabled()) return prisma.registrationDraft.findUnique({ where: { id } });
  return drafts.get(id) ?? null;
}

async function findDraftByPhone(phoneE164: string): Promise<MemoryDraft | any | null> {
  if (await databaseEnabled()) return prisma.registrationDraft.findUnique({ where: { phoneE164 } });
  return [...drafts.values()].find((draft) => draft.phoneE164 === phoneE164) ?? null;
}

async function saveDraft(draft: MemoryDraft) {
  if (await databaseEnabled()) {
    return prisma.registrationDraft.create({
      data: {
        id: draft.id,
        phoneE164: draft.phoneE164,
        countryCode: draft.countryCode,
        fullName: draft.fullName,
        otpHash: draft.otpHash,
        otpExpiresAt: draft.otpExpiresAt,
        resendAllowedAt: draft.resendAllowedAt,
        expiresAt: draft.expiresAt,
      },
    });
  }
  drafts.set(draft.id, draft);
  return draft;
}

async function updateDraft(id: string, data: Partial<MemoryDraft>) {
  if (await databaseEnabled()) return prisma.registrationDraft.update({ where: { id }, data });
  const draft = drafts.get(id);
  if (!draft) return null;
  Object.assign(draft, data);
  return draft;
}

async function getDraftForToken(token: string): Promise<MemoryDraft | any | null> {
  if (await databaseEnabled()) {
    return prisma.registrationDraft.findFirst({
      where: {
        sessionTokenHash: hashSessionToken(token),
        verifiedAt: { not: null },
        expiresAt: { gt: new Date() },
      },
    });
  }
  return [...drafts.values()].find((draft) => draft.sessionTokenHash === hashSessionToken(token) && draft.expiresAt > new Date()) ?? null;
}

async function registrationAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.[REGISTRATION_COOKIE];
    const draft = token ? await getDraftForToken(token) : null;
    if (!draft || draft.consumedAt) return res.status(401).json({ message: 'Registration session is invalid or expired.' });
    req.registrationDraftId = draft.id;
    return next();
  } catch (error) {
    return next(error);
  }
}

function uploadAvatar(req: Request, res: Response, next: NextFunction) {
  const middleware = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_AVATAR_BYTES, files: 1 },
    fileFilter(_request, file, callback) {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
        callback(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'avatar'));
        return;
      }
      callback(null, true);
    },
  }).single('avatar');

  middleware(req, res, (error) => {
    if (error instanceof multer.MulterError) {
      const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      return res.status(status).json({ message: 'The avatar file is invalid or exceeds the size limit.' });
    }
    if (error) return next(error);
    return next();
  });
}

registrationRouter.post('/register/start', async (req, res, next) => {
  try {
    const payload = startSchema.parse(req.body ?? {});
    const phoneE164 = normalizePhone(payload.countryCode, payload.phone);
    if (!phoneE164) return res.status(400).json({ message: 'Enter a valid phone number for the selected country.' });

    const freeRegistration = process.env.FREE_REGISTRATION === "true";
   const provider = freeRegistration ? null : getOtpProvider(env.NODE_ENV);
    const useDb = await databaseEnabled();
    const existingUser = useDb
      ? await prisma.user.findUnique({ where: { phoneE164 }, select: { id: true } })
      : fallbackStore.list().find((user) => user.phoneE164 === phoneE164);
    if (existingUser) return genericStartResponse(res, randomUUID(), provider?.mode ?? "free");

    const currentDraft = await findDraftByPhone(phoneE164);
    const now = Date.now();
    const code = provider ? provider.generateCode() : "";

    if (currentDraft) {
      await updateDraft(currentDraft.id, {
        countryCode: payload.countryCode,
        fullName: payload.fullName,
        otpHash: otpHash(currentDraft.id, code),
        otpExpiresAt: new Date(now + OTP_TTL_MS),
        resendAllowedAt: new Date(now + RESEND_COOLDOWN_MS),
        otpAttempts: 0,
        verifiedAt: null,
        sessionTokenHash: null,
        stage: 1,
        dateOfBirth: null,
        region: null,
        city: null,
        addressCiphertext: null,
        addressIv: null,
        addressTag: null,
        avatarStorageKey: null,
        username: null,
        termsAcceptedAt: null,
        privacyAcceptedAt: null,
        guidelinesAcceptedAt: null,
        consentVersion: null,
        expiresAt: new Date(now + DRAFT_TTL_MS),
        consumedAt: null,
        userId: null,
      });

      if (provider) await provider.sendCode(phoneE164, code);
      return genericStartResponse(res, currentDraft.id, provider?.mode ?? "free");
    }

    const id = randomUUID();
    const draft: MemoryDraft = {
      id,
      phoneE164,
      countryCode: payload.countryCode,
      fullName: payload.fullName,
      otpHash: otpHash(id, code),
      otpExpiresAt: new Date(now + OTP_TTL_MS),
      resendAllowedAt: new Date(now + RESEND_COOLDOWN_MS),
      otpAttempts: 0,
      verifiedAt: null,
      sessionTokenHash: null,
      stage: 1,
      dateOfBirth: null,
      region: null,
      city: null,
      addressCiphertext: null,
      addressIv: null,
      addressTag: null,
      avatarStorageKey: null,
      username: null,
      termsAcceptedAt: null,
      privacyAcceptedAt: null,
      guidelinesAcceptedAt: null,
      consentVersion: null,
      expiresAt: new Date(now + DRAFT_TTL_MS),
      consumedAt: null,
      userId: null,
    };
    await saveDraft(draft);
    if (provider) await provider.sendCode(phoneE164, code);
    return genericStartResponse(res, id, provider?.mode ?? "free");
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ message: 'Invalid registration details.' });
    if (error instanceof OtpProviderUnavailableError) return res.status(503).json({ message: 'Phone verification is temporarily unavailable.' });
    return next(error);
  }
});

registrationRouter.post('/register/resend', async (req, res, next) => {
  try {
    const challengeId = z.string().uuid().parse(req.body?.challengeId);
    const draft = await findDraftById(challengeId);
    if (!draft || draft.verifiedAt || draft.consumedAt || draft.expiresAt <= new Date()) {
      return res.status(400).json({ message: 'This verification request is invalid or expired.' });
    }
    if (draft.resendAllowedAt > new Date()) return res.status(429).json({ message: 'Please wait before requesting another code.' });
    const freeRegistration = process.env.FREE_REGISTRATION === "true";
    if (freeRegistration) {
      return res.json({ deliveryMode: "free", message: "Free registration mode does not require an OTP." });
    }
    const provider = getOtpProvider(env.NODE_ENV);
    const code = provider.generateCode();
    const now = Date.now();
    await updateDraft(draft.id, {
      otpHash: otpHash(draft.id, code),
      otpExpiresAt: new Date(now + OTP_TTL_MS),
      resendAllowedAt: new Date(now + RESEND_COOLDOWN_MS),
      otpAttempts: 0,
    });
    await provider.sendCode(draft.phoneE164, code);
    return res.json({ deliveryMode: provider.mode, message: 'If eligible, a new verification code has been sent.' });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ message: 'Invalid verification request.' });
    if (error instanceof OtpProviderUnavailableError) return res.status(503).json({ message: 'Phone verification is temporarily unavailable.' });
    return next(error);
  }
});

registrationRouter.post('/register/verify', async (req, res, next) => {
  try {
    const freeRegistration = process.env.FREE_REGISTRATION === "true";
    const payload = z.object({
      challengeId: z.string().uuid(),
      code: z.string().regex(/^\d{6}$/).optional(),
    }).parse(req.body ?? {});
    const draft = await findDraftById(payload.challengeId);
    if (!draft || draft.consumedAt || draft.verifiedAt || draft.expiresAt <= new Date()) {
      return res.status(400).json({ message: 'The verification code is invalid or expired.' });
    }
    if (!freeRegistration && draft.otpExpiresAt <= new Date()) {
      return res.status(400).json({ message: 'The verification code is invalid or expired.' });
    }
    if (!freeRegistration && draft.otpAttempts >= MAX_OTP_ATTEMPTS) {
      return res.status(429).json({ message: 'Too many verification attempts. Restart registration later.' });
    }

    if (!freeRegistration && (!payload.code || !validCodeHash(draft.id, payload.code, draft.otpHash))) {
      const attemptedCount = draft.otpAttempts + 1;
      if (await databaseEnabled()) {
        await prisma.registrationDraft.updateMany({
          where: { id: draft.id, verifiedAt: null, otpAttempts: { lt: MAX_OTP_ATTEMPTS }, otpExpiresAt: { gt: new Date() } },
          data: { otpAttempts: { increment: 1 } },
        });
      } else {
        draft.otpAttempts += 1;
      }
      return res.status(attemptedCount >= MAX_OTP_ATTEMPTS ? 429 : 400).json({ message: 'The verification code is invalid or expired.' });
    }

    const registrationToken = randomBytes(32).toString('base64url');
    const now = new Date();
    if (await databaseEnabled()) {
      const claimed = await prisma.registrationDraft.updateMany({
        where: {
          id: draft.id,
          verifiedAt: null,
          consumedAt: null,
          expiresAt: { gt: now },
          ...(freeRegistration ? {} : {
            otpExpiresAt: { gt: now },
            otpAttempts: { lt: MAX_OTP_ATTEMPTS },
          }),
        },
        data: { verifiedAt: now, sessionTokenHash: hashSessionToken(registrationToken), stage: 2 },
      });
      if (!claimed.count) return res.status(409).json({ message: 'The verification code has already been used.' });
    } else {
      draft.verifiedAt = now;
      draft.sessionTokenHash = hashSessionToken(registrationToken);
      draft.stage = 2;
    }
    res.cookie(REGISTRATION_COOKIE, registrationToken, registrationCookieOptions());
    return res.json({ stage: 2, message: 'Phone verified.' });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ message: 'Invalid verification request.' });
    return next(error);
  }
});

registrationRouter.patch('/register/stage/2', registrationAuth, async (req, res, next) => {
  try {
    const payload = privateDetailsSchema.parse(req.body ?? {});
    if (!isOldEnough(payload.dateOfBirth)) return res.status(400).json({ message: 'You must be at least 13 years old and enter a valid date of birth.' });
    const draft = await findDraftById(req.registrationDraftId!);
    if (!draft) return res.status(401).json({ message: 'Registration session is invalid or expired.' });
    if (draft.stage > 2) return res.json({ stage: draft.stage });
    const encrypted = encryptPrivateDetails(payload);
    await updateDraft(draft.id, { ...encrypted, dateOfBirth: null, region: null, city: null, stage: 3 });
    return res.json({ stage: 3, message: 'Private details saved.' });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ message: 'Enter a valid date and complete address details.' });
    return next(error);
  }
});

registrationRouter.post('/register/avatar', registrationAuth, uploadAvatar, async (req, res, next) => {
  try {
    const draft = await findDraftById(req.registrationDraftId!);
    if (!draft) return res.status(401).json({ message: 'Registration session is invalid or expired.' });
    if (draft.stage > 3) return res.json({ stage: draft.stage });
    if (draft.stage !== 3) return res.status(409).json({ message: 'Complete the previous registration stage first.' });
    if (!req.file) return res.status(400).json({ message: 'Choose a JPEG, PNG, or WebP avatar image.' });

    const image = await sharp(req.file.buffer, { limitInputPixels: 20_000_000 }).rotate().resize(512, 512, { fit: 'cover' }).webp({ quality: 82 }).toBuffer();
    const storage = getMediaStorage(env.NODE_ENV);
    const stored = await storage.put(image, 'image/webp');
    if (draft.avatarStorageKey) await storage.delete(draft.avatarStorageKey);
    await updateDraft(draft.id, { avatarStorageKey: stored.key, stage: 4 });
    return res.json({ stage: 4, avatarUrl: stored.publicUrl });
  } catch (error) {
    if (error instanceof MediaStorageUnavailableError) return res.status(503).json({ message: 'Profile image storage is not configured.' });
    if (error instanceof Error && /Input buffer|unsupported image|corrupt/i.test(error.message)) {
      return res.status(400).json({ message: 'The uploaded file is not a valid supported image.' });
    }
    return next(error);
  }
});

registrationRouter.patch('/register/stage/3', registrationAuth, async (req, res, next) => {
  try {
    if (req.body?.skipAvatar !== true) return res.status(400).json({ message: 'Upload an avatar or explicitly use the default avatar.' });
    const draft = await findDraftById(req.registrationDraftId!);
    if (!draft) return res.status(401).json({ message: 'Registration session is invalid or expired.' });
    if (draft.stage > 3) return res.json({ stage: draft.stage });
    if (draft.stage !== 3) return res.status(409).json({ message: 'Complete the previous registration stage first.' });
    await updateDraft(draft.id, { avatarStorageKey: null, stage: 4 });
    return res.json({ stage: 4, message: 'Default avatar selected.' });
  } catch (error) {
    return next(error);
  }
});

async function usernameIsAvailable(username: string, ownDraftId?: string) {
  if (RESERVED_USERNAMES.has(username)) return false;
  if (await databaseEnabled()) {
    const [profile, draft] = await Promise.all([
      prisma.profile.findFirst({ where: { username: { equals: username, mode: 'insensitive' } }, select: { id: true } }),
      prisma.registrationDraft.findFirst({ where: { username, id: ownDraftId ? { not: ownDraftId } : undefined, consumedAt: null }, select: { id: true } }),
    ]);
    return !profile && !draft;
  }
  const takenByUser = fallbackStore.list().some((user) => user.username === username);
  const takenByDraft = [...drafts.values()].some((draft) => draft.id !== ownDraftId && draft.username === username && !draft.consumedAt);
  return !takenByUser && !takenByDraft;
}

registrationRouter.get('/register/username-availability', async (req, res, next) => {
  try {
    const parsed = usernameSchema.safeParse(req.query.username);
    if (!parsed.success) return res.status(400).json({ available: false, message: 'Username must be 3-30 letters, numbers, or underscores.' });
    const username = normalizeUsername(parsed.data);
    return res.json({ username, available: await usernameIsAvailable(username) });
  } catch (error) {
    return next(error);
  }
});

registrationRouter.patch('/register/stage/4', registrationAuth, async (req, res, next) => {
  try {
    const payload = z.object({
      username: usernameSchema,
      termsAccepted: z.literal(true),
      privacyAccepted: z.literal(true),
      guidelinesAccepted: z.literal(true),
    }).parse(req.body ?? {});
    const draft = await findDraftById(req.registrationDraftId!);
    if (!draft) return res.status(401).json({ message: 'Registration session is invalid or expired.' });
    if (draft.stage > 4) return res.json({ stage: draft.stage });
    if (draft.stage !== 4) return res.status(409).json({ message: 'Complete the previous registration stage first.' });
    const username = normalizeUsername(payload.username);
    if (!(await usernameIsAvailable(username, draft.id))) return res.status(409).json({ message: 'This username is unavailable.' });
    const now = new Date();
    await updateDraft(draft.id, {
      username,
      termsAcceptedAt: now,
      privacyAcceptedAt: now,
      guidelinesAcceptedAt: now,
      consentVersion: CONSENT_VERSION,
      stage: 5,
    });
    return res.json({ stage: 5, message: 'Username and required policies accepted.' });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ message: 'Choose a valid username and accept all required policies.' });
    return next(error);
  }
});

registrationRouter.post('/register/complete', registrationAuth, async (req, res, next) => {
  try {
    const draft = await findDraftById(req.registrationDraftId!);
    if (!draft || draft.stage !== 5 || !draft.verifiedAt || !draft.username || !draft.termsAcceptedAt || !draft.privacyAcceptedAt || !draft.guidelinesAcceptedAt) {
      return res.status(409).json({ message: 'Complete every registration stage before creating the account.' });
    }
    const useDb = await databaseEnabled();
    let user: any;
    let token: string;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    if (useDb) {
      const created = await prisma.$transaction(async (tx) => {
        const currentDraft = await tx.registrationDraft.findUnique({ where: { id: draft.id } });
        if (!currentDraft || currentDraft.consumedAt || currentDraft.stage !== 5) throw new Error('Registration draft has already been completed.');
        const record = await tx.user.create({
          data: {
            email: null,
            phoneE164: draft.phoneE164,
            phoneVerifiedAt: draft.verifiedAt,
            name: draft.fullName,
            passwordHash: '',
            role: 'USER',
            status: 'ACTIVE',
            profile: { create: { username: draft.username, displayName: draft.fullName, avatarUrl: draft.avatarStorageKey ? `/api/media/avatars/${draft.avatarStorageKey}` : null } },
            privateDetails: { create: {
              addressCiphertext: draft.addressCiphertext,
              addressIv: draft.addressIv,
              addressTag: draft.addressTag,
            } },
          },
          select: { id: true, email: true, phoneE164: true, name: true, role: true, status: true, createdAt: true, updatedAt: true },
        });
        token = signAccessToken({ sub: record.id, role: record.role });
        await tx.session.create({
          data: {
            userId: record.id,
            tokenHash: hashSessionToken(token),
            userAgent: req.get('user-agent')?.slice(0, 300) ?? null,
            deviceName: req.get('x-device-name')?.slice(0, 100) ?? null,
            ipAddress: req.ip ?? null,
            expiresAt,
            lastSeenAt: now,
          },
        });
        await tx.registrationDraft.update({ where: { id: draft.id }, data: { consumedAt: now, userId: record.id } });
        await tx.securityAlert.create({ data: { userId: record.id, type: 'NEW_ACCOUNT_SESSION', details: 'A new account session was created.' } });
        return record;
      }, { isolationLevel: 'Serializable' });
      user = created;
    } else {
      const existing = fallbackStore.list().find((entry) => entry.phoneE164 === draft.phoneE164);
      if (existing) return res.status(409).json({ message: 'This registration has already been completed.' });
      user = fallbackStore.create({
        email: null,
        phoneE164: draft.phoneE164,
        phoneVerifiedAt: draft.verifiedAt.toISOString(),
        name: draft.fullName,
        passwordHash: '',
        role: 'USER',
        status: 'ACTIVE',
        communityRulesAccepted: true,
        communityRulesAcceptedAt: draft.guidelinesAcceptedAt.toISOString(),
        rulesVersion: CONSENT_VERSION,
        username: draft.username,
      });
      token = signAccessToken({ sub: user.id, role: user.role });
      fallbackStore.createSession({
        userId: user.id,
        tokenHash: hashSessionToken(token),
        userAgent: req.get('user-agent')?.slice(0, 300) ?? null,
        deviceName: req.get('x-device-name')?.slice(0, 100) ?? null,
        ipAddress: req.ip ?? null,
        lastSeenAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
      });
      await updateDraft(draft.id, { consumedAt: now, userId: user.id });
    }

    res.cookie(env.COOKIE_NAME, token!, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: env.COOKIE_SAME_SITE,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    res.clearCookie(REGISTRATION_COOKIE, { ...registrationCookieOptions(), maxAge: undefined });
    return res.status(201).json({ user: sanitizeUser(user), message: 'Your NOVAKOKO account is ready.' });
  } catch (error) {
    return next(error);
  }
});

registrationRouter.delete('/register/avatar', registrationAuth, async (req, res, next) => {
  try {
    const draft = await findDraftById(req.registrationDraftId!);
    if (!draft) return res.status(401).json({ message: 'Registration session is invalid or expired.' });
    if (draft.stage !== 3) return res.status(409).json({ message: 'Avatar can only be changed during stage 3.' });
    if (draft.avatarStorageKey) await getMediaStorage(env.NODE_ENV).delete(draft.avatarStorageKey);
    await updateDraft(draft.id, { avatarStorageKey: null });
    return res.json({ message: 'Avatar removed.' });
  } catch (error) {
    if (error instanceof MediaStorageUnavailableError) return res.status(503).json({ message: 'Profile image storage is not configured.' });
    return next(error);
  }
});

export const registrationMediaRouter = Router();
registrationMediaRouter.get('/avatars/:key', async (req, res, next) => {
  try {
    if (!/^[0-9a-f-]{36}\.webp$/.test(req.params.key)) return res.status(404).end();
    const object = await getMediaStorage(env.NODE_ENV).get(req.params.key);
    if (!object) return res.status(404).end();
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    return res.send(object.bytes);
  } catch (error) {
    if (error instanceof MediaStorageUnavailableError) return res.status(503).json({ message: 'Profile image storage is not configured.' });
    return next(error);
  }
});

export { registrationRouter };

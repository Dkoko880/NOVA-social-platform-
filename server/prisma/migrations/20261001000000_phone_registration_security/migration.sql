ALTER TYPE "UserRole" ADD VALUE 'SUPPORT';

DROP INDEX "Profile_username_idx";

ALTER TABLE "Session"
  ADD COLUMN "deviceName" TEXT,
  ADD COLUMN "lastSeenAt" TIMESTAMP(3);

ALTER TABLE "User"
  ADD COLUMN "phoneE164" TEXT,
  ADD COLUMN "phoneVerifiedAt" TIMESTAMP(3),
  ALTER COLUMN "email" DROP NOT NULL;

CREATE TABLE "PrivateProfile" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "dateOfBirth" TIMESTAMP(3),
  "countryCode" TEXT,
  "region" TEXT,
  "city" TEXT,
  "addressCiphertext" TEXT,
  "addressIv" TEXT,
  "addressTag" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PrivateProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RegistrationDraft" (
  "id" TEXT NOT NULL,
  "phoneE164" TEXT NOT NULL,
  "countryCode" TEXT NOT NULL,
  "fullName" TEXT NOT NULL,
  "otpHash" TEXT NOT NULL,
  "otpExpiresAt" TIMESTAMP(3) NOT NULL,
  "resendAllowedAt" TIMESTAMP(3) NOT NULL,
  "otpAttempts" INTEGER NOT NULL DEFAULT 0,
  "verifiedAt" TIMESTAMP(3),
  "sessionTokenHash" TEXT,
  "stage" INTEGER NOT NULL DEFAULT 1,
  "dateOfBirth" TIMESTAMP(3),
  "region" TEXT,
  "city" TEXT,
  "addressCiphertext" TEXT,
  "addressIv" TEXT,
  "addressTag" TEXT,
  "avatarStorageKey" TEXT,
  "username" TEXT,
  "termsAcceptedAt" TIMESTAMP(3),
  "privacyAcceptedAt" TIMESTAMP(3),
  "guidelinesAcceptedAt" TIMESTAMP(3),
  "consentVersion" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "userId" TEXT,
  CONSTRAINT "RegistrationDraft_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MfaMethod" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "secretHash" TEXT,
  "enabledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MfaMethod_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SecurityAlert" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "details" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "readAt" TIMESTAMP(3),
  CONSTRAINT "SecurityAlert_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuthOtpChallenge" (
  "id" TEXT NOT NULL,
  "phoneE164" TEXT NOT NULL,
  "otpHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "consumedAt" TIMESTAMP(3),
  "userId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuthOtpChallenge_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PrivateProfile_userId_key" ON "PrivateProfile"("userId");
CREATE UNIQUE INDEX "RegistrationDraft_phoneE164_key" ON "RegistrationDraft"("phoneE164");
CREATE UNIQUE INDEX "RegistrationDraft_sessionTokenHash_key" ON "RegistrationDraft"("sessionTokenHash");
CREATE UNIQUE INDEX "RegistrationDraft_username_key" ON "RegistrationDraft"("username");
CREATE INDEX "RegistrationDraft_expiresAt_idx" ON "RegistrationDraft"("expiresAt");
CREATE INDEX "RegistrationDraft_stage_expiresAt_idx" ON "RegistrationDraft"("stage", "expiresAt");
CREATE INDEX "MfaMethod_userId_enabledAt_idx" ON "MfaMethod"("userId", "enabledAt");
CREATE INDEX "SecurityAlert_userId_createdAt_idx" ON "SecurityAlert"("userId", "createdAt");
CREATE INDEX "AuthOtpChallenge_phoneE164_createdAt_idx" ON "AuthOtpChallenge"("phoneE164", "createdAt");
CREATE INDEX "AuthOtpChallenge_expiresAt_idx" ON "AuthOtpChallenge"("expiresAt");
UPDATE "Profile" SET "username" = lower("username") WHERE "username" IS NOT NULL;
CREATE UNIQUE INDEX "Profile_username_key" ON "Profile"("username");
CREATE UNIQUE INDEX "User_phoneE164_key" ON "User"("phoneE164");
CREATE INDEX "User_phoneE164_idx" ON "User"("phoneE164");

ALTER TABLE "PrivateProfile"
  ADD CONSTRAINT "PrivateProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RegistrationDraft"
  ADD CONSTRAINT "RegistrationDraft_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MfaMethod"
  ADD CONSTRAINT "MfaMethod_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SecurityAlert"
  ADD CONSTRAINT "SecurityAlert_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AuthOtpChallenge"
  ADD CONSTRAINT "AuthOtpChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
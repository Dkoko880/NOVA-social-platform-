ALTER TABLE "RegistrationMediaObject" ADD COLUMN "ownerUserId" TEXT;

UPDATE "RegistrationMediaObject" AS media
SET "ownerUserId" = profile."userId"
FROM "Profile" AS profile
WHERE media.key = replace(profile."avatarUrl", '/api/media/avatars/', '')
  AND profile."avatarUrl" LIKE '/api/media/avatars/%'
  AND media."ownerUserId" IS NULL;

UPDATE "RegistrationMediaObject" AS media
SET "ownerUserId" = profile."userId"
FROM "Profile" AS profile
WHERE media.key = replace(profile."coverUrl", '/api/media/avatars/', '')
  AND profile."coverUrl" LIKE '/api/media/avatars/%'
  AND media."ownerUserId" IS NULL;

UPDATE "RegistrationMediaObject" AS media
SET "ownerUserId" = post."authorId"
FROM "Post" AS post
WHERE media.key = replace(post."imageUrl", '/api/media/avatars/', '')
  AND post."imageUrl" LIKE '/api/media/avatars/%'
  AND media."ownerUserId" IS NULL;

UPDATE "RegistrationMediaObject" AS media
SET "ownerUserId" = story."authorId"
FROM "Story" AS story
WHERE media.key = replace(story."mediaUrl", '/api/media/avatars/', '')
  AND story."mediaUrl" LIKE '/api/media/avatars/%'
  AND media."ownerUserId" IS NULL;

UPDATE "RegistrationMediaObject" AS media
SET "ownerUserId" = message."senderId"
FROM "Message" AS message
WHERE media.key = replace(message."mediaUrl", '/api/media/avatars/', '')
  AND message."mediaUrl" LIKE '/api/media/avatars/%'
  AND media."ownerUserId" IS NULL;

UPDATE "RegistrationMediaObject" AS media
SET "ownerUserId" = draft."userId"
FROM "RegistrationDraft" AS draft
WHERE media.key = draft."avatarStorageKey"
  AND draft."userId" IS NOT NULL
  AND media."ownerUserId" IS NULL;

CREATE INDEX "RegistrationMediaObject_ownerUserId_idx" ON "RegistrationMediaObject"("ownerUserId");

ALTER TABLE "RegistrationMediaObject"
ADD CONSTRAINT "RegistrationMediaObject_ownerUserId_fkey"
FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

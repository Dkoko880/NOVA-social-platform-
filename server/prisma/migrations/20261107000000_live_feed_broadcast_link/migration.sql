ALTER TABLE "LiveBroadcast"
  ADD COLUMN "moderators" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "blockedUserIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "mutedUserIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "guests" JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE "Post"
  ADD COLUMN "sourceLiveBroadcastId" TEXT;

CREATE UNIQUE INDEX "Post_sourceLiveBroadcastId_key"
  ON "Post"("sourceLiveBroadcastId");

ALTER TABLE "Post"
  ADD CONSTRAINT "Post_sourceLiveBroadcastId_fkey"
  FOREIGN KEY ("sourceLiveBroadcastId") REFERENCES "LiveBroadcast"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
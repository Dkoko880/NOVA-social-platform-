ALTER TABLE "LiveReplay"
ADD COLUMN "deletedPostId" TEXT;

CREATE UNIQUE INDEX "LiveReplay_deletedPostId_key" ON "LiveReplay"("deletedPostId");

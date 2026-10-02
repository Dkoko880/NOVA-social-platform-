CREATE TYPE "CommunityType" AS ENUM ('GROUP', 'COMMUNITY', 'CHANNEL');

ALTER TABLE "Community"
ADD COLUMN "type" "CommunityType" NOT NULL DEFAULT 'COMMUNITY',
ADD COLUMN "isPrivate" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Conversation"
ADD COLUMN "isChannel" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "disappearingAfterSeconds" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "ConversationParticipant"
ADD COLUMN "pinnedAt" TIMESTAMP(3),
ADD COLUMN "archivedAt" TIMESTAMP(3),
ADD COLUMN "starredAt" TIMESTAMP(3),
ADD COLUMN "mutedUntil" TIMESTAMP(3);

ALTER TABLE "Message"
ADD COLUMN "contentType" TEXT NOT NULL DEFAULT 'TEXT',
ADD COLUMN "mediaUrl" TEXT,
ADD COLUMN "metadata" JSONB,
ADD COLUMN "replyToId" TEXT,
ADD COLUMN "forwardedFromId" TEXT,
ADD COLUMN "editedAt" TIMESTAMP(3),
ADD COLUMN "expiresAt" TIMESTAMP(3);

CREATE INDEX "Message_expiresAt_idx" ON "Message"("expiresAt");

CREATE TABLE "MessageReaction" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MessageReaction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MessageReaction_messageId_userId_type_key" ON "MessageReaction"("messageId", "userId", "type");
CREATE INDEX "MessageReaction_messageId_idx" ON "MessageReaction"("messageId");
ALTER TABLE "MessageReaction" ADD CONSTRAINT "MessageReaction_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MessageReaction" ADD CONSTRAINT "MessageReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

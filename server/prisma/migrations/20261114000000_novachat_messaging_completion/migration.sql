CREATE TYPE "PresenceVisibility" AS ENUM ('EVERYONE', 'MY_CONTACTS', 'NOBODY');

ALTER TABLE "User"
ADD COLUMN "presenceVisibility" "PresenceVisibility" NOT NULL DEFAULT 'EVERYONE',
ADD COLUMN "readReceiptsEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "lastSeenAt" TIMESTAMP(3);

ALTER TABLE "ConversationParticipant"
ADD COLUMN "unreadMarkedAt" TIMESTAMP(3);

CREATE TABLE "MessageReceipt" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "deliveredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    CONSTRAINT "MessageReceipt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MessageReceipt_messageId_recipientId_key"
ON "MessageReceipt"("messageId", "recipientId");
CREATE INDEX "MessageReceipt_recipientId_deliveredAt_idx"
ON "MessageReceipt"("recipientId", "deliveredAt");
CREATE INDEX "MessageReceipt_recipientId_readAt_idx"
ON "MessageReceipt"("recipientId", "readAt");

ALTER TABLE "MessageReceipt"
ADD CONSTRAINT "MessageReceipt_messageId_fkey"
FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MessageReceipt"
ADD CONSTRAINT "MessageReceipt_recipientId_fkey"
FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "MessageReceipt" ("id", "messageId", "recipientId", "deliveredAt", "readAt")
SELECT
    'legacy_receipt_' || md5(message."id" || ':' || participant."userId"),
    message."id",
    participant."userId",
    CASE WHEN message."status" IN ('DELIVERED', 'READ') THEN message."updatedAt" ELSE NULL END,
    message."readAt"
FROM "Message" AS message
JOIN "ConversationParticipant" AS participant
    ON participant."conversationId" = message."conversationId"
    AND participant."userId" <> message."senderId"
    AND participant."leftAt" IS NULL;

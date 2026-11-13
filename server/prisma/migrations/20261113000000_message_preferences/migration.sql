ALTER TABLE "Message"
ADD COLUMN "pinnedAt" TIMESTAMP(3);

CREATE TABLE "MessagePreference" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "starredAt" TIMESTAMP(3),
    CONSTRAINT "MessagePreference_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MessagePreference_messageId_userId_key" ON "MessagePreference"("messageId", "userId");
CREATE INDEX "MessagePreference_userId_starredAt_idx" ON "MessagePreference"("userId", "starredAt");
ALTER TABLE "MessagePreference" ADD CONSTRAINT "MessagePreference_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MessagePreference" ADD CONSTRAINT "MessagePreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

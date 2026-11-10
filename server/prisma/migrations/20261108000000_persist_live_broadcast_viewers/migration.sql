CREATE TABLE "LiveBroadcastViewer" (
  "liveId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "connectedAt" TIMESTAMP(3),
  CONSTRAINT "LiveBroadcastViewer_pkey" PRIMARY KEY ("liveId", "userId")
);

CREATE INDEX "LiveBroadcastViewer_liveId_lastSeenAt_idx"
  ON "LiveBroadcastViewer"("liveId", "lastSeenAt");
CREATE INDEX "LiveBroadcastViewer_userId_lastSeenAt_idx"
  ON "LiveBroadcastViewer"("userId", "lastSeenAt");

ALTER TABLE "LiveBroadcastViewer"
  ADD CONSTRAINT "LiveBroadcastViewer_liveId_fkey"
  FOREIGN KEY ("liveId") REFERENCES "LiveBroadcast"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LiveBroadcastViewer"
  ADD CONSTRAINT "LiveBroadcastViewer_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

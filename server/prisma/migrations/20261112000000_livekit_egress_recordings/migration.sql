ALTER TABLE "LiveBroadcast"
ADD COLUMN "egressId" TEXT,
ADD COLUMN "egressOutputKey" TEXT,
ADD COLUMN "egressError" TEXT;

CREATE UNIQUE INDEX "LiveBroadcast_egressId_key" ON "LiveBroadcast"("egressId");

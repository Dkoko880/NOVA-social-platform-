UPDATE "LiveBroadcast" AS broadcast
SET "recordingStatus" = 'UNAVAILABLE'
WHERE broadcast."status" = 'ended'
  AND broadcast."recordingStatus" = 'RECORDING'
  AND broadcast."replayUrl" IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "LiveReplay" AS replay
    WHERE replay."id" = broadcast."id"
      AND replay."status" IN ('READY', 'PUBLISHED')
  );

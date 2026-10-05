-- AlterTable
ALTER TABLE "Report" ADD COLUMN     "targetUserId" TEXT;

-- CreateTable
CREATE TABLE "RegistrationMediaObject" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "contentType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegistrationMediaObject_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RegistrationMediaObject_key_key" ON "RegistrationMediaObject"("key");

-- CreateIndex
CREATE INDEX "RegistrationMediaObject_createdAt_idx" ON "RegistrationMediaObject"("createdAt");

-- CreateIndex
CREATE INDEX "Report_targetUserId_idx" ON "Report"("targetUserId");

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MarketplaceOrder" ADD COLUMN "paymentStatus" TEXT NOT NULL DEFAULT 'UNPAID';
ALTER TABLE "CreatorPayoutRequest" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "CreatorPayoutRequest_creatorId_idempotencyKey_key" ON "CreatorPayoutRequest"("creatorId", "idempotencyKey");

CREATE TABLE "PaymentIntent" (
  "id" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "payerId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "providerReference" TEXT,
  "amountCents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "targetId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PaymentIntent_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "FinancialWebhookEvent" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "providerEventId" TEXT NOT NULL,
  "paymentReference" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'RECEIVED',
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),
  CONSTRAINT "FinancialWebhookEvent_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "FinancialLedgerEntry" (
  "id" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "direction" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL,
  "sourceType" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinancialLedgerEntry_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "FinancialRefund" (
  "id" TEXT NOT NULL,
  "paymentReference" TEXT NOT NULL,
  "requestorId" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "reviewedBy" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "reviewReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FinancialRefund_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "FinancialDispute" (
  "id" TEXT NOT NULL,
  "paymentReference" TEXT NOT NULL,
  "reporterId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "reason" TEXT NOT NULL,
  "notes" TEXT,
  "evidenceReference" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FinancialDispute_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PaymentIntent_reference_key" ON "PaymentIntent"("reference");
CREATE UNIQUE INDEX "PaymentIntent_providerReference_key" ON "PaymentIntent"("providerReference");
CREATE UNIQUE INDEX "PaymentIntent_payerId_idempotencyKey_key" ON "PaymentIntent"("payerId", "idempotencyKey");
CREATE INDEX "PaymentIntent_payerId_createdAt_idx" ON "PaymentIntent"("payerId", "createdAt");
CREATE INDEX "PaymentIntent_purpose_targetId_idx" ON "PaymentIntent"("purpose", "targetId");
CREATE INDEX "PaymentIntent_status_createdAt_idx" ON "PaymentIntent"("status", "createdAt");
CREATE UNIQUE INDEX "FinancialWebhookEvent_provider_providerEventId_key" ON "FinancialWebhookEvent"("provider", "providerEventId");
CREATE INDEX "FinancialWebhookEvent_paymentReference_receivedAt_idx" ON "FinancialWebhookEvent"("paymentReference", "receivedAt");
CREATE UNIQUE INDEX "FinancialLedgerEntry_idempotencyKey_key" ON "FinancialLedgerEntry"("idempotencyKey");
CREATE INDEX "FinancialLedgerEntry_ownerId_createdAt_idx" ON "FinancialLedgerEntry"("ownerId", "createdAt");
CREATE INDEX "FinancialLedgerEntry_sourceType_sourceId_idx" ON "FinancialLedgerEntry"("sourceType", "sourceId");
CREATE UNIQUE INDEX "FinancialRefund_reference_key" ON "FinancialRefund"("reference");
CREATE UNIQUE INDEX "FinancialRefund_paymentReference_requestorId_key" ON "FinancialRefund"("paymentReference", "requestorId");
CREATE INDEX "FinancialRefund_status_createdAt_idx" ON "FinancialRefund"("status", "createdAt");
CREATE INDEX "FinancialDispute_paymentReference_status_idx" ON "FinancialDispute"("paymentReference", "status");
CREATE INDEX "FinancialDispute_reporterId_createdAt_idx" ON "FinancialDispute"("reporterId", "createdAt");
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_payerId_fkey" FOREIGN KEY ("payerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

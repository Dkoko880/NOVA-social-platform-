CREATE TYPE "CreatorSubscriptionStatus" AS ENUM ('PENDING', 'ACTIVE', 'CANCELLED', 'EXPIRED');
CREATE TYPE "BusinessVerificationStatus" AS ENUM ('UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED');
CREATE TYPE "BusinessTeamRole" AS ENUM ('OWNER', 'ADMIN', 'EDITOR', 'ANALYST');
CREATE TYPE "MarketplaceProductStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED', 'OUT_OF_STOCK');
CREATE TYPE "MarketplaceOrderStatus" AS ENUM ('PENDING', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'DISPUTED');
CREATE TYPE "MarketplaceDisputeStatus" AS ENUM ('OPEN', 'REVIEWING', 'RESOLVED', 'REJECTED');

CREATE TABLE "CreatorProfile" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "headline" TEXT,
  "category" TEXT,
  "subscriptionPriceCents" INTEGER NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "isEnabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CreatorProfile_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "CreatorSubscription" (
  "id" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "subscriberId" TEXT NOT NULL,
  "status" "CreatorSubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
  "provider" TEXT NOT NULL DEFAULT 'manual',
  "providerReference" TEXT,
  "amountCents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endsAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CreatorSubscription_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "CreatorLedgerEntry" (
  "id" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "reference" TEXT,
  "description" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreatorLedgerEntry_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "CreatorPayoutRequest" (
  "id" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "provider" TEXT NOT NULL DEFAULT 'manual',
  "providerReference" TEXT,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CreatorPayoutRequest_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "BusinessProfile" (
  "id" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "description" TEXT,
  "contactEmail" TEXT,
  "contactPhone" TEXT,
  "website" TEXT,
  "verificationStatus" "BusinessVerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BusinessProfile_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "BusinessMember" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "role" "BusinessTeamRole" NOT NULL DEFAULT 'EDITOR',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BusinessMember_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "BusinessFollower" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BusinessFollower_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "BusinessPost" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "authorId" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "imageUrl" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BusinessPost_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "SellerProfile" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "description" TEXT,
  "contactEmail" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SellerProfile_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "MarketplaceProduct" (
  "id" TEXT NOT NULL,
  "sellerId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "priceCents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "stock" INTEGER NOT NULL DEFAULT 0,
  "status" "MarketplaceProductStatus" NOT NULL DEFAULT 'DRAFT',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MarketplaceProduct_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ProductImage" (
  "id" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "storageKey" TEXT,
  "altText" TEXT,
  "position" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProductImage_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "MarketplaceOrder" (
  "id" TEXT NOT NULL,
  "buyerId" TEXT NOT NULL,
  "status" "MarketplaceOrderStatus" NOT NULL DEFAULT 'PENDING',
  "totalCents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "cancelledAt" TIMESTAMP(3),
  CONSTRAINT "MarketplaceOrder_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "MarketplaceOrderItem" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "sellerId" TEXT NOT NULL,
  "titleSnapshot" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL,
  "unitPriceCents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL,
  CONSTRAINT "MarketplaceOrderItem_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ProductInquiry" (
  "id" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "buyerId" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "orderId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProductInquiry_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "MarketplaceDispute" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "reporterId" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "status" "MarketplaceDisputeStatus" NOT NULL DEFAULT 'OPEN',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MarketplaceDispute_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CreatorProfile_userId_key" ON "CreatorProfile"("userId");
CREATE INDEX "CreatorProfile_isEnabled_idx" ON "CreatorProfile"("isEnabled");
CREATE UNIQUE INDEX "CreatorSubscription_creatorId_subscriberId_key" ON "CreatorSubscription"("creatorId", "subscriberId");
CREATE INDEX "CreatorSubscription_creatorId_status_idx" ON "CreatorSubscription"("creatorId", "status");
CREATE INDEX "CreatorSubscription_subscriberId_status_idx" ON "CreatorSubscription"("subscriberId", "status");
CREATE INDEX "CreatorLedgerEntry_creatorId_createdAt_idx" ON "CreatorLedgerEntry"("creatorId", "createdAt");
CREATE INDEX "CreatorLedgerEntry_reference_idx" ON "CreatorLedgerEntry"("reference");
CREATE INDEX "CreatorPayoutRequest_creatorId_status_idx" ON "CreatorPayoutRequest"("creatorId", "status");
CREATE UNIQUE INDEX "BusinessProfile_ownerId_key" ON "BusinessProfile"("ownerId");
CREATE INDEX "BusinessProfile_category_idx" ON "BusinessProfile"("category");
CREATE INDEX "BusinessProfile_verificationStatus_idx" ON "BusinessProfile"("verificationStatus");
CREATE UNIQUE INDEX "BusinessMember_businessId_userId_key" ON "BusinessMember"("businessId", "userId");
CREATE INDEX "BusinessMember_userId_idx" ON "BusinessMember"("userId");
CREATE UNIQUE INDEX "BusinessFollower_businessId_userId_key" ON "BusinessFollower"("businessId", "userId");
CREATE INDEX "BusinessFollower_userId_idx" ON "BusinessFollower"("userId");
CREATE INDEX "BusinessPost_businessId_createdAt_idx" ON "BusinessPost"("businessId", "createdAt");
CREATE UNIQUE INDEX "SellerProfile_userId_key" ON "SellerProfile"("userId");
CREATE INDEX "SellerProfile_displayName_idx" ON "SellerProfile"("displayName");
CREATE INDEX "MarketplaceProduct_sellerId_status_idx" ON "MarketplaceProduct"("sellerId", "status");
CREATE INDEX "MarketplaceProduct_category_status_idx" ON "MarketplaceProduct"("category", "status");
CREATE INDEX "MarketplaceProduct_title_idx" ON "MarketplaceProduct"("title");
CREATE INDEX "ProductImage_productId_position_idx" ON "ProductImage"("productId", "position");
CREATE INDEX "MarketplaceOrder_buyerId_createdAt_idx" ON "MarketplaceOrder"("buyerId", "createdAt");
CREATE INDEX "MarketplaceOrder_status_createdAt_idx" ON "MarketplaceOrder"("status", "createdAt");
CREATE INDEX "MarketplaceOrderItem_sellerId_orderId_idx" ON "MarketplaceOrderItem"("sellerId", "orderId");
CREATE INDEX "MarketplaceOrderItem_productId_idx" ON "MarketplaceOrderItem"("productId");
CREATE INDEX "ProductInquiry_productId_createdAt_idx" ON "ProductInquiry"("productId", "createdAt");
CREATE INDEX "ProductInquiry_buyerId_idx" ON "ProductInquiry"("buyerId");
CREATE INDEX "MarketplaceDispute_orderId_status_idx" ON "MarketplaceDispute"("orderId", "status");
CREATE INDEX "MarketplaceDispute_reporterId_idx" ON "MarketplaceDispute"("reporterId");

ALTER TABLE "CreatorProfile" ADD CONSTRAINT "CreatorProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreatorSubscription" ADD CONSTRAINT "CreatorSubscription_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorProfile"("userId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreatorSubscription" ADD CONSTRAINT "CreatorSubscription_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreatorLedgerEntry" ADD CONSTRAINT "CreatorLedgerEntry_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorProfile"("userId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreatorPayoutRequest" ADD CONSTRAINT "CreatorPayoutRequest_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorProfile"("userId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BusinessProfile" ADD CONSTRAINT "BusinessProfile_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BusinessMember" ADD CONSTRAINT "BusinessMember_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "BusinessProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BusinessMember" ADD CONSTRAINT "BusinessMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BusinessFollower" ADD CONSTRAINT "BusinessFollower_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "BusinessProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BusinessFollower" ADD CONSTRAINT "BusinessFollower_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BusinessPost" ADD CONSTRAINT "BusinessPost_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "BusinessProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BusinessPost" ADD CONSTRAINT "BusinessPost_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SellerProfile" ADD CONSTRAINT "SellerProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MarketplaceProduct" ADD CONSTRAINT "MarketplaceProduct_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "SellerProfile"("userId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_productId_fkey" FOREIGN KEY ("productId") REFERENCES "MarketplaceProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MarketplaceOrder" ADD CONSTRAINT "MarketplaceOrder_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MarketplaceOrderItem" ADD CONSTRAINT "MarketplaceOrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "MarketplaceOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MarketplaceOrderItem" ADD CONSTRAINT "MarketplaceOrderItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "MarketplaceProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProductInquiry" ADD CONSTRAINT "ProductInquiry_productId_fkey" FOREIGN KEY ("productId") REFERENCES "MarketplaceProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductInquiry" ADD CONSTRAINT "ProductInquiry_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductInquiry" ADD CONSTRAINT "ProductInquiry_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "MarketplaceOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MarketplaceDispute" ADD CONSTRAINT "MarketplaceDispute_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "MarketplaceOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MarketplaceDispute" ADD CONSTRAINT "MarketplaceDispute_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
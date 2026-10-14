-- CreateTable
CREATE TABLE "ShopifyProductEligibility" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "preferredImageId" TEXT,
    "preferredImageUrl" TEXT,
    "preferredVariantId" TEXT,
    "preferredVariantTitle" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyProductEligibility_shop_shopifyProductId_key" ON "ShopifyProductEligibility"("shop", "shopifyProductId");

-- CreateIndex
CREATE INDEX "ShopifyProductEligibility_shop_enabled_idx" ON "ShopifyProductEligibility"("shop", "enabled");

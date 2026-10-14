-- CreateTable
CREATE TABLE "ShopInstallation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "shopName" TEXT,
    "myshopifyDomain" TEXT,
    "scope" TEXT,
    "installationStatus" TEXT NOT NULL DEFAULT 'installed',
    "installedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAuthenticatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" DATETIME,
    "redactedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "MerchantSetting" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "webhookId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "processedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopInstallation_shop_key" ON "ShopInstallation"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "MerchantSetting_shop_key" ON "MerchantSetting"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDelivery_webhookId_topic_key" ON "WebhookDelivery"("webhookId", "topic");

-- CreateIndex
CREATE INDEX "WebhookDelivery_shop_topic_idx" ON "WebhookDelivery"("shop", "topic");

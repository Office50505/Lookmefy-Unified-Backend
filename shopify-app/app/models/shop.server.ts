import db from "../db.server";

export interface ShopProfile {
  shop: string;
  name?: string | null;
  myshopifyDomain?: string | null;
  scope?: string | null;
}

export async function recordShopAuthenticated(profile: ShopProfile) {
  return db.shopInstallation.upsert({
    where: { shop: profile.shop },
    create: {
      shop: profile.shop,
      shopName: profile.name || null,
      myshopifyDomain: profile.myshopifyDomain || profile.shop,
      scope: profile.scope || null,
      installationStatus: "installed",
      installedAt: new Date(),
      lastAuthenticatedAt: new Date(),
    },
    update: {
      shopName: profile.name || undefined,
      myshopifyDomain: profile.myshopifyDomain || profile.shop,
      scope: profile.scope || undefined,
      installationStatus: "installed",
      lastAuthenticatedAt: new Date(),
      uninstalledAt: null,
      redactedAt: null,
    },
  });
}

export async function markShopUninstalled(shop: string) {
  await db.session.deleteMany({ where: { shop } });
  return db.shopInstallation.upsert({
    where: { shop },
    create: {
      shop,
      myshopifyDomain: shop,
      installationStatus: "uninstalled",
      uninstalledAt: new Date(),
    },
    update: {
      installationStatus: "uninstalled",
      uninstalledAt: new Date(),
    },
  });
}

export async function markShopRedacted(shop: string) {
  await db.session.deleteMany({ where: { shop } });
  await db.merchantSetting.deleteMany({ where: { shop } });
  return db.shopInstallation.upsert({
    where: { shop },
    create: {
      shop,
      myshopifyDomain: shop,
      installationStatus: "redacted",
      redactedAt: new Date(),
    },
    update: {
      shopName: null,
      scope: null,
      installationStatus: "redacted",
      redactedAt: new Date(),
    },
  });
}

export async function updateShopScopes(shop: string, scope: string) {
  return db.shopInstallation.upsert({
    where: { shop },
    create: {
      shop,
      myshopifyDomain: shop,
      scope,
      installationStatus: "installed",
    },
    update: {
      scope,
      installationStatus: "installed",
      lastAuthenticatedAt: new Date(),
    },
  });
}

export async function recordWebhookDelivery({
  webhookId,
  topic,
  shop,
  action,
}: {
  webhookId: string;
  topic: string;
  shop: string;
  action: string;
}) {
  try {
    await db.webhookDelivery.create({
      data: {
        webhookId,
        topic,
        shop,
        action,
      },
    });
    return { duplicate: false };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "P2002") return { duplicate: true };
    throw error;
  }
}

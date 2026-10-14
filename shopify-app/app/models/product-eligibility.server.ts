import db from "../db.server";

export const PRODUCT_GID_PREFIX = "gid://shopify/Product/";
const PRODUCT_GID_PATTERN = /^gid:\/\/shopify\/Product\/\d+$/;
const BULK_LIMIT = 50;

export type EligibilityState = {
  shopifyProductId: string;
  enabled: boolean;
  preferredImageId: string | null;
  preferredImageUrl: string | null;
  preferredVariantId: string | null;
  preferredVariantTitle: string | null;
};

export function assertProductGid(productId: string) {
  if (!PRODUCT_GID_PATTERN.test(productId)) {
    throw new Response("Invalid Shopify product id", { status: 400 });
  }
}

export function parseProductIds(formData: FormData) {
  const raw = formData.getAll("productId").flatMap((value) => String(value).split(","));
  const ids = [...new Set(raw.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) throw new Response("No products selected", { status: 400 });
  if (ids.length > BULK_LIMIT) throw new Response(`Bulk actions are limited to ${BULK_LIMIT} products`, { status: 400 });
  ids.forEach(assertProductGid);
  return ids;
}

export async function getEligibilityMap(shop: string, productIds: string[]) {
  if (productIds.length === 0) return new Map<string, EligibilityState>();

  const records = await db.shopifyProductEligibility.findMany({
    where: {
      shop,
      shopifyProductId: { in: productIds },
    },
  });

  return new Map(
    records.map((record) => [
      record.shopifyProductId,
      {
        shopifyProductId: record.shopifyProductId,
        enabled: record.enabled,
        preferredImageId: record.preferredImageId,
        preferredImageUrl: record.preferredImageUrl,
        preferredVariantId: record.preferredVariantId,
        preferredVariantTitle: record.preferredVariantTitle,
      },
    ]),
  );
}

export async function countEnabledProducts(shop: string) {
  return db.shopifyProductEligibility.count({ where: { shop, enabled: true } });
}

export async function listEnabledProductIds(shop: string) {
  const records = await db.shopifyProductEligibility.findMany({
    where: { shop, enabled: true },
    orderBy: { updatedAt: "desc" },
    select: { shopifyProductId: true },
  });
  return records.map((record) => record.shopifyProductId);
}

export async function setProductEligibility({
  shop,
  productId,
  enabled,
  preferredImageId,
  preferredImageUrl,
  preferredVariantId,
  preferredVariantTitle,
}: {
  shop: string;
  productId: string;
  enabled: boolean;
  preferredImageId?: string | null;
  preferredImageUrl?: string | null;
  preferredVariantId?: string | null;
  preferredVariantTitle?: string | null;
}) {
  assertProductGid(productId);

  const record = await db.shopifyProductEligibility.upsert({
    where: {
      shop_shopifyProductId: {
        shop,
        shopifyProductId: productId,
      },
    },
    create: {
      shop,
      shopifyProductId: productId,
      enabled,
      preferredImageId: preferredImageId || null,
      preferredImageUrl: preferredImageUrl || null,
      preferredVariantId: preferredVariantId || null,
      preferredVariantTitle: preferredVariantTitle || null,
    },
    update: {
      enabled,
      preferredImageId: preferredImageId === undefined ? undefined : preferredImageId,
      preferredImageUrl: preferredImageUrl === undefined ? undefined : preferredImageUrl,
      preferredVariantId: preferredVariantId === undefined ? undefined : preferredVariantId,
      preferredVariantTitle: preferredVariantTitle === undefined ? undefined : preferredVariantTitle,
    },
  });

  return {
    shopifyProductId: record.shopifyProductId,
    enabled: record.enabled,
    preferredImageId: record.preferredImageId,
    preferredImageUrl: record.preferredImageUrl,
    preferredVariantId: record.preferredVariantId,
    preferredVariantTitle: record.preferredVariantTitle,
  };
}

export async function bulkSetProductEligibility({
  shop,
  productIds,
  enabled,
}: {
  shop: string;
  productIds: string[];
  enabled: boolean;
}) {
  if (productIds.length > BULK_LIMIT) throw new Response(`Bulk actions are limited to ${BULK_LIMIT} products`, { status: 400 });
  productIds.forEach(assertProductGid);

  await db.$transaction(
    productIds.map((productId) =>
      db.shopifyProductEligibility.upsert({
        where: {
          shop_shopifyProductId: {
            shop,
            shopifyProductId: productId,
          },
        },
        create: {
          shop,
          shopifyProductId: productId,
          enabled,
        },
        update: { enabled },
      }),
    ),
  );

  return { count: productIds.length, enabled };
}

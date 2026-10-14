import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { PrismaClient } from "@prisma/client";

const root = process.cwd();
const read = (file) => readFileSync(path.join(root, file), "utf8");
const db = new PrismaClient();
const productId = "gid://shopify/Product/1234567890";
const shopA = "phase3-a.myshopify.com";
const shopB = "phase3-b.myshopify.com";

test.after(async () => {
  await db.shopifyProductEligibility.deleteMany({
    where: { shop: { in: [shopA, shopB] } },
  });
  await db.$disconnect();
});

test("Phase 3 keeps the exact approved Shopify product read scope", () => {
  const config = read("shopify.app.toml");
  assert.match(config, /scopes\s*=\s*"read_products"/);
  assert.doesNotMatch(
    config,
    /write_products|read_orders|write_orders|read_customers|write_customers|read_themes|write_themes|read_metaobjects|write_metaobjects/,
  );
});

test("Product eligibility schema is merchant scoped", () => {
  const schema = read("prisma/schema.prisma");
  assert.match(schema, /model ShopifyProductEligibility/);
  assert.match(schema, /shop\s+String/);
  assert.match(schema, /shopifyProductId\s+String/);
  assert.match(schema, /@@unique\(\[shop, shopifyProductId\]\)/);
  assert.match(schema, /@@index\(\[shop, enabled\]\)/);
});

test("Product routes derive shop from Shopify Admin authentication", () => {
  const layoutRoute = read("app/routes/app.products.tsx");
  const listRoute = read("app/routes/app.products._index.tsx");
  const detailRoute = read("app/routes/app.products.details.tsx");
  assert.match(layoutRoute, /<Outlet\s*\/>/);
  assert.doesNotMatch(layoutRoute, /listProducts|Product eligibility|Details/);
  [listRoute, detailRoute].forEach((source) => {
    assert.match(source, /authenticate\.admin\(request\)/);
    assert.match(source, /session\.shop/);
    assert.doesNotMatch(source, /formData\.get\(["']shop["']\)|searchParams\.get\(["']shop["']\)/);
  });
});

test("Product details route and links resolve outside the listing component", () => {
  const layoutRoute = read("app/routes/app.products.tsx");
  const listRoute = read("app/routes/app.products._index.tsx");
  const detailRoute = read("app/routes/app.products.details.tsx");

  assert.match(layoutRoute, /Outlet/);
  assert.match(listRoute, /\/app\/products\/details\?productId=\$\{encodeURIComponent\(product\.id\)\}/);
  assert.match(detailRoute, /function productIdFromUrl/);
  assert.match(detailRoute, /assertProductGid\(productId\)/);
  assert.match(detailRoute, /getProductDetail\(admin, session\.shop, productId\)/);
  assert.match(detailRoute, /Back to products/);
  assert.match(detailRoute, /Variant previews/);
  assert.match(detailRoute, /variant\.price/);
});

test("Product integration uses Shopify GraphQL reads without product writes", () => {
  const service = read("app/services/shopify-products.server.ts");
  assert.match(service, /products\(first:/);
  assert.match(service, /productsCount\(query:/);
  assert.match(service, /title:\*\$\{escapeSearchValue\(safeSearch\)\}\*/);
  assert.match(service, /featuredMedia/);
  assert.match(service, /variants\(first: 8\)/);
  assert.doesNotMatch(service, /productCreate|productUpdate|productDelete|mutation/i);
});

test("Pagination preserves cursor filters and uses a development-only page-size override", () => {
  const service = read("app/services/shopify-products.server.ts");
  const listRoute = read("app/routes/app.products._index.tsx");

  assert.match(service, /process\.env\.NODE_ENV === "production"\) return PAGE_SIZE/);
  assert.match(service, /LOOKMEFY_PRODUCT_PAGE_SIZE/);
  assert.match(service, /Math\.min\(Math\.max\(parsed, MIN_DEV_PAGE_SIZE\), MAX_DEV_PAGE_SIZE\)/);
  assert.match(service, /first: direction === "next" \? pageSize : undefined/);
  assert.match(service, /last: direction === "previous" \? pageSize : undefined/);
  assert.match(listRoute, /params\.delete\("cursor"\)/);
  assert.match(listRoute, /params\.delete\("direction"\)/);
  assert.match(listRoute, /currentParams\.set\("q", result\.search\)/);
  assert.match(listRoute, /currentParams\.set\("filter", result\.filter\)/);
  assert.match(listRoute, /currentParams\.set\("status", result\.status\)/);
  assert.match(listRoute, /currentParams\.set\("productType", result\.productType\)/);
  assert.match(listRoute, /result\.pageInfo\.hasNextPage/);
  assert.match(listRoute, /result\.pageInfo\.hasPreviousPage/);
});

test("Prisma stores eligibility separately for each merchant shop", async () => {
  await db.shopifyProductEligibility.deleteMany({
    where: { shop: { in: [shopA, shopB] } },
  });

  await db.shopifyProductEligibility.create({
    data: { shop: shopA, shopifyProductId: productId, enabled: true },
  });
  await db.shopifyProductEligibility.create({
    data: { shop: shopB, shopifyProductId: productId, enabled: false },
  });

  const [recordA, recordB] = await Promise.all([
    db.shopifyProductEligibility.findUniqueOrThrow({
      where: { shop_shopifyProductId: { shop: shopA, shopifyProductId: productId } },
    }),
    db.shopifyProductEligibility.findUniqueOrThrow({
      where: { shop_shopifyProductId: { shop: shopB, shopifyProductId: productId } },
    }),
  ]);

  assert.equal(recordA.enabled, true);
  assert.equal(recordB.enabled, false);

  await assert.rejects(
    () =>
      db.shopifyProductEligibility.create({
        data: { shop: shopA, shopifyProductId: productId, enabled: false },
      }),
    /Unique constraint failed/,
  );
});

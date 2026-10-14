import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (file) => readFileSync(path.join(root, file), "utf8");

test("Phase 1 documents are preserved", () => {
  [
    "docs/PHASE-1-AUDIT.md",
    "docs/ARCHITECTURE.md",
    "docs/IMPLEMENTATION-ROADMAP.md",
    "docs/REUSABLE-COMPONENTS.md",
    "docs/SHOPIFY-REQUIREMENTS.md",
    "docs/PHASE-STATUS.md",
  ].forEach((file) => assert.equal(existsSync(path.join(root, file)), true, file));
});

test("Shopify app config keeps approved scopes minimal and privacy webhooks configured", () => {
  const config = read("shopify.app.toml");
  assert.match(config, /embedded\s*=\s*true/);
  assert.match(config, /scopes\s*=\s*"read_products"/);
  assert.match(config, /topics\s*=\s*\[\s*"app\/uninstalled"\s*\]/);
  assert.match(config, /topics\s*=\s*\[\s*"app\/scopes_update"\s*\]/);
  assert.match(config, /compliance_topics\s*=\s*\[\s*"customers\/data_request",\s*"customers\/redact",\s*"shop\/redact"\s*\]/);
  assert.doesNotMatch(config, /write_products|write_metaobjects|write_metaobject_definitions|read_orders|read_customers|write_themes/);
});

test("Prisma schema contains isolated Shopify foundation models", () => {
  const schema = read("prisma/schema.prisma");
  assert.match(schema, /model Session/);
  assert.match(schema, /model ShopInstallation/);
  assert.match(schema, /model MerchantSetting/);
  assert.match(schema, /model WebhookDelivery/);
});

test("Merchant dashboard does not include template product creation demo", () => {
  const dashboard = read("app/routes/app._index.tsx");
  assert.match(dashboard, /Lookmefy AI Virtual Try-On/);
  assert.match(dashboard, /Manage products/);
  assert.doesNotMatch(dashboard, /productCreate|Generate a product|Snowboard/);
});

test("Webhook handlers authenticate and dedupe lifecycle deliveries", () => {
  const uninstall = read("app/routes/webhooks.app.uninstalled.tsx");
  const scopes = read("app/routes/webhooks.app.scopes_update.tsx");
  const privacy = read("app/routes/webhooks.privacy.tsx");
  [uninstall, scopes, privacy].forEach((source) => {
    assert.match(source, /authenticate\.webhook/);
    assert.match(source, /recordWebhookDelivery/);
  });
  assert.match(uninstall, /markShopUninstalled/);
  assert.match(scopes, /updateShopScopes/);
  assert.match(privacy, /markShopRedacted/);
});

test("No local credential files are present in the Shopify app tree", async () => {
  const names = await readdir(root, { recursive: true });
  const disallowed = names.filter((name) =>
    /(^|\/)\.env$|(^|\/)\.env\.(?!example$)/.test(
      String(name),
    ),
  );
  assert.deepEqual(disallowed, []);
});


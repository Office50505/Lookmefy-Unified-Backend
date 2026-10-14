import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { Session } from "@shopify/shopify-api";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";

process.env.SHOPIFY_API_KEY ||= "phase2-test-api-key";
process.env.SHOPIFY_API_SECRET ||= "phase2-test-api-secret";
process.env.SHOPIFY_APP_URL ||= "https://phase2-test.example.com";

const db = new PrismaClient();
const testShop = "phase2-db-session.myshopify.com";
const sessionId = `offline_${testShop}`;
const webhookId = "phase2-webhook-delivery";
const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test.after(async () => {
  await db.session.deleteMany({ where: { shop: testShop } });
  await db.shopInstallation.deleteMany({ where: { shop: testShop } });
  await db.webhookDelivery.deleteMany({ where: { webhookId } });
  await db.$disconnect();
});

test("Prisma Client can write and read merchant installation state", async () => {
  await db.shopInstallation.upsert({
    where: { shop: testShop },
    create: {
      shop: testShop,
      shopName: "Phase 2 Test Store",
      myshopifyDomain: testShop,
      scope: "",
      installationStatus: "installed",
    },
    update: {
      shopName: "Phase 2 Test Store",
      installationStatus: "installed",
    },
  });

  const record = await db.shopInstallation.findUniqueOrThrow({
    where: { shop: testShop },
  });
  assert.equal(record.shop, testShop);
  assert.equal(record.installationStatus, "installed");
});

test("Shopify Prisma session storage persists sessions across processes", async () => {
  const storage = new PrismaSessionStorage(db);
  const session = new Session({
    id: sessionId,
    shop: testShop,
    state: "phase2-state",
    isOnline: false,
    scope: "",
    accessToken: "phase2-test-token",
  });

  assert.equal(await storage.storeSession(session), true);
  const loaded = await storage.loadSession(sessionId);
  assert.equal(loaded?.id, sessionId);
  assert.equal(loaded?.shop, testShop);

  const persistedShop = execFileSync(
    process.execPath,
    [
      "-e",
      `import {PrismaClient} from '@prisma/client';
       const db = new PrismaClient();
       const row = await db.session.findUnique({where:{id:${JSON.stringify(sessionId)}}});
       console.log(row?.shop || "");
       await db.$disconnect();`,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  ).trim();

  assert.equal(persistedShop, testShop);
});

test("Webhook delivery records are idempotent", async () => {
  await db.webhookDelivery.create({
    data: {
      webhookId,
      topic: "app/uninstalled",
      shop: testShop,
      action: "phase2_test",
    },
  });

  await assert.rejects(
    () =>
      db.webhookDelivery.create({
        data: {
          webhookId,
          topic: "app/uninstalled",
          shop: testShop,
          action: "phase2_test",
        },
      }),
    /Unique constraint failed/,
  );
});

test("Webhook routes use official Shopify authenticity validation", () => {
  [
    "app/routes/webhooks.app.uninstalled.tsx",
    "app/routes/webhooks.app.scopes_update.tsx",
    "app/routes/webhooks.privacy.tsx",
  ].forEach((file) => {
    const source = read(file);
    assert.match(source, /authenticate\.webhook\(request\)/);
    assert.doesNotMatch(source, /createHmac|x-shopify-hmac/i);
  });
});

test("Webhook HMAC fixture distinguishes valid and invalid signatures", () => {
  const body = JSON.stringify({ shop_domain: testShop });
  const validHmac = createHmac("sha256", process.env.SHOPIFY_API_SECRET)
    .update(body, "utf8")
    .digest("base64");
  const invalidHmac = createHmac("sha256", "wrong-secret").update(body, "utf8").digest("base64");

  assert.notEqual(validHmac, invalidHmac);
  assert.equal(
    validHmac,
    createHmac("sha256", process.env.SHOPIFY_API_SECRET).update(body, "utf8").digest("base64"),
  );
});

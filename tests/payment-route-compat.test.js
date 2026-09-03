import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('legacy mobile PhonePe route names are backed by Razorpay checkout payloads', async () => {
  const source = await fs.readFile('server/routes/payments.js', 'utf8');
  const topUpStart = source.indexOf("router.post('/phonepe/top-up'");
  const subscriptionStart = source.indexOf("router.post('/phonepe/subscription'");
  const verifyStart = source.indexOf("router.post('/razorpay/verify'");
  assert.ok(topUpStart > 0);
  assert.ok(subscriptionStart > topUpStart);
  assert.ok(verifyStart > subscriptionStart);

  const compatibilityRoutes = source.slice(topUpStart, verifyStart);
  assert.match(compatibilityRoutes, /createRazorpayPayment/);
  assert.match(compatibilityRoutes, /provider:\s*'razorpay'/);
  assert.match(compatibilityRoutes, /razorpayCheckoutPayload/);
  assert.doesNotMatch(compatibilityRoutes, /createPhonePePayment/);
  assert.doesNotMatch(compatibilityRoutes, /phonePeFetch/);
});

test('subscription status compatibility reads from the unified user subscription', async () => {
  const source = await fs.readFile('server/routes/payments.js', 'utf8');
  assert.match(source, /router\.get\('\/subscriptions\/current\/status'/);
  assert.match(source, /req\.user\.toClient\(\)\.subscription/);
  assert.match(source, /router\.post\('\/subscriptions\/current\/cancel'/);
});

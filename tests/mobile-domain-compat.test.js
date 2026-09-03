import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import {
  jobStateToMobileStatus,
  jobToMobilePayload
} from '../server/routes/jobs.js';
import {
  creditEventToClient,
  customHistoryItem,
  externalHistoryItem,
  productHistoryItem,
  tryOnMediaTokenKind
} from '../server/routes/tryons.js';
import { verifyMediaToken } from '../server/utils/mediaTokens.js';

function objectId() {
  return new mongoose.Types.ObjectId();
}

test('mobile job status aliases BullMQ states into app statuses', () => {
  assert.equal(jobStateToMobileStatus('completed'), 'succeeded');
  assert.equal(jobStateToMobileStatus('failed'), 'failed');
  assert.equal(jobStateToMobileStatus('active'), 'processing');
  assert.equal(jobStateToMobileStatus('waiting'), 'processing');

  const payload = jobToMobilePayload({
    id: 'tryon-job-1',
    queue: 'tryon',
    name: 'product-generate',
    state: 'completed',
    progress: 100,
    attemptsMade: 1,
    createdAt: '2026-09-03T01:00:00.000Z',
    processedAt: '2026-09-03T01:01:00.000Z',
    finishedAt: '2026-09-03T01:02:00.000Z',
    result: { ok: true }
  });
  assert.equal(payload.job.status, 'succeeded');
  assert.equal(payload.job.type, 'product-generate');
  assert.equal(payload.job.attempts, 1);
  assert.equal(payload.job.updatedAt, '2026-09-03T01:02:00.000Z');
  assert.equal(payload.statusUrl, '/api/jobs/tryon-job-1');
  assert.equal(payload.statusPath, '/jobs/tryon-job-1');
  assert.deepEqual(payload.result, { ok: true });
});

test('product try-on history item preserves mobile fields', () => {
  process.env.JWT_SECRET = 'mobile-domain-test-secret';
  const userId = objectId();
  const productId = objectId();
  const tryOnId = objectId();
  const item = productHistoryItem({
    _id: tryOnId,
    user: userId,
    product: {
      _id: productId,
      name: 'Straight Jeans',
      brand: 'Lookmefy',
      category: 'Jeans',
      gender: 'women',
      price: 2299,
      currency: 'INR',
      image: { path: 'uploads/products/jeans.jpg' },
      availabilityStatus: 'available'
    },
    image: { path: 'uploads/users/u/tryons/result.jpg' },
    tokenCost: 1,
    provider: 'pruna',
    model: 'p-image-try-on',
    createdAt: new Date('2026-09-02T10:00:00.000Z')
  });

  assert.equal(item.type, 'product');
  assert.equal(item.productId, productId.toString());
  assert.equal(item.title, 'Straight Jeans');
  assert.match(item.imageUrl, /^\/api\/tryons\/image\/product\//);
  assert.equal(item.sourceImageUrl, '/uploads/products/jeans.jpg');
  assert.equal(item.product.name, 'Straight Jeans');
  const url = new URL(item.imageUrl, 'https://lookmefy.test');
  const claims = verifyMediaToken(url.searchParams.get('mediaToken'), {
    mediaId: tryOnId.toString(),
    kind: tryOnMediaTokenKind({ kind: 'image', scope: 'product', field: 'image' })
  });
  assert.equal(claims.sub, userId.toString());
});

test('custom and external history items map app-compatible media fields', () => {
  process.env.JWT_SECRET = 'mobile-domain-test-secret';
  const customId = objectId();
  const customUserId = objectId();
  const custom = customHistoryItem({
    _id: customId,
    user: customUserId,
    garment: { filename: 'shirt.jpg', path: 'uploads/custom/shirt.jpg' },
    image: { path: 'uploads/custom/result.jpg' },
    tokenCost: 1,
    provider: 'fal',
    model: 'try-on',
    createdAt: new Date('2026-09-02T11:00:00.000Z')
  });
  assert.equal(custom.type, 'custom');
  assert.match(custom.sourceImageUrl, /^\/api\/tryons\/garment\/custom\//);
  const garmentUrl = new URL(custom.sourceImageUrl, 'https://lookmefy.test');
  const garmentClaims = verifyMediaToken(garmentUrl.searchParams.get('mediaToken'), {
    mediaId: customId.toString(),
    kind: tryOnMediaTokenKind({ kind: 'garment', scope: 'custom', field: 'garment' })
  });
  assert.equal(garmentClaims.sub, customUserId.toString());

  const external = externalHistoryItem({
    _id: objectId(),
    user: objectId(),
    productName: 'Printed Shirt',
    brand: 'Brand',
    sourceUrl: 'https://example.com/product',
    imageUrl: 'https://example.com/product.jpg',
    image: { path: 'uploads/external/result.jpg' },
    tokenCost: 1,
    provider: 'fal',
    model: 'try-on',
    createdAt: new Date('2026-09-02T12:00:00.000Z')
  });
  assert.equal(external.type, 'external');
  assert.equal(external.title, 'Printed Shirt');
  assert.equal(external.sourceImageUrl, 'https://example.com/product.jpg');
});

test('credit history formatter exposes shared ledger events to mobile', () => {
  const productId = objectId();
  const event = creditEventToClient({
    _id: objectId(),
    action: 'razorpay_topup',
    product: productId,
    productTitle: 'Top-up',
    tokens: 50,
    balanceAfter: 80,
    direction: 'credit',
    source: 'razorpay',
    sourceId: 'pay_123',
    createdAt: new Date('2026-09-02T13:00:00.000Z')
  });

  assert.equal(event.productId, productId.toString());
  assert.equal(event.tokens, 50);
  assert.equal(event.direction, 'credit');
  assert.equal(event.source, 'razorpay');
});

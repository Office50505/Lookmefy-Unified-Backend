import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import RequestMetric from '../server/models/RequestMetric.js';
import { falModelCostEstimate } from '../server/services/providerIntegrations.js';

test('request metrics retain unique instance buckets and expire by TTL', () => {
  const indexes = RequestMetric.schema.indexes();
  assert.ok(indexes.some(([fields, options]) => fields.bucketStart === 1 && fields.instanceId === 1 && fields.endpoint === 1 && options.unique));
  assert.ok(indexes.some(([fields, options]) => fields.expiresAt === 1 && options.expireAfterSeconds === 0));
});

test('PixVerse cost tracking uses the explicit fallback when live pricing is unavailable', async () => {
  const previousKey = process.env.FAL_KEY;
  const previousCost = process.env.PIXVERSE_VIDEO_COST_USD;
  delete process.env.FAL_KEY;
  process.env.PIXVERSE_VIDEO_COST_USD = '0.42';
  try {
    const pricing = await falModelCostEstimate({ endpointId: 'fal-ai/pixverse/v6/image-to-video', duration: 5 });
    assert.equal(pricing.cost, 0.42);
    assert.equal(pricing.source, 'manual');
  } finally {
    if (previousKey === undefined) delete process.env.FAL_KEY;
    else process.env.FAL_KEY = previousKey;
    if (previousCost === undefined) delete process.env.PIXVERSE_VIDEO_COST_USD;
    else process.env.PIXVERSE_VIDEO_COST_USD = previousCost;
  }
});

test('admin media and list APIs include videos and server-side pagination', async () => {
  const [authSource, productSource, mediaSource] = await Promise.all([
    fs.readFile(new URL('../server/routes/auth.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../server/routes/products.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../server/services/adminMediaUsage.js', import.meta.url), 'utf8')
  ]);
  assert.match(authSource, /include\('video'\)/);
  assert.match(authSource, /\/admin\/orders/);
  assert.match(authSource, /\/admin\/search/);
  assert.match(authSource, /\.skip\(\(page - 1\) \* limit\)/);
  assert.match(productSource, /\.skip\(offset\)\.limit\(limit\)/);
  assert.match(mediaSource, /group: 'video'.*field: 'video'/);
  assert.match(mediaSource, /MEDIA_ORPHAN_DELETE_MIN_AGE_DAYS/);
});

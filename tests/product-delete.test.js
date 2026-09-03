import assert from 'node:assert/strict';
import test from 'node:test';
import productRouter from '../server/routes/products.js';
import { deleteStoredFile } from '../server/utils/storage.js';

function permanentDeleteHandler() {
  const layer = productRouter.stack.find((item) => item.route?.path === '/:id/permanent' && item.route.methods.delete);
  assert.ok(layer, 'permanent product delete route should exist');
  return layer.route.stack.at(-1).handle;
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

test('permanent product deletion requires the exact typed confirmation', async () => {
  const response = responseRecorder();
  await permanentDeleteHandler()({ body: {}, params: { id: '64b7f6f5e6a1f123456789ab' } }, response);

  assert.equal(response.statusCode, 400);
  assert.match(response.body.message, /Type DELETE/);
});

test('permanent product deletion rejects malformed product ids before database work', async () => {
  const response = responseRecorder();
  await permanentDeleteHandler()({ body: { confirmation: 'DELETE' }, params: { id: 'not-an-id' } }, response);

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.message, 'Invalid product id');
});

test('storage cleanup ignores temporary API proxy media', async () => {
  const previousProvider = process.env.STORAGE_PROVIDER;
  process.env.STORAGE_PROVIDER = 'bunny';
  try {
    await assert.doesNotReject(() => deleteStoredFile({
      url: '/api/tryons/64b7f6f5e6a1f123456789ab/video/media',
      storage: 'pruna-proxy'
    }));
  } finally {
    if (previousProvider === undefined) delete process.env.STORAGE_PROVIDER;
    else process.env.STORAGE_PROVIDER = previousProvider;
  }
});

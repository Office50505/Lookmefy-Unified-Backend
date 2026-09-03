import assert from 'node:assert/strict';
import test from 'node:test';
import authRouter from '../server/routes/auth.js';

function routeHandler(path) {
  const layer = authRouter.stack.find((item) => item.route?.path === path && item.route.methods.get);
  assert.ok(layer, `${path} route should exist`);
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

test('admin user media rejects malformed user ids before database work', async () => {
  const response = responseRecorder();
  await routeHandler('/admin/users/:id/media')({ params: { id: 'not-an-id' }, query: {} }, response);

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.message, 'Invalid user id');
});

test('admin user insights reject malformed user ids before database work', async () => {
  const response = responseRecorder();
  await routeHandler('/admin/users/:id/insights')({ params: { id: 'not-an-id' }, query: {} }, response);

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.message, 'Invalid user id');
});

test('admin storage rejects unknown media groups before database work', async () => {
  const response = responseRecorder();
  await routeHandler('/admin/storage')({ query: { type: 'secrets' } }, response);

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.message, 'Invalid storage media type');
});

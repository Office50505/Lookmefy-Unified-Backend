import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveProtectedMediaUrl } from '../src/utils/media.js';

test('history images and videos resolve to the API host and retain their signed token', () => {
  for (const kind of ['image', 'video']) {
    const path = `/api/tryons/${kind}/product/example?mediaToken=signed-resource-token`;
    for (const apiBaseUrl of ['https://api.lookmefy.in', 'https://api.lookmefy.in/api/']) {
      const result = resolveProtectedMediaUrl(path, { apiBaseUrl, mediaToken: 'upload-token' });
      const request = new URL(result, 'https://lookmefy.in');
      assert.equal(request.origin, 'https://api.lookmefy.in');
      assert.equal(request.pathname, `/api/tryons/${kind}/product/example`);
      assert.deepEqual(request.searchParams.getAll('mediaToken'), ['signed-resource-token']);
    }
  }
});

test('same-origin deployments retain relative generated media URLs', () => {
  const path = '/api/tryons/image/custom/example?mediaToken=signed';
  assert.equal(resolveProtectedMediaUrl(path), path);
});

test('uploads keep authentication, existing query parameters, and existing tokens', () => {
  const options = { apiBaseUrl: 'https://api.lookmefy.in/api', mediaToken: 'a+b' };
  assert.equal(resolveProtectedMediaUrl('/uploads/image.png?v=2', options), 'https://api.lookmefy.in/uploads/image.png?v=2&mediaToken=a%2Bb');
  assert.equal(resolveProtectedMediaUrl('/uploads/image.png?mediaToken=existing', options), 'https://api.lookmefy.in/uploads/image.png?mediaToken=existing');
});

test('external, inline, and static images never receive upload credentials', () => {
  for (const value of ['https://cdn.example/image.png', '//cdn.example/image.png', 'data:image/png;base64,abc', 'blob:https://lookmefy.in/id', '/assets/hero2.png', '']) {
    assert.equal(resolveProtectedMediaUrl(value, { apiBaseUrl: 'https://api.lookmefy.in', mediaToken: 'private' }), value);
  }
  assert.equal(resolveProtectedMediaUrl(null), '');
});

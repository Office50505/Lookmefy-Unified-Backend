import assert from 'node:assert/strict';
import test from 'node:test';
import { redactSensitiveText, requestPath } from '../server/utils/logSanitization.js';

test('request logging excludes query strings', () => {
  assert.equal(requestPath({ path: '/api/tryons/abc/video/media', originalUrl: '/api/tryons/abc/video/media?mediaToken=secret' }), '/api/tryons/abc/video/media');
  assert.equal(requestPath({ originalUrl: '/api/uploads/photo.jpg?token=secret&v=1' }), '/api/uploads/photo.jpg');
});

test('sensitive values are redacted from arbitrary log text', () => {
  const text = redactSensitiveText('authorization=Bearer-secret OTP=123456 https://example.test/media?mediaToken=abc&v=1');
  assert.doesNotMatch(text, /Bearer-secret|123456|mediaToken=abc/);
  assert.match(text, /mediaToken=\[redacted\]/);
  assert.match(text, /v=1/);
});

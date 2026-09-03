import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import TryOn, { tryOnToClient } from '../server/models/TryOn.js';
import { signMediaToken, signUserMediaToken, verifyMediaToken, verifyUserMediaToken } from '../server/utils/mediaTokens.js';

const env = {
  JWT_SECRET: 'media-token-test-secret-with-enough-randomness',
  MEDIA_TOKEN_TTL_SECONDS: '120'
};

test('private media tokens are short-lived and scoped to one user and media item', () => {
  const token = signMediaToken({ userId: 'user-1', mediaId: 'media-1', kind: 'tryon-video' }, { env });
  const claims = verifyMediaToken(token, { mediaId: 'media-1', kind: 'tryon-video', env });
  assert.equal(claims.sub, 'user-1');
  assert.ok(claims.exp - claims.iat <= 120);
  assert.throws(() => verifyMediaToken(token, { mediaId: 'media-2', kind: 'tryon-video', env }), /does not match/);
  assert.throws(() => verifyMediaToken(token, { mediaId: 'media-1', kind: 'profile-photo', env }), /wrong scope/);
});

test('user media tokens cannot be used as general session tokens or for another user', () => {
  const token = signUserMediaToken('user-1', { env });
  assert.equal(verifyUserMediaToken(token, { env }).sub, 'user-1');
  assert.throws(() => verifyMediaToken(token, { mediaId: 'user-2', kind: 'user-media', env }), /does not match/);
  assert.throws(() => verifyMediaToken(token, { mediaId: 'user-1', kind: 'tryon-video', env }), /wrong scope/);
});

test('provider-proxy videos receive fresh media-scoped client URLs', () => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = env.JWT_SECRET;
  try {
    const tryOn = new TryOn({
      _id: new mongoose.Types.ObjectId(),
      user: new mongoose.Types.ObjectId(),
      product: new mongoose.Types.ObjectId(),
      image: { path: 'users/example/tryons/image.jpg' },
      video: { providerOutputUrl: 'https://provider.example/private/video.mp4', storageStatus: 'saving' }
    });
    const client = tryOnToClient(tryOn);
    const parsed = new URL(client.videoUrl, 'https://api.lookmefy.in');
    assert.match(parsed.pathname, /^\/api\/tryons\/[a-f0-9]{24}\/video\/media$/);
    assert.ok(parsed.searchParams.get('mediaToken'));
    assert.equal(client.videoUrl.includes('provider.example'), false);
  } finally {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import {
  closetMediaTokenKind,
  itemToClient,
  outfitToClient
} from '../server/routes/closet.js';
import { verifyMediaToken } from '../server/utils/mediaTokens.js';

function objectId() {
  return new mongoose.Types.ObjectId();
}

test('closet items expose signed mobile media proxy urls', () => {
  process.env.JWT_SECRET = 'closet-media-test-secret';
  const userId = objectId();
  const itemId = objectId();
  const client = itemToClient({
    _id: itemId,
    user: userId,
    name: 'Linen shirt',
    category: 'tops',
    image: { path: 'uploads/closet/shirt.jpg', mimetype: 'image/jpeg' }
  });

  assert.match(client.imageUrl, /^\/api\/closet\/media\/item\//);
  const url = new URL(client.imageUrl, 'https://lookmefy.test');
  const claims = verifyMediaToken(url.searchParams.get('mediaToken'), {
    mediaId: itemId.toString(),
    kind: closetMediaTokenKind('item')
  });
  assert.equal(claims.sub, userId.toString());
});

test('closet items use direct CDN urls for Bunny-backed media', () => {
  const previousCdn = process.env.BUNNY_CDN_BASE_URL;
  process.env.JWT_SECRET = 'closet-media-test-secret';
  process.env.BUNNY_CDN_BASE_URL = 'https://cdn.lookmefy.test/';
  const userId = objectId();
  const itemId = objectId();

  try {
    const client = itemToClient({
      _id: itemId,
      user: userId,
      name: 'Silk blouse',
      category: 'tops',
      image: {
        path: `uploads/users/${userId.toString()}/closet/silk-blouse.jpg`,
        storage: 'bunny',
        mimetype: 'image/jpeg'
      }
    });

    assert.equal(client.imageUrl, `https://cdn.lookmefy.test/users/${userId.toString()}/closet/silk-blouse.jpg`);
  } finally {
    if (previousCdn === undefined) delete process.env.BUNNY_CDN_BASE_URL;
    else process.env.BUNNY_CDN_BASE_URL = previousCdn;
  }
});

test('closet outfits expose signed outfit and garment media proxy urls', () => {
  process.env.JWT_SECRET = 'closet-media-test-secret';
  const userId = objectId();
  const outfitId = objectId();
  const client = outfitToClient({
    _id: outfitId,
    user: userId,
    title: 'Generated outfit',
    itemIds: [],
    image: { path: 'uploads/closet/outfit.jpg', mimetype: 'image/jpeg' },
    garment: { path: 'uploads/closet/garment.jpg', mimetype: 'image/jpeg' }
  });

  assert.match(client.imageUrl, /^\/api\/closet\/media\/outfit\//);
  assert.match(client.garmentUrl, /^\/api\/closet\/media\/garment\//);

  const imageUrl = new URL(client.imageUrl, 'https://lookmefy.test');
  const imageClaims = verifyMediaToken(imageUrl.searchParams.get('mediaToken'), {
    mediaId: outfitId.toString(),
    kind: closetMediaTokenKind('outfit')
  });
  assert.equal(imageClaims.sub, userId.toString());

  const garmentUrl = new URL(client.garmentUrl, 'https://lookmefy.test');
  const garmentClaims = verifyMediaToken(garmentUrl.searchParams.get('mediaToken'), {
    mediaId: outfitId.toString(),
    kind: closetMediaTokenKind('garment')
  });
  assert.equal(garmentClaims.sub, userId.toString());
});

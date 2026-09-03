import assert from 'node:assert/strict';
import test from 'node:test';
import { imageMimeTypeFromBytes, selectFitRoomClosetPlan } from '../server/routes/closet.js';

function closetItem(overrides = {}) {
  const id = overrides.id || `${overrides.category || 'item'}-1`;
  return {
    _id: { toString: () => id },
    name: overrides.name || 'Closet item',
    category: overrides.category || 'tops',
    color: '',
    fabric: '',
    pattern: '',
    season: 'all-season',
    formality: 'any',
    tags: [],
    occasions: [],
    visualProfile: null,
    image: { path: `uploads/${id}.jpg` },
    ...overrides
  };
}

test('selectFitRoomClosetPlan uses lower cloth type for a bottom-only look', () => {
  const plan = selectFitRoomClosetPlan([
    closetItem({ id: 'bottom-1', name: 'Blue bottoms', category: 'bottoms' })
  ]);

  assert.equal(plan.clothType, 'lower');
  assert.equal(plan.garmentItem.name, 'Blue bottoms');
  assert.equal(plan.requiresWan, false);
});

test('selectFitRoomClosetPlan keeps combo metadata for upper and lower items', () => {
  const plan = selectFitRoomClosetPlan([
    closetItem({ id: 'top-1', name: 'Black tee', category: 'tops' }),
    closetItem({ id: 'bottom-1', name: 'Blue jeans', category: 'bottoms' })
  ]);

  assert.equal(plan.clothType, 'combo');
  assert.equal(plan.upperItem.name, 'Black tee');
  assert.equal(plan.lowerItem.name, 'Blue jeans');
  assert.deepEqual(plan.renderedItemIds, ['top-1', 'bottom-1']);
  assert.equal(plan.requiresWan, true);
  assert.deepEqual(plan.ignoredItems, []);
});

test('selectFitRoomClosetPlan keeps one-piece garments as full_set', () => {
  const plan = selectFitRoomClosetPlan([
    closetItem({ id: 'dress-1', name: 'Evening dress', category: 'dresses' })
  ]);

  assert.equal(plan.clothType, 'full_set');
  assert.equal(plan.garmentItem.name, 'Evening dress');
  assert.equal(plan.requiresWan, false);
});

test('selectFitRoomClosetPlan routes accessory-only looks through Wan', () => {
  const plan = selectFitRoomClosetPlan([
    closetItem({ id: 'shoe-1', name: 'Loafers', category: 'shoes' }),
    closetItem({ id: 'cap-1', name: 'Cap', category: 'accessories' })
  ]);

  assert.equal(plan.clothType, 'wardrobe_multi');
  assert.equal(plan.requiresWan, true);
  assert.equal(plan.items.length, 2);
  assert.deepEqual(plan.ignoredItems, []);
});

test('selectFitRoomClosetPlan tracks extra pieces while routing through Wan', () => {
  const plan = selectFitRoomClosetPlan([
    closetItem({ id: 'top-1', name: 'Black tee', category: 'tops' }),
    closetItem({ id: 'bottom-1', name: 'Blue jeans', category: 'bottoms' }),
    closetItem({ id: 'shoe-1', name: 'Loafers', category: 'shoes' })
  ]);

  assert.equal(plan.clothType, 'combo');
  assert.equal(plan.requiresWan, true);
  assert.deepEqual(plan.renderedItemIds, ['top-1', 'bottom-1']);
  assert.deepEqual(plan.ignoredItems.map((item) => item.name), ['Loafers']);
});

test('imageMimeTypeFromBytes detects WebP even when provider headers are wrong', () => {
  const webpHeader = Buffer.from('52494646000000005745425056503820', 'hex');
  assert.equal(imageMimeTypeFromBytes(webpHeader), 'image/webp');
});

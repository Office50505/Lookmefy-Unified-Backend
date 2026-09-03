import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateModelPlacement, normalizedPlacement } from '../src/utils/modelPlacement.js';

test('normalizedPlacement clamps manual model adjustments', () => {
  assert.deepEqual(normalizedPlacement({ x: 5, floorY: 0.1, scale: 9 }), {
    x: 0.74,
    floorY: 0.72,
    scale: 1.25
  });
});

test('calculateModelPlacement preserves aspect ratio and stage bounds', () => {
  const placement = calculateModelPlacement({
    stageWidth: 1200,
    stageHeight: 900,
    imageWidth: 500,
    imageHeight: 1000,
    placement: { x: 0.5, floorY: 0.92, scale: 1 }
  });

  assert.equal(Math.round(placement.modelHeight / placement.modelWidth), 2);
  assert.ok(placement.bottom >= 0);
  assert.ok(placement.leftPercent > 0);
  assert.ok(placement.leftPercent < 100);
  assert.ok(placement.modelHeight <= 900 * 0.82);
});

test('calculateModelPlacement reduces scale on narrow stages', () => {
  const desktop = calculateModelPlacement({
    stageWidth: 1280,
    stageHeight: 900,
    imageWidth: 480,
    imageHeight: 1000,
    placement: { x: 0.5, floorY: 0.92, scale: 1 }
  });
  const mobile = calculateModelPlacement({
    stageWidth: 390,
    stageHeight: 720,
    imageWidth: 480,
    imageHeight: 1000,
    placement: { x: 0.5, floorY: 0.92, scale: 1 }
  });

  assert.ok(mobile.modelHeight < desktop.modelHeight);
  assert.ok(mobile.modelWidth <= 390 * 0.62);
});

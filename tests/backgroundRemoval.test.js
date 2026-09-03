import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import sharp from 'sharp';
import { alphaBoundsFromRaw, alphaStatsForBuffer, analyzeCutoutQuality, hasUsableTransparency, removeBackground } from '../server/utils/backgroundRemoval.js';

test('alphaBoundsFromRaw returns the visible alpha rectangle', () => {
  const width = 4;
  const height = 3;
  const raw = Buffer.alloc(width * height * 4);
  const visiblePixels = [
    [1, 1],
    [2, 1]
  ];
  for (const [x, y] of visiblePixels) {
    raw[(y * width + x) * 4 + 3] = 255;
  }

  assert.deepEqual(alphaBoundsFromRaw(raw, width, height), {
    x: 1,
    y: 1,
    width: 2,
    height: 1,
    pixelCount: 2
  });
});

async function cutoutFixture({ torsoHole = false, missingFeet = false } = {}) {
  const width = 180;
  const height = 320;
  const raw = Buffer.alloc(width * height * 4);
  const paintRect = (x1, y1, x2, y2, rgba) => {
    for (let y = y1; y < y2; y += 1) {
      for (let x = x1; x < x2; x += 1) {
        const offset = (y * width + x) * 4;
        raw[offset] = rgba[0];
        raw[offset + 1] = rgba[1];
        raw[offset + 2] = rgba[2];
        raw[offset + 3] = rgba[3];
      }
    }
  };
  const paintEllipse = (cx, cy, rx, ry, rgba) => {
    for (let y = Math.max(0, cy - ry); y < Math.min(height, cy + ry); y += 1) {
      for (let x = Math.max(0, cx - rx); x < Math.min(width, cx + rx); x += 1) {
        const dx = (x - cx) / rx;
        const dy = (y - cy) / ry;
        if (dx * dx + dy * dy > 1) continue;
        const offset = (y * width + x) * 4;
        raw[offset] = rgba[0];
        raw[offset + 1] = rgba[1];
        raw[offset + 2] = rgba[2];
        raw[offset + 3] = rgba[3];
      }
    }
  };
  paintEllipse(90, 44, 26, 32, [34, 34, 34, 255]);
  paintRect(58, 78, 122, 170, [255, 255, 255, 255]);
  paintRect(34, 88, 66, 208, [215, 163, 133, 255]);
  paintRect(114, 88, 146, 208, [215, 163, 133, 255]);
  paintRect(60, 166, 86, 274, [34, 34, 34, 255]);
  paintRect(94, 166, 120, 274, [34, 34, 34, 255]);
  paintRect(44, 266, 86, 284, [255, 255, 255, 255]);
  paintRect(94, 266, 136, 284, [255, 255, 255, 255]);
  if (torsoHole) paintEllipse(90, 122, 20, 28, [255, 255, 255, 0]);
  if (missingFeet) paintRect(35, 180, 145, 292, [255, 255, 255, 0]);
  return sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

test('analyzeCutoutQuality accepts one coherent full-body cutout with white clothes and shoes', async () => {
  const quality = await analyzeCutoutQuality(await cutoutFixture());
  assert.equal(quality.passed, true);
  assert.ok(quality.torsoCoverage > 0.46);
  assert.ok(quality.footCoverage > 0.08);
  assert.ok(quality.connectedComponents <= 3);
});

test('analyzeCutoutQuality rejects a large transparent shirt hole', async () => {
  const quality = await analyzeCutoutQuality(await cutoutFixture({ torsoHole: true }));
  assert.equal(quality.passed, false);
  assert.ok(quality.reasons.some((reason) => reason.includes('torso') || reason.includes('hole')));
});

test('analyzeCutoutQuality rejects missing shoes/feet', async () => {
  const quality = await analyzeCutoutQuality(await cutoutFixture({ missingFeet: true }));
  assert.equal(quality.passed, false);
  assert.ok(quality.reasons.some((reason) => reason.includes('foot')));
});

test('removeBackground creates a transparent PNG for a simple studio-background subject with legacy edge-mask when explicitly selected', async () => {
  const previousProvider = process.env.BACKGROUND_REMOVAL_PROVIDER;
  process.env.BACKGROUND_REMOVAL_PROVIDER = 'edge-mask';
  const subject = await sharp({
    create: {
      width: 180,
      height: 320,
      channels: 3,
      background: '#f5f2ef'
    }
  })
    .composite([
      {
        input: Buffer.from(
          `<svg width="180" height="320" xmlns="http://www.w3.org/2000/svg">
            <ellipse cx="90" cy="44" rx="26" ry="32" fill="#202020"/>
            <rect x="58" y="78" width="64" height="92" rx="22" fill="#252525"/>
            <rect x="34" y="88" width="32" height="120" rx="16" fill="#252525"/>
            <rect x="114" y="88" width="32" height="120" rx="16" fill="#252525"/>
            <rect x="60" y="166" width="26" height="108" rx="12" fill="#252525"/>
            <rect x="94" y="166" width="26" height="108" rx="12" fill="#252525"/>
            <rect x="44" y="266" width="42" height="18" rx="9" fill="#252525"/>
            <rect x="94" y="266" width="42" height="18" rx="9" fill="#252525"/>
          </svg>`
        )
      }
    ])
    .jpeg({ quality: 95 })
    .toBuffer();

  try {
    const result = await removeBackground({ imageBuffer: subject });
    assert.equal(result.mimeType, 'image/png');
    assert.ok(result.width <= 180);
    assert.ok(result.height < 320);

    const { data, info } = await sharp(result.outputBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const bounds = alphaBoundsFromRaw(data, info.width, info.height);
    assert.ok(bounds.pixelCount > 1000);
    assert.ok(data[3] < 40, 'top-left pixel should be transparent');
  } finally {
    if (previousProvider === undefined) delete process.env.BACKGROUND_REMOVAL_PROVIDER;
    else process.env.BACKGROUND_REMOVAL_PROVIDER = previousProvider;
  }
});

test('hasUsableTransparency requires actual transparent pixels', async () => {
  const opaquePng = await sharp({
    create: {
      width: 24,
      height: 24,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 }
    }
  }).png().toBuffer();

  assert.equal(await hasUsableTransparency(opaquePng), false);
});

test('removeBackground semantically preserves the real wardrobe model shirt and shoes', { timeout: 180000 }, async (t) => {
  const file = 'uploads/users/6a5b86c6f3e4fc1ff38c68f3/closet-outfits/closet-outfit-1784384480376-95075246.jpg';
  try {
    await fs.access(file);
  } catch {
    t.skip(`Missing optional local fixture: ${file}`);
    return;
  }

  const previousProvider = process.env.BACKGROUND_REMOVAL_PROVIDER;
  process.env.BACKGROUND_REMOVAL_PROVIDER = 'semantic-rembg';
  const bytes = await fs.readFile(file);
  try {
    const result = await removeBackground({ imageBuffer: bytes, mimeType: 'image/jpeg' });
    const alpha = await alphaStatsForBuffer(result.outputBuffer);

    assert.equal(result.mimeType, 'image/png');
    assert.equal(alpha.hasTransparentPixels, true);
    assert.ok(result.quality.passed, result.quality.reasons.join('; '));
    assert.ok(result.quality.torsoCoverage > 0.46, 'white T-shirt/torso must remain present');
    assert.ok(result.quality.footCoverage > 0.08, 'white shoes must remain present');
    assert.ok(result.quality.largestComponentRatio > 0.82, 'person should be one coherent subject');
    assert.ok(result.quality.largestInternalHoleRatio <= 0.10, 'no large transparent torso hole');
  } finally {
    if (previousProvider === undefined) delete process.env.BACKGROUND_REMOVAL_PROVIDER;
    else process.env.BACKGROUND_REMOVAL_PROVIDER = previousProvider;
  }
});

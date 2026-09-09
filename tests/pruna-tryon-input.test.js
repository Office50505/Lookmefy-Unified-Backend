import test from 'node:test';
import assert from 'node:assert/strict';
import { prunaGarmentSelection } from '../server/utils/prunaTryOnInput.js';
import { imagePrunaCostUsd } from '../server/utils/prunaClient.js';

test('Pruna counts garment references without including the person image', () => {
  for (const [key, garment] of [['upper', 'upper-body garment'], ['lower', 'lower-body garment'], ['watch', 'watch']]) {
    const input = prunaGarmentSelection({ garmentUrl: 'reference', promptKey: key });
    assert.deepEqual(input.garment_images, ['reference']);
    assert.equal(input.prompt, `The ${garment} from image 1.`);
    assert.doesNotMatch(input.prompt, /person|image 2/);
  }
});

test('T-shirt and lower set selects each category separately in standard mode', () => {
  const input = prunaGarmentSelection({
    product: { name: 'Half Sleeves T-Shirt & Lower Set | Track Suit', category: 't-shirts' },
    garmentUrl: 'outfit', turbo: true
  });
  assert.equal(input.key, 'full_outfit');
  assert.deepEqual(input.garment_images, ['outfit', 'outfit']);
  assert.equal(input.prompt, 'The pullover T-shirt from image 1 and the matching trousers from image 2.');
  assert.equal(input.turbo, false);
  assert.equal(imagePrunaCostUsd({ turbo: input.turbo, garmentCount: input.garment_images.length }), 0.023);
});

test('single tops, dresses and explicit lower selection keep one garment', () => {
  for (const args of [
    { product: { name: 'Cotton T-shirt', category: 't-shirts' } },
    { product: { name: 'Evening dress', category: 'dresses' } },
    { product: { name: 'T-shirt set' }, promptKey: 'lower' }
  ]) {
    const input = prunaGarmentSelection({ ...args, garmentUrl: 'reference', turbo: false });
    assert.deepEqual(input.garment_images, ['reference']);
    assert.equal(input.turbo, false);
  }
});

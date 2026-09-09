import test from 'node:test';
import assert from 'node:assert/strict';
import { promptForProduct, promptForKey } from '../server/utils/tryOnPrompts.js';

test('T-shirt and lower set keeps both garments and rejects jacket construction', () => {
  const result = promptForProduct({
    name: 'Cotton Blend Night Suit/Summer Suit for Men, Regular Fit Half Sleeves T-Shirt & Lower Set | Soft Cord-Set Track Suit for Boys',
    category: 't-shirts', garmentPlacement: 'top'
  });
  assert.equal(result.key, 'full_outfit');
  assert.match(result.prompt, /continuous closed fabric front/);
  assert.match(result.prompt, /Replace ALL existing upper-body clothing layers/);
  assert.match(result.prompt, /matching lower garment/);
  assert.match(result.prompt, /Short or half sleeves must remain short or half sleeves/);
});

test('standalone T-shirt preserves bottoms, including explicit custom prompt selection', () => {
  const product = { name: 'Cotton T–shirt', category: 'tops' };
  const result = promptForProduct(product);
  assert.equal(result.key, 'upper');
  assert.match(promptForKey('upper', product), /continuous closed fabric front/);
  assert.match(result.prompt, /Preserve the person's lower-body clothing unchanged/);
});

test('construction constraints do not override outerwear, lower-only transfers or accessory styling', () => {
  for (const product of [
    { name: 'Jacket and T-shirt set', category: 'sets' },
    { name: 'Zip jacket', category: 'jackets', description: 'Wear with a T-shirt' },
    { name: 'Polo shirt', category: 'shirts' },
    { name: 'Watch', category: 'watches', tags: ['t-shirt'] }
  ]) {
    assert.doesNotMatch(promptForProduct(product).prompt, /GARMENT CONSTRUCTION/);
  }
  assert.doesNotMatch(promptForKey('lower', { name: 'T-shirt and lower set' }), /GARMENT CONSTRUCTION/);
});

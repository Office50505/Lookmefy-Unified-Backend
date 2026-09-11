import test from 'node:test';
import assert from 'node:assert/strict';
import { promptForProduct, promptForKey, requiresPreciseTryOnEdit } from '../server/utils/tryOnPrompts.js';

test('production selects precise editing for ethnic sets and glasses, not ordinary tees', () => {
  assert.equal(requiresPreciseTryOnEdit({name:'Kurta with Pant and Dupatta Set'}), true);
  assert.equal(requiresPreciseTryOnEdit({name:'Lehenga Choli with Dupatta'}), true);
  assert.equal(requiresPreciseTryOnEdit({name:'Cat Eye Glasses', category:'eyewear'}), true);
  assert.equal(requiresPreciseTryOnEdit({name:'T-shirt and lower set'}), false);
  assert.equal(requiresPreciseTryOnEdit({name:'Short Kurti'}), false);
  assert.equal(requiresPreciseTryOnEdit({name:'Gold Heart Necklace'}), false);
  assert.equal(requiresPreciseTryOnEdit({name:'Shoulder Handbag'}), true);
  assert.equal(requiresPreciseTryOnEdit({name:'Long Wrapskirt'}), true);
  assert.equal(requiresPreciseTryOnEdit({name:'T-shirt and Shorts Set'}), true);
});

test('imported category and marketing keywords cannot change the named garment', () => {
  for (const [product, expected] of [
    [{name: 'Dream Beauty Women Square Neck Button Front Short Sleeve T-Shirt', category: 'shorts'}, 'upper'],
    [{name: 'Men Formal Dress Trousers', category: 'pants', garmentPlacement: 'full-body'}, 'lower'],
    [{name: 'Soft Chiffon Scarfs Shawls for Evening Dresses', category: 'dresses'}, 'accessory'],
    [{name: 'Pocket Square for Tuxedo Jacket Suit', category: 'jackets'}, 'accessory'],
    [{name: 'Formal Blazer | Professional Suit | Wedding', category: 'jackets', garmentPlacement: 'full-body'}, 'upper'],
    [{name: 'Printed Kurti for Women', category: 'ethnic wear'}, 'upper'],
    [{name: 'Shirt and matching trousers set', category: 'shirts'}, 'full_outfit'],
    [{name: 'Gold Necklace Set', category: 'accessories'}, 'accessory']
  ]) assert.equal(promptForProduct(product).key, expected, product.name);
});

test('compound garment names and coordinated sets keep their intended coverage', () => {
  for (const name of ['Cotton Embroidered Shirt Dress', 'Button Down Denim Jeans Dresses', 'Kurta Churidar Suit Set', 'Thermal Top Pajama and Bottom Suit Combo Set', 'Floral Bralette and Skirt Panty Set', 'Blazer Vest & Pant 3-Piece Suit', 'Cotton Salwar Suit With Work Dupatta']) {
    assert.equal(promptForProduct({name}).key, 'full_outfit', name);
  }
  assert.equal(promptForProduct({name:'Casual Dress Sneakers'}).key, 'shoes');
  assert.equal(promptForProduct({name:'Women Low Waist Bikini',category:'innerwear'}).key, 'lower');
});

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


test('bracelet and bangle references specify wrist placement rather than the waist', () => {
  for (const name of ['Latest Trend Bracelet Bangle Style Beautiful Artificial Hand Mangalsutra for Women', 'Gold Bangle for Women']) {
    const result = promptForProduct({name, category:'accessories', garmentPlacement:'upper'});
    assert.equal(result.key, 'accessory');
    assert.match(result.prompt, /ONE visible wrist only/);
    assert.match(result.prompt, /Do NOT place it around the waist/);
    assert.match(result.prompt, /waist area unchanged/);
  }
  for (const name of ['Gold Necklace', 'Leather Belt', 'Gold Watch']) {
    assert.doesNotMatch(promptForProduct({name}).prompt, /This product is wrist jewelry/);
  }
});

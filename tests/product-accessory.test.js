import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import Product from '../server/models/Product.js';
import { normalizeGarmentPlacement } from '../server/routes/products.js';
import { fitRoomClothTypeForProduct, fitRoomClothTypeForPromptKey, shouldUseFalImageEditForProduct } from '../server/routes/tryons.js';
import { promptForProduct, promptKeyForProduct } from '../server/utils/tryOnPrompts.js';

test('product fit area accepts an explicit accessory classification', () => {
  const product = new Product({
    name: 'Leather crossbody bag',
    brand: 'Lookmefy',
    category: 'bags',
    garmentPlacement: 'accessory',
    price: 1299
  });

  assert.equal(product.validateSync(), undefined);
  assert.equal(product.toClient().garmentPlacement, 'accessory');
});

test('product fit area accepts full-body garments', () => {
  const product = new Product({
    name: 'Solid halter neck midi dress',
    brand: 'Lookmefy',
    category: 'dresses',
    garmentPlacement: 'full-body',
    price: 1299
  });

  assert.equal(product.validateSync(), undefined);
  assert.equal(product.toClient().garmentPlacement, 'full-body');
});

test('fit-area normalization preserves accessory overrides and garment inference', () => {
  assert.equal(normalizeGarmentPlacement('accessories'), 'accessory');
  assert.equal(normalizeGarmentPlacement('', { name: 'Halter neck midi dress', category: 'dresses' }), 'full-body');
  assert.equal(normalizeGarmentPlacement('', { name: 'Wide leg trousers' }), 'bottom');
  assert.equal(normalizeGarmentPlacement('', { name: 'Oxford shirt' }), 'top');
});

test('accessory products use accessory prompts without replacing specialized prompts', () => {
  assert.equal(promptKeyForProduct({ name: 'Minimal fashion piece', garmentPlacement: 'accessory' }), 'accessory');
  assert.equal(promptKeyForProduct({ name: 'Steel wrist watch', garmentPlacement: 'accessory' }), 'watch');
  assert.equal(promptKeyForProduct({ name: 'Aviator sunglasses', garmentPlacement: 'accessory' }), 'glasses');
});

test('full-body products use full outfit prompts', () => {
  assert.equal(promptKeyForProduct({ name: 'Minimal fashion piece', garmentPlacement: 'full-body' }), 'full_outfit');
  assert.equal(promptKeyForProduct({ name: 'Halter neck midi dress', garmentPlacement: 'top' }), 'full_outfit');
});

test('garment targeting maps tops and innerwear to upper-only provider controls', () => {
  assert.equal(promptKeyForProduct({ name: 'Lace bra', category: 'innerwear' }), 'upper');
  assert.equal(fitRoomClothTypeForProduct({ name: 'Oxford shirt', category: 'shirts', garmentPlacement: 'top' }), 'upper');
  assert.equal(fitRoomClothTypeForProduct({ name: 'Lace bra', category: 'innerwear' }), 'upper');
});

test('garment targeting maps bottoms and full body garments to the right provider controls', () => {
  assert.equal(fitRoomClothTypeForProduct({ name: 'Blue straight jeans', category: 'jeans' }), 'lower');
  assert.equal(fitRoomClothTypeForProduct({ name: 'Printed midi dress', category: 'dresses' }), 'full_set');
  assert.equal(fitRoomClothTypeForPromptKey('full_outfit'), 'full_set');
});

test('saree products use saree-specific prompt and FAL image-edit routing', () => {
  const product = { name: 'Kanjivaram silk saree', category: 'sarees', garmentPlacement: 'full-body' };
  const prompt = promptForProduct(product);
  assert.equal(prompt.key, 'saree');
  assert.match(prompt.prompt, /complete traditional outfit/i);
  assert.match(prompt.prompt, /blouse\/choli/i);
  assert.match(prompt.prompt, /waist pleats/i);
  assert.match(prompt.prompt, /full lower-body drape/i);
  assert.match(prompt.prompt, /Jeans, trousers, pants/i);
  assert.equal(fitRoomClothTypeForProduct(product), 'full_set');
  assert.equal(shouldUseFalImageEditForProduct(product), true);
});

test('saree try-on generation replaces stale cached output and preserves default FAL routing', async () => {
  const source = await readFile('server/routes/tryons.js', 'utf8');
  assert.match(source, /const generationModel = hasRequestedModel \? selectedModel : '';/);
  assert.match(source, /const shouldReplaceExisting = forceGenerate \|\| staleSareeTryOn;/);
  assert.match(source, /shouldReplaceExisting\s*\?\s*await replaceGeneratedTryOn/);
  assert.match(source, /if \(!tryOnModel && shouldUseFalImageEditForProduct\(product\)\)/);
});

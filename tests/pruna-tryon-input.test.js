import test from 'node:test';
import assert from 'node:assert/strict';
import { prunaGarmentSelection, prunaTryOnRequest } from '../server/utils/prunaTryOnInput.js';
import { imagePrunaCostUsd } from '../server/utils/prunaClient.js';

test('image-edit routing uses its actual schema and reference order for complex garments', () => {
  for (const product of [{name:'Kurta Pant Dupatta Set'}, {name:'Sunglasses', category:'eyewear'}, {name:'Gold Necklace'}]) {
    const result=prunaTryOnRequest({product,personUrl:'person',garmentUrl:'garment',personWidth:864,personHeight:1536});
    assert.equal(result.model,'p-image-edit');
    assert.deepEqual(result.input.images,['person','garment']);
    assert.equal(result.input.aspect_ratio,'9:16');
    assert.equal(result.input.reference_image,undefined);
    assert.equal(result.input.garment_images,undefined);
    assert.equal(result.providerCostUsd,0.01);
  }
  const tee=prunaTryOnRequest({product:{name:'T-shirt and lower set'},personUrl:'person',garmentUrl:'garment'});
  assert.equal(tee.model,'p-image-try-on');
  assert.equal(tee.input.person_image,'person');
  assert.equal(tee.garmentCount,2);
  assert.equal(tee.providerCostUsd,0.023);
});

test('Pruna counts garment references without including the person image', () => {
  for (const [key, garment] of [['upper', 'upper-body garment'], ['lower', 'lower-body garment'], ['watch', 'watch']]) {
    const input = prunaGarmentSelection({ garmentUrl: 'reference', promptKey: key });
    assert.deepEqual(input.garment_images, ['reference']);
    assert.equal(input.prompt, `The ${garment} from image 1.`);
    assert.doesNotMatch(input.prompt, /person|image 2/);
  }
});

test('flared jeans use editing to preserve the leg shape, ordinary jeans keep VTO', () => {
  const request = name => prunaTryOnRequest({product:{name},personUrl:'person',garmentUrl:'jeans'});
  assert.equal(request('High Waist Flared Jeans').model, 'p-image-edit');
  assert.equal(request('Straight Jeans').model, 'p-image-try-on');
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

test('ethnic outfits use image editing instead of the failed duplicate-reference selection', () => {
  for (const name of ['Kurta Pant Dupatta Set', 'Anarkali Kurta Gown with Dupatta', 'Kurta Palazzo Set', 'Lehenga Choli with Dupatta']) {
    const result = prunaTryOnRequest({product:{name},personUrl:'person',garmentUrl:'outfit'});
    assert.equal(result.model, 'p-image-edit');
    assert.deepEqual(result.input.images, ['person','outfit']);
  }
});

test('T-shirt shorts retain shorts and outerwear uses an explicit standard-mode selector', () => {
  const shorts=prunaGarmentSelection({product:{name:'T-shirt and Shorts Set'},garmentUrl:'set'});
  assert.match(shorts.prompt,/matching shorts/);
  const jacket=prunaGarmentSelection({product:{name:'Open Front Blazer'},garmentUrl:'jacket',turbo:true});
  assert.equal(jacket.prompt,'The blazer from image 1.');
  assert.equal(jacket.turbo,false);
});

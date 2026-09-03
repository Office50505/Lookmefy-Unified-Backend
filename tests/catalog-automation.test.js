import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import {
  amazonAsin,
  catalogIntentCompatibility,
  parseCatalogCommand
} from '../server/services/catalogAutomation.js';
import { smartImportDraftFromSearchResult, smartImportRecord } from '../server/routes/products.js';

function productDraft(overrides = {}) {
  return {
    name: 'Acme Black Cotton T-Shirt for Men',
    brand: 'Acme',
    category: 't-shirts',
    gender: 'men',
    garmentPlacement: 'top',
    price: 599,
    compareAtPrice: 799,
    currency: 'INR',
    rating: 4.2,
    ratingCount: 50,
    description: 'Black cotton crew neck T-shirt for men',
    tags: ['cotton', 'black'],
    colors: ['black'],
    sizes: ['S', 'M', 'L'],
    remoteImageUrl: 'https://m.media-amazon.com/images/I/example.jpg',
    sourceUrl: 'https://www.amazon.in/dp/B0ABCDEF12',
    ...overrides
  };
}

test('parses quantity, category, color, gender, and placement from a catalog command', () => {
  const intent = parseCatalogCommand('10 black T-shirts for men');
  assert.equal(intent.quantity, 10);
  assert.equal(intent.query, 'black T-shirts for men');
  assert.equal(intent.category, 't-shirts');
  assert.equal(intent.gender, 'men');
  assert.equal(intent.garmentPlacement, 'top');
  assert.deepEqual(intent.colors, ['black']);
});

test('uses a default quantity and recognizes full-body products', () => {
  const intent = parseCatalogCommand('white dress');
  assert.equal(intent.quantity, 10);
  assert.equal(intent.category, 'dresses');
  assert.equal(intent.gender, 'women');
  assert.equal(intent.garmentPlacement, 'full-body');
});

test('recognizes accessories and keeps the batch limit bounded', () => {
  const intent = parseCatalogCommand('5 watches for women');
  assert.equal(intent.quantity, 5);
  assert.equal(intent.itemType, 'accessory');
  assert.equal(intent.garmentPlacement, 'accessory');
  assert.throws(() => parseCatalogCommand('13 watches for women'), /at most 12 drafts/);
  assert.throws(() => parseCatalogCommand('10'), /product type/);
});

test('checks requested category and color against fetched details', () => {
  const intent = parseCatalogCommand('10 black T-shirts for men');
  assert.equal(catalogIntentCompatibility(productDraft(), intent).compatible, true);
  assert.match(
    catalogIntentCompatibility(productDraft({
      name: 'White linen shirt',
      category: 'shirts',
      colors: ['white'],
      description: 'White button-down linen shirt',
      tags: ['white', 'linen', 'shirt']
    }), intent).reason,
    /requested t-shirts category/
  );
  assert.match(
    catalogIntentCompatibility(productDraft({
      name: 'Red cotton T-Shirt',
      colors: ['red'],
      description: 'Red cotton crew neck T-shirt',
      tags: ['red', 'cotton']
    }), intent).reason,
    /requested color/
  );
});

test('allows unmentioned SerpApi colors but rejects explicit color conflicts', () => {
  const intent = parseCatalogCommand('10 black T-shirts for men');
  const noColor = productDraft({
    name: 'Acme Cotton Crew Neck T-Shirt for Men',
    description: 'Cotton crew neck T-shirt for men',
    tags: ['cotton'],
    colors: []
  });
  const inferred = catalogIntentCompatibility(noColor, intent, { allowUnverifiedColor: true });
  assert.equal(inferred.compatible, true);
  assert.deepEqual(inferred.unverifiedColors, ['black']);

  const conflicting = catalogIntentCompatibility(productDraft({
    name: 'Acme Red Cotton T-Shirt for Men',
    description: 'Red cotton crew neck T-shirt for men',
    tags: ['cotton', 'red'],
    colors: ['red']
  }), intent, { allowUnverifiedColor: true });
  assert.equal(conflicting.compatible, false);
  assert.match(conflicting.reason, /red instead of the requested color: black/);
});

test('builds hidden, unapproved catalog records from accepted products', () => {
  const intent = parseCatalogCommand('10 black T-shirts for men');
  const record = smartImportRecord(
    productDraft(),
    { link: 'https://www.amazon.in/dp/B0ABCDEF12' },
    intent,
    'smart-test-batch'
  );
  assert.equal(record.sourceProductId, 'B0ABCDEF12');
  assert.equal(record.importBatchId, 'smart-test-batch');
  assert.equal(record.availabilityStatus, 'draft');
  assert.equal(record.isActive, false);
  assert.equal(record.catalogApproved, false);
  assert.equal(record.availabilitySource, 'smart-import');
  assert.match(record.inventoryNotes, /10 black T-shirts/);
});

test('builds complete smart-import drafts directly from SerpApi search data', () => {
  const intent = parseCatalogCommand('2 white dresses for women');
  const draft = smartImportDraftFromSearchResult({
    provider: 'serpapi',
    link: 'https://www.amazon.in/dp/B0ABCDEF12',
    name: 'Acme Women White Cotton Midi Dress',
    price: 799,
    compareAtPrice: 1199,
    currency: 'INR',
    rating: 4.3,
    ratingCount: 182,
    remoteImageUrl: 'https://m.media-amazon.com/images/I/example.jpg'
  }, intent);

  assert.equal(draft.category, 'dresses');
  assert.equal(draft.gender, 'women');
  assert.equal(draft.garmentPlacement, 'full-body');
  assert.equal(draft.brand, 'Acme');
  assert.deepEqual(draft.colors, ['white']);
  assert.equal(draft.price, 799);
  assert.equal(draft.ratingCount, 182);
});

test('extracts Amazon ASINs and rejects incomplete smart records', () => {
  assert.equal(amazonAsin('https://www.amazon.in/name/dp/B0ABCDEF12?tag=test'), 'B0ABCDEF12');
  assert.throws(
    () => smartImportRecord(
      productDraft({ price: '', remoteImageUrl: '' }),
      { link: 'https://www.amazon.in/dp/B0ABCDEF12' },
      parseCatalogCommand('black T-shirts'),
      'smart-test-batch'
    ),
    /price is missing.*image is missing/
  );
});

test('smart import route requires user-operation admin access without a request limiter', async () => {
  const productsRoute = await fs.readFile(new URL('../server/routes/products.js', import.meta.url), 'utf8');
  assert.match(productsRoute, /router\.post\('\/smart-import', requireAdmin, requireUserOperationsAdmin, async/);
  assert.doesNotMatch(productsRoute, /adminSmartImportLimiter|products:admin-smart-import/);
  assert.match(productsRoute, /SMART_CATALOG_SEARCH_PAGES[\s\S]*page <= smartImportSearchPageCount\(\)/);
  assert.match(productsRoute, /catalogApproved: false[\s\S]*availabilityUpdate\('draft'/);
  assert.match(productsRoute, /availability\.availabilityStatus === 'available'\) product\.catalogApproved = true/);
  assert.match(productsRoute, /update\.availabilityStatus === 'available'\) update\.catalogApproved = true/);
});

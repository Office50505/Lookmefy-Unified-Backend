import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  canonicalAmazonUrl,
  extractAsin,
  withAssociateTag
} from '../server/services/amazon-product-provider.js';
import {
  inferPlacement,
  importProducts,
  parseCsv,
  REPLACE_CONFIRMATION,
  validateAndBuildProduct
} from '../server/services/product-import.js';
import {
  cleanBrand,
  getBestBrand,
  getProductFacts,
  refineProductDraft,
  temporaryExternalAmazonFilter
} from '../server/routes/products.js';

const taxonomy = {
  batchSize: 2,
  genders: {
    men: { categories: ['T-Shirts', 'Jeans', 'Boxers'] },
    women: { categories: ['Dresses', 'Jeans', 'Bras'] }
  }
};

function validDraft(overrides = {}) {
  return {
    name: 'Acme Cotton T-Shirt',
    brand: 'Acme',
    category: 'T-Shirts',
    gender: 'men',
    price: 499,
    compareAtPrice: 799,
    currency: 'INR',
    rating: 4.2,
    ratingCount: 25,
    description: 'Cotton clothing garment for daily wear',
    tags: ['cotton'],
    remoteImageUrl: 'https://images.example.com/shirt.jpg',
    sourceUrl: 'https://www.amazon.in/dp/B0ABCDEF12',
    affiliateLink: 'https://www.amazon.in/dp/B0ABCDEF12?tag=stampmybrand-21',
    sourceProvider: 'amazon',
    sourceProductId: 'B0ABCDEF12',
    ...overrides
  };
}

function fakeModel(existing = null) {
  const calls = { bulkWrite: [], updateMany: [] };
  return {
    calls,
    findOne() {
      return { lean: async () => existing };
    },
    async bulkWrite(operations) {
      calls.bulkWrite.push(operations);
      return { upsertedIds: { 0: 'new-product-id' } };
    },
    async updateMany(filter, update) {
      calls.updateMany.push({ filter, update });
      return { modifiedCount: 3 };
    }
  };
}

test('extracts ASIN and leaves the canonical URL untagged by default', () => {
  const url = 'https://www.amazon.in/Some-Product/dp/B0ABCDEF12/ref=sxin?tag=old-tag';
  assert.equal(extractAsin(url), 'B0ABCDEF12');
  assert.equal(canonicalAmazonUrl(url), 'https://www.amazon.in/dp/B0ABCDEF12');
  assert.equal(withAssociateTag(url), 'https://www.amazon.in/dp/B0ABCDEF12');
});

test('parses quoted CSV manifest rows', () => {
  const rows = parseCsv('sourceUrl,tags\nhttps://www.amazon.in/dp/B0ABCDEF12,"cotton, casual"\n');
  assert.deepEqual(rows, [{ sourceUrl: 'https://www.amazon.in/dp/B0ABCDEF12', tags: 'cotton, casual' }]);
});

test('validates clothing and rejects duplicate ASINs', () => {
  const context = { taxonomy, seenAsins: new Set(), batchId: 'batch-1' };
  const product = validateAndBuildProduct(validDraft(), { expectedGender: 'men', expectedCategory: 'T-Shirts' }, context);
  assert.equal(product.sourceProductId, 'B0ABCDEF12');
  assert.equal(product.availabilityStatus, 'available');
  assert.equal(product.isActive, true);
  assert.throws(
    () => validateAndBuildProduct(validDraft(), { expectedGender: 'men', expectedCategory: 'T-Shirts' }, context),
    /Duplicate ASIN/
  );
});

test('rejects accessories and invalid gender/category pairs', () => {
  assert.throws(
    () => validateAndBuildProduct(validDraft({
      name: 'Acme Leather Wallet',
      description: 'wallet accessory',
      tags: ['wallet']
    }), { expectedGender: 'men', expectedCategory: 'T-Shirts' }, { taxonomy, seenAsins: new Set() }),
    /Accessory/
  );

  assert.throws(
    () => validateAndBuildProduct(validDraft({ category: 'Boxers', gender: 'women' }), { expectedGender: 'women', expectedCategory: 'Boxers' }, { taxonomy, seenAsins: new Set() }),
    /Category/
  );
});

test('classifies garment placement', () => {
  assert.equal(inferPlacement({ category: 'Jeans', name: 'Blue jeans' }), 'bottom');
  assert.equal(inferPlacement({ category: 'Dresses', name: 'Halter neck midi dress' }), 'full-body');
  assert.equal(inferPlacement({ category: 'T-Shirts', name: 'Crew neck tee' }), 'top');
});

test('refines fetched product drafts with warnings for review', () => {
  const facts = new Map([['color', 'Black']]);
  const html = '<select id="native_dropdown_selected_size_name"><option>Select Size</option><option>S</option><option>M</option><option>XL</option></select>';
  const draft = refineProductDraft({
    name: 'Aahwan Pink Solid Halter Neck Bodycon Midi Dress',
    brand: 'Aahwan',
    category: 'dresses',
    gender: 'women',
    garmentPlacement: 'top',
    rating: 4,
    ratingCount: 0,
    description: 'Buy Aahwan Black Solid Halter Neck Bodycon Midi Dress for Women',
    tags: ['dresses', 'women', 'aahwan', '95% cotton', '5% spedex', 'cc', 'solid'],
    remoteImageUrl: 'https://m.media-amazon.in/images/I/example.jpg'
  }, { facts, html });

  assert.equal(draft.garmentPlacement, 'full-body');
  assert.equal(draft.rating, '');
  assert.equal(draft.ratingCount, '');
  assert.ok(draft.description.startsWith('Aahwan Black'));
  assert.ok(draft.colors.includes('black'));
  assert.ok(draft.colors.includes('pink'));
  assert.ok(!draft.tags.includes('cc'));
  assert.ok(!draft.tags.includes('5% spedex'));
  assert.ok(!draft.tags.includes('95% cotton'));
  assert.deepEqual(draft.sizes, ['S', 'M', 'XL']);
  assert.ok(draft.warnings.some((warning) => warning.title === 'Color conflict'));
  assert.ok(draft.warnings.some((warning) => warning.title === 'Rating count missing'));
});

test('refined product drafts warn when only size-chart text is available', () => {
  const draft = refineProductDraft({
    name: 'Cotton Shirt',
    category: 'shirts',
    description: 'Regular cotton shirt'
  }, {
    facts: new Map(),
    html: '<div>Label Size Bust Waist Hip Length cm inches</div>'
  });

  assert.deepEqual(draft.sizes, []);
  assert.ok(draft.warnings.some((warning) => warning.title === 'Size options need review'));
});

test('dry-run performs zero writes and enforces per-category limit', async () => {
  const reportsDir = await mkdtemp(path.join(os.tmpdir(), 'fitlook-import-'));
  const model = fakeModel();
  const entries = [
    { sourceUrl: 'https://www.amazon.in/dp/B0ABCDEF10', expectedGender: 'men', expectedCategory: 'T-Shirts' },
    { sourceUrl: 'https://www.amazon.in/dp/B0ABCDEF11', expectedGender: 'men', expectedCategory: 'T-Shirts' },
    { sourceUrl: 'https://www.amazon.in/dp/B0ABCDEF12', expectedGender: 'men', expectedCategory: 'T-Shirts' }
  ];
  const provider = {
    async getProduct(entry) {
      const asin = extractAsin(entry.sourceUrl);
      return validDraft({ sourceProductId: asin, sourceUrl: entry.sourceUrl, affiliateLink: withAssociateTag(entry.sourceUrl) });
    }
  };

  const { report } = await importProducts({ entries, taxonomy, productProvider: provider, productModel: model, reportsDir });
  assert.equal(report.inserted, 2);
  assert.equal(report.skipped, 1);
  assert.equal(model.calls.bulkWrite.length, 0);
});

test('commit upserts products directly through bulkWrite', async () => {
  const reportsDir = await mkdtemp(path.join(os.tmpdir(), 'fitlook-import-'));
  const model = fakeModel();
  const provider = { async getProduct() { return validDraft(); } };
  const { report } = await importProducts({
    entries: [{ sourceUrl: 'https://www.amazon.in/dp/B0ABCDEF12', expectedGender: 'men', expectedCategory: 'T-Shirts' }],
    taxonomy,
    productProvider: provider,
    productModel: model,
    reportsDir,
    commit: true
  });

  assert.equal(report.inserted, 1);
  assert.equal(model.calls.bulkWrite.length, 1);
  assert.equal(model.calls.bulkWrite[0][0].updateOne.upsert, true);
});

test('replace-existing requires explicit confirmation and deactivates old products after commit', async () => {
  const reportsDir = await mkdtemp(path.join(os.tmpdir(), 'fitlook-import-'));
  const provider = { async getProduct() { return validDraft(); } };
  await assert.rejects(
    importProducts({
      entries: [{ sourceUrl: 'https://www.amazon.in/dp/B0ABCDEF12', expectedGender: 'men', expectedCategory: 'T-Shirts' }],
      taxonomy,
      productProvider: provider,
      productModel: fakeModel(),
      reportsDir,
      commit: true,
      replaceExisting: true
    }),
    /REPLACE_ACTIVE_CATALOG/
  );

  const model = fakeModel();
  const { report } = await importProducts({
    entries: [{ sourceUrl: 'https://www.amazon.in/dp/B0ABCDEF12', expectedGender: 'men', expectedCategory: 'T-Shirts' }],
    taxonomy,
    productProvider: provider,
    productModel: model,
    reportsDir,
    commit: true,
    replaceExisting: true,
    confirm: REPLACE_CONFIRMATION
  });

  assert.equal(report.oldProductsDeactivated[0].count, 3);
  assert.equal(model.calls.updateMany.length, 1);
  assert.equal(model.calls.updateMany[0].update.$set.availabilityStatus, 'archived');
});

test('approved imported Amazon products are not filtered as temporary recommendations', () => {
  const filter = temporaryExternalAmazonFilter();
  assert.deepEqual(filter.catalogApproved, { $ne: true });
  assert.equal(filter.badge, 'Amazon');
});

test('product draft brand ignores Amazon size chart table text', () => {
  const html = `
    <a id="bylineInfo">Visit the Aahwan Store</a>
    <table>
      <tr><td>Brand</td><td>Label Size Bust (in) Waist (in) Hip (in)</td></tr>
    </table>
  `;
  const facts = getProductFacts(html);

  assert.equal(cleanBrand('Label Size Bust (in) Waist (in)'), '');
  assert.equal(facts.has('brand'), false);
  assert.equal(getBestBrand({
    product: {},
    facts,
    html,
    finalUrl: 'https://www.amazon.in/dp/B0DQDF1DZ1',
    title: "Aahwan Pink Solid Halter Neck Solid Bodycon Midi Dress for Women's & Girl's"
  }), 'Aahwan');
});

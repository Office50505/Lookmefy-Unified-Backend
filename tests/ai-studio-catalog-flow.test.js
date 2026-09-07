import assert from 'node:assert/strict';
import test from 'node:test';
import ClosetItem from '../server/models/ClosetItem.js';
import ClosetOutfit from '../server/models/ClosetOutfit.js';
import Product from '../server/models/Product.js';
import UserEvent from '../server/models/UserEvent.js';
import { orchestrateAiStudio } from '../server/services/aiStudio.js';

const searchMessage = 'Search Lookmefy catalog for black jeans';
const emptyReply = 'I could not find matching Lookmefy catalog products for black jeans.';

function catalogFixtures() {
  const product = (id, name, overrides = {}) => ({
    _id: id,
    name,
    brand: 'Catalog Brand',
    category: 'jeans',
    gender: 'women',
    price: 1299,
    colors: ['black'],
    tags: ['black', 'jeans'],
    description: 'Black jeans for women',
    image: { url: `/uploads/products/${id}.jpg` },
    isActive: true,
    availabilityStatus: 'available',
    ...overrides
  });
  return [
    product('black-jeans', 'Women Black Wide Leg Jeans'),
    product('blue-jeans', 'Women Blue Wide Leg Jeans'),
    product('denim-shirt', 'Women Blue Denim Button-Down Shirt'),
    product('denim-shorts', 'Women Black Denim Shorts | Jeans for Women')
  ];
}

function queryResult(rows) {
  return {
    sort() { return this; },
    limit() { return this; },
    maxTimeMS() { return this; },
    async lean() { return rows; }
  };
}

function mockCatalogFlow(t, rows, aiPlan = {}) {
  const settings = {
    LOOKMEFY_CATALOG_API_BASE_URL: '',
    CATALOG_API_BASE_URL: '',
    VITE_API_BASE_URL: '',
    FAL_AI_STUDIO_ENABLED: 'true',
    FAL_KEY: 'catalog-regression-test-key'
  };
  const previousSettings = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
  Object.assign(process.env, settings);
  t.after(() => {
    for (const [key, value] of Object.entries(previousSettings)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  for (const model of [ClosetItem, ClosetOutfit, UserEvent]) {
    t.mock.method(model, 'find', () => queryResult([]));
  }
  const catalogQueries = [];
  t.mock.method(Product, 'find', (query) => {
    catalogQueries.push(query);
    // Deliberately return all retrieval candidates: validation must independently
    // reject inaccurate indexed metadata instead of relying on MongoDB search.
    return queryResult(rows);
  });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url: String(url), options });
    assert.match(String(url), /^https:\/\/fal\.run\//);
    return new Response(JSON.stringify({ output: JSON.stringify(aiPlan) }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  });
  return {
    requests,
    catalogQueries,
    user: { _id: `catalog-flow-${t.name}`, name: 'Test User', genderPreference: 'female' }
  };
}

test('catalog retrieval preserves every explicit black jeans requirement without a second AI call', async (t) => {
  const fixtures = catalogFixtures();
  const { user, requests, catalogQueries } = mockCatalogFlow(t, fixtures, {
    intent: 'product_search_confirmed',
    mode: 'product_search',
    filters: { color: 'blue', category: 'tops', productType: 'shirt' },
    reply: 'Here are the catalog products.',
    selectedProductIds: ['blue-jeans', 'denim-shirt', 'denim-shorts', 'invented-jeans', 'black-jeans'],
    products: [
      { id: 'blue-jeans', name: 'Women Black Jeans' },
      { id: 'invented-jeans', name: 'Women Black Jeans' },
      { id: 'black-jeans', name: 'AI-rewritten title', price: 1 }
    ]
  });

  const result = await orchestrateAiStudio({ user, message: searchMessage });

  assert.ok(catalogQueries.length > 0, 'the catalog retrieval path must run');
  assert.equal(requests.length, 0, 'an explicit catalog search must not wait for the external AI planner');
  assert.equal(result.brain, 'local');
  assert.equal(result.filters.color, 'black');
  assert.equal(result.filters.productType, 'jeans');
  assert.equal(result.filters.category, 'bottoms');
  assert.deepEqual(result.products.map((product) => product.id), ['black-jeans']);
  assert.equal(result.products[0].name, fixtures[0].name);
  assert.equal(result.products[0].price, fixtures[0].price);
  assert.equal(result.products[0].imageUrl, fixtures[0].image.url);
  assert.equal(result.products[0].source, 'lookmefy_catalog');
  assert.deepEqual(result.outfits, []);
});

test("an explicit men's catalog request overrides a female profile", async (t) => {
  const rows = [
    ...catalogFixtures(),
    {
      _id: 'mens-black-jeans',
      name: 'Men Black Straight Jeans',
      brand: 'Catalog Brand',
      category: 'jeans',
      gender: 'men',
      price: 1399,
      colors: ['black'],
      tags: ['men', 'black', 'jeans'],
      description: 'Black straight jeans for men',
      image: { url: '/uploads/products/mens-black-jeans.jpg' },
      isActive: true,
      availabilityStatus: 'available'
    }
  ];
  const { user, requests } = mockCatalogFlow(t, rows);

  const result = await orchestrateAiStudio({
    user,
    message: "Search Lookmefy catalog for men's black jeans"
  });

  assert.equal(requests.length, 0);
  assert.equal(result.filters.gender, 'male');
  assert.deepEqual(result.products.map((product) => product.id), ['mens-black-jeans']);
  assert.ok(result.products.every((product) => product.gender === 'men'));
  assert.ok(result.products.every((product) => product.source === 'lookmefy_catalog'));
});

test('catalog watches with affiliate links remain visible to AI Studio', async (t) => {
  const rows = [{
    _id: 'catalog-watch',
    name: 'Fire-Boltt Black Smart Watch for Men & Women',
    brand: 'Fire-Boltt',
    category: 'watches',
    gender: 'women',
    garmentPlacement: 'accessory',
    price: 1499,
    badge: 'Affiliate',
    affiliateLink: 'https://www.amazon.in/dp/B0GH82B3X4?tag=lookmefy-21',
    sourceUrl: 'https://www.amazon.in/example/dp/B0GH82B3X4',
    description: 'Black round display smartwatch for men and women',
    tags: ['watches', 'women', 'black'],
    colors: ['black'],
    image: { remoteUrl: 'https://m.media-amazon.com/images/I/catalog-watch.jpg' },
    isActive: true,
    availabilityStatus: 'available'
  }];
  const { user, requests, catalogQueries } = mockCatalogFlow(t, rows);

  const result = await orchestrateAiStudio({
    user,
    message: 'Search Lookmefy catalog for Watches'
  });

  assert.equal(requests.length, 0);
  assert.equal(result.filters.category, 'accessories');
  assert.equal(result.filters.productType, 'watch');
  assert.deepEqual(result.products.map((product) => product.id), ['catalog-watch']);
  assert.equal(result.products[0].source, 'lookmefy_catalog');
  assert.ok(catalogQueries.length > 0);
  assert.ok(catalogQueries.every((query) => query.$nor?.[0]?.badge === 'Amazon'));
});

test('catalog caps and scarves use the same complete accessory search path', async (t) => {
  const rows = [
    {
      _id: 'catalog-cap',
      name: 'Unisex Adjustable Cotton Baseball Cap for Men and Women',
      brand: 'Catalog Cap',
      category: 'accessories',
      gender: 'women',
      garmentPlacement: 'accessory',
      price: 499,
      badge: 'Affiliate',
      affiliateLink: 'https://www.amazon.in/dp/B000000001?tag=lookmefy-21',
      sourceUrl: 'https://www.amazon.in/example/dp/B000000001',
      description: 'Adjustable unisex baseball hat for men and women',
      tags: ['accessories', 'cap', 'unisex'],
      image: { remoteUrl: 'https://m.media-amazon.com/images/I/catalog-cap.jpg' },
      isActive: true,
      availabilityStatus: 'available'
    },
    {
      _id: 'catalog-scarf',
      name: 'Women Lightweight Printed Scarf and Stole',
      brand: 'Catalog Scarf',
      category: 'accessories',
      gender: 'women',
      garmentPlacement: 'accessory',
      price: 299,
      badge: 'Affiliate',
      affiliateLink: 'https://www.amazon.in/dp/B000000002?tag=lookmefy-21',
      sourceUrl: 'https://www.amazon.in/example/dp/B000000002',
      description: 'Soft all-season scarf for women',
      tags: ['accessories', 'scarf'],
      image: { remoteUrl: 'https://m.media-amazon.com/images/I/catalog-scarf.jpg' },
      isActive: true,
      availabilityStatus: 'available'
    }
  ];
  const { requests, catalogQueries } = mockCatalogFlow(t, rows);

  const capResult = await orchestrateAiStudio({
    user: { _id: 'catalog-cap-user', genderPreference: 'female' },
    message: 'Search Lookmefy catalog for Caps'
  });
  const scarfResult = await orchestrateAiStudio({
    user: { _id: 'catalog-scarf-user', genderPreference: 'female' },
    message: 'Search Lookmefy catalog for Scarves'
  });

  assert.equal(requests.length, 0);
  assert.ok(catalogQueries.length > 0);
  assert.equal(capResult.filters.category, 'accessories');
  assert.equal(capResult.filters.productType, 'cap');
  assert.deepEqual(capResult.products.map((product) => product.id), ['catalog-cap']);
  assert.equal(scarfResult.filters.category, 'accessories');
  assert.equal(scarfResult.filters.productType, 'scarf');
  assert.deepEqual(scarfResult.products.map((product) => product.id), ['catalog-scarf']);
  assert.ok([...capResult.products, ...scarfResult.products].every((product) => product.source === 'lookmefy_catalog'));
});

test('bare accessory names offer all three source choices', async (t) => {
  const { requests, catalogQueries } = mockCatalogFlow(t, []);

  for (const [index, message] of ['Caps', 'Scarf', 'wallet', 'bracelets', 'hair clips'].entries()) {
    const result = await orchestrateAiStudio({
      user: { _id: `accessory-choice-user-${index}`, genderPreference: 'female' },
      message
    });
    assert.equal(result.mode, 'product_choice');
    assert.deepEqual(result.actions.map((action) => action.type), ['check_wardrobe', 'search_catalog', 'search_online']);
  }

  assert.equal(requests.length, 0);
  assert.equal(catalogQueries.length, 0);
});

test('an invalid-only catalog stays empty with the exact response on repeated searches', async (t) => {
  const { user, requests, catalogQueries } = mockCatalogFlow(t, catalogFixtures().slice(1));
  const first = await orchestrateAiStudio({ user, message: searchMessage });
  const repeated = await orchestrateAiStudio({ user, message: searchMessage, conversationId: first.conversationId });

  assert.ok(catalogQueries.length > 0);
  for (const result of [first, repeated]) {
    assert.equal(result.reply, emptyReply);
    assert.equal(result.mode, 'product_search');
    assert.equal(result.filters.color, 'black');
    assert.equal(result.filters.productType, 'jeans');
    assert.deepEqual(result.products, []);
    assert.deepEqual(result.outfits, []);
    assert.ok(result.actions.some((action) => /search/i.test(action.label) && action.prompt && !action.disabled));
    assert.ok(result.suggestions.some((suggestion) => /search/i.test(suggestion)));
  }
  assert.equal(requests.length, 0, 'empty exact matches must not call the AI or silently search online');
});

test('choosing the catalog after black jeans preserves the original requirements', async (t) => {
  const { user, requests, catalogQueries } = mockCatalogFlow(t, catalogFixtures(), {
    mode: 'product_search',
    reply: 'Matching catalog products.',
    selectedProductIds: ['blue-jeans', 'black-jeans']
  });
  const sourceChoice = await orchestrateAiStudio({ user, message: 'black jeans' });
  assert.equal(sourceChoice.mode, 'product_choice');
  assert.deepEqual(sourceChoice.products, []);
  assert.equal(catalogQueries.length, 0);
  assert.equal(requests.length, 0);

  const result = await orchestrateAiStudio({
    user,
    message: 'Search Lookmefy catalog',
    conversationId: sourceChoice.conversationId
  });

  assert.equal(result.brain, 'local');
  assert.equal(result.filters.color, 'black');
  assert.equal(result.filters.productType, 'jeans');
  assert.deepEqual(result.products.map((product) => product.id), ['black-jeans']);
  assert.equal(requests.length, 0, 'choosing Lookmefy must not call the external AI planner');
});

test('black shirt accepts a catalog variant color omitted from its canonical title', async (t) => {
  const rows = [{
    _id: 'black-satin-shirt',
    name: "IndoPrimo Women's Satin Shirt with Spread Collar Neck Line",
    brand: 'IndoPrimo',
    category: 'shirts',
    gender: 'women',
    price: 395,
    colors: ['black'],
    tags: ['shirts', 'women', 'satin'],
    description: 'Full sleeve shirt for women, selected in Black',
    image: { url: '/uploads/products/black-satin-shirt.jpg' },
    isActive: true,
    availabilityStatus: 'available'
  }, {
    _id: 'blue-shirt-with-stale-black-metadata',
    name: "IndoPrimo Women's Blue Satin Shirt",
    brand: 'IndoPrimo',
    category: 'shirts',
    gender: 'women',
    price: 395,
    colors: ['black', 'blue'],
    tags: ['shirts', 'women', 'black'],
    description: 'Also available in Black',
    image: { url: '/uploads/products/blue-satin-shirt.jpg' },
    isActive: true,
    availabilityStatus: 'available'
  }];
  const { user, requests } = mockCatalogFlow(t, rows, {
    mode: 'product_search',
    reply: 'Here is a matching black shirt.',
    selectedProductIds: ['blue-shirt-with-stale-black-metadata', 'black-satin-shirt']
  });

  const result = await orchestrateAiStudio({
    user,
    message: 'Search Lookmefy catalog for Black shirt'
  });

  assert.equal(requests.length, 0, 'an explicit catalog search must not call the external AI planner');
  assert.equal(result.filters.category, 'tops');
  assert.equal(result.filters.productType, 'shirt');
  assert.equal(result.filters.color, 'black');
  assert.deepEqual(result.products.map((product) => product.id), ['black-satin-shirt']);
  assert.ok(result.products.every((product) => product.source === 'lookmefy_catalog'));
  assert.deepEqual(result.outfits, []);
  assert.match(result.reply, /found 1 product option/i);
});

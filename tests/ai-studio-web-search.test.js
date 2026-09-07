import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ClosetItem from '../server/models/ClosetItem.js';
import ClosetOutfit from '../server/models/ClosetOutfit.js';
import UserEvent from '../server/models/UserEvent.js';
import {
  buildProductSearchQuery,
  eventProfileForMessage,
  extractAiStudioFilters,
  extractAmazonSearchResults,
  orchestrateAiStudio,
  productMatchesEventProfile,
  productSearchReply,
  sourceLabel,
  webProductHasRequiredData
} from '../server/services/aiStudio.js';

async function readOptionalFixture(relativePath) {
  try {
    return await readFile(new URL(relativePath, import.meta.url), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function queryResult(rows = []) {
  return {
    sort() { return this; },
    limit() { return this; },
    async lean() { return rows; }
  };
}

function mockContext(t) {
  for (const model of [ClosetItem, ClosetOutfit, UserEvent]) {
    t.mock.method(model, 'find', () => queryResult());
  }
}

function withEnv(t, settings) {
  const previous = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
  Object.assign(process.env, settings);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('exact garment searches are not diluted with broad category synonyms', () => {
  const message = 'Search online for black jeans under ₹2,000';
  const filters = extractAiStudioFilters(message, { genderPreference: 'female' });
  const query = buildProductSearchQuery({ message, filters });

  assert.equal(query, 'women black jeans under 2000');
  assert.doesNotMatch(query, /pants|trousers/);
});

test('profile gender is the default and the gender requested in chat is the override', () => {
  assert.equal(extractAiStudioFilters('blue jeans', { genderPreference: 'female' }).gender, 'female');
  assert.equal(extractAiStudioFilters('blue jeans', { genderPreference: 'male' }).gender, 'male');
  assert.equal(extractAiStudioFilters("show men's blue jeans", { genderPreference: 'female' }).gender, 'male');
  assert.equal(extractAiStudioFilters("show women's blue jeans", { genderPreference: 'male' }).gender, 'female');
  assert.equal(
    extractAiStudioFilters("I am a woman, but show me men's blue jeans", { genderPreference: 'female' }).gender,
    'male'
  );
});

test('web shopping language stays provider-neutral', () => {
  assert.equal(sourceLabel('amazon'), 'Web find');
  assert.equal(sourceLabel('serpapi-amazon'), 'Web find');
  assert.equal(sourceLabel('web'), 'Web find');
  assert.doesNotMatch(productSearchReply({ source: 'web', products: [{ id: 'one' }] }), /amazon/i);
  assert.doesNotMatch(productSearchReply({ source: 'web-search-link', products: [{ id: 'search' }] }), /amazon/i);
});

test('HTML fallback scopes fields to one product card and reads rupee prices', () => {
  const html = `
    <div data-component-type="s-search-result" data-asin="B0ABCDEF12">
      <a href="/dp/B0ABCDEF12"><img class="s-image" src="https://m.media-amazon.com/images/I/black-jeans._AC_UL320_.jpg" alt="Women Black Wide Leg Jeans"></a>
      <span class="a-price"><span class="a-offscreen">₹1,299</span></span>
    </div>
    <div data-component-type="s-search-result" data-asin="B0ABCDEF34">
      <a href="/dp/B0ABCDEF34"><img class="s-image" src="https://m.media-amazon.com/images/I/blue-jeans._AC_UL320_.jpg" alt="Women Blue Straight Jeans"></a>
      <span class="a-price"><span class="a-offscreen">₹999</span></span>
    </div>`;

  const results = extractAmazonSearchResults(html, 'https://www.amazon.in/s?k=jeans');

  assert.equal(results.length, 2);
  assert.equal(results[0].name, 'Women Black Wide Leg Jeans');
  assert.equal(results[0].price, 1299);
  assert.match(results[0].imageUrl, /black-jeans/);
  assert.equal(results[1].name, 'Women Blue Straight Jeans');
  assert.equal(results[1].price, 999);
  assert.match(results[1].imageUrl, /blue-jeans/);
});

test('web cards require a title, destination, image, and a valid requested budget', () => {
  const valid = {
    name: 'Women Black Wide Leg Jeans',
    sourceUrl: 'https://www.amazon.in/dp/B0ABCDEF12',
    imageUrl: 'https://m.media-amazon.com/images/I/example.jpg',
    price: 1299
  };

  assert.equal(webProductHasRequiredData(valid, { budget: 2000 }), true);
  assert.equal(webProductHasRequiredData({ ...valid, imageUrl: '' }, { budget: 2000 }), false);
  assert.equal(webProductHasRequiredData({ ...valid, price: null }, { budget: 2000 }), false);
  assert.equal(webProductHasRequiredData({ ...valid, price: 2500 }, { budget: 2000 }), false);
});

test('office requests reject products without office evidence', () => {
  const filters = extractAiStudioFilters('women office dress', { genderPreference: 'female' });
  const office = eventProfileForMessage('women office dress', filters);

  assert.equal(productMatchesEventProfile({ name: 'Women Tailored Office Sheath Dress', category: 'dresses' }, office, filters), true);
  assert.equal(productMatchesEventProfile({ name: 'Women Colorful Vacation Maxi Dress', category: 'dresses' }, office, filters), false);
  assert.equal(productMatchesEventProfile({ name: 'Women Floral Party Dress', category: 'dresses' }, office, filters), false);
});

test('beach search planning adapts the capsule to an explicitly requested gender', () => {
  const filters = extractAiStudioFilters('men beach outfit', { genderPreference: 'female' });
  const beach = eventProfileForMessage('men beach outfit', filters);
  const query = buildProductSearchQuery({ message: 'men beach outfit', filters, eventProfile: beach });

  assert.equal(filters.gender, 'male');
  assert.match(query, /^men beach vacation swim trunks board shorts swimwear$/);
  assert.doesNotMatch(query, /bikini/);
});

test('AI Studio uses structured web results and removes incomplete or conflicting cards', async (t) => {
  mockContext(t);
  withEnv(t, {
    CATALOG_SEARCH_PROVIDER: 'serpapi',
    SERPAPI_API_KEY: 'web-search-test-key',
    SERPAPI_AMAZON_DOMAIN: 'amazon.in',
    AI_STUDIO_DIRECT_AMAZON_ENABLED: 'false',
    FAL_AI_STUDIO_ENABLED: 'true',
    FAL_KEY: 'planner-must-not-be-called',
    LOOKMEFY_CATALOG_API_BASE_URL: '',
    CATALOG_API_BASE_URL: '',
    VITE_API_BASE_URL: ''
  });

  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(String(url));
    return new Response(JSON.stringify({
      organic_results: [
        { asin: 'B0BLACK001', title: 'Women Black Wide Leg Jeans', extracted_price: 1299, thumbnail: 'https://m.media-amazon.com/images/I/valid.jpg' },
        { asin: 'B0BLUE0002', title: 'Women Blue Wide Leg Jeans', extracted_price: 999, thumbnail: 'https://m.media-amazon.com/images/I/blue.jpg' },
        { asin: 'B0NOIMAGE3', title: 'Women Black Straight Jeans', extracted_price: 1199 },
        { asin: 'B0OVER0004', title: 'Women Black Flared Jeans', extracted_price: 2499, thumbnail: 'https://m.media-amazon.com/images/I/over.jpg' }
      ]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });

  const result = await orchestrateAiStudio({
    user: { _id: `web-search-${t.name}`, genderPreference: 'female' },
    message: 'Search online for black jeans under ₹2,000'
  });

  assert.equal(requests.length, 2);
  assert.ok(!requests.some((url) => /^https:\/\/fal\.run\//.test(url)), 'an explicit online search must not wait for the external AI planner');
  assert.match(requests[0], /^https:\/\/serpapi\.com\/search\.json\?/);
  assert.match(requests[0], /k=women\+black\+jeans\+under\+2000/);
  assert.deepEqual(requests.map((url) => new URL(url).searchParams.get('page')), ['1', '2']);
  assert.deepEqual(result.products.map((product) => product.name), ['Women Black Wide Leg Jeans']);
  assert.equal(result.products[0].price, 1299);
  assert.equal(result.products[0].source, 'web');
  assert.equal(result.products[0].sourceLabel, 'Amazon result');
  assert.ok(result.products.every((product) => product.source === 'web'));
  assert.ok(result.products.every((product) => product.tryOnAvailable === false && product.aiTryOnAvailable === false));
  assert.deepEqual(result.outfits, []);
  assert.doesNotMatch(result.reply, /amazon/i);
});

test('a generic online switch reuses the product request instead of a previous source command', async (t) => {
  mockContext(t);
  withEnv(t, {
    CATALOG_SEARCH_PROVIDER: 'serpapi',
    SERPAPI_API_KEY: 'source-switch-key',
    SERPAPI_AMAZON_DOMAIN: 'amazon.in',
    FAL_AI_STUDIO_ENABLED: 'true',
    FAL_KEY: 'planner-must-not-be-called',
    LOOKMEFY_CATALOG_API_BASE_URL: '',
    CATALOG_API_BASE_URL: '',
    VITE_API_BASE_URL: ''
  });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(String(url));
    return new Response(JSON.stringify({
      organic_results: [{
        asin: 'B0BLACK001',
        title: 'Women Black Wide Leg Jeans',
        extracted_price: 1299,
        thumbnail: 'https://m.media-amazon.com/images/I/valid.jpg'
      }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });

  const result = await orchestrateAiStudio({
    user: { _id: `source-switch-${t.name}`, genderPreference: 'female' },
    message: 'Search online',
    history: [
      { role: 'user', text: 'black jeans' },
      { role: 'assistant', text: 'Where should I look?' },
      { role: 'user', text: 'Search Lookmefy catalog' },
      { role: 'assistant', text: 'I found catalog products.' }
    ]
  });

  assert.equal(requests.length, 2);
  const requestUrl = new URL(requests[0]);
  assert.equal(requestUrl.origin, 'https://serpapi.com');
  assert.equal(requestUrl.searchParams.get('k'), 'women black jeans');
  assert.deepEqual(result.products.map((product) => product.source), ['web']);
  assert.deepEqual(result.outfits, []);
});

test('online blue jeans returns ten direct Amazon products with try-on disabled', async (t) => {
  mockContext(t);
  withEnv(t, {
    CATALOG_SEARCH_PROVIDER: 'serpapi',
    SERPAPI_API_KEY: 'ten-amazon-results-key',
    SERPAPI_AMAZON_DOMAIN: 'amazon.in',
    FAL_AI_STUDIO_ENABLED: 'true',
    FAL_KEY: 'planner-must-not-be-called',
    LOOKMEFY_CATALOG_API_BASE_URL: '',
    CATALOG_API_BASE_URL: '',
    VITE_API_BASE_URL: ''
  });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(String(url));
    return new Response(JSON.stringify({
      organic_results: Array.from({ length: 12 }, (_, index) => ({
        asin: `B0BLUE${String(index).padStart(4, '0')}`,
        title: `Women Blue Straight Jeans Style ${index + 1}`,
        extracted_price: 899 + index,
        thumbnail: `https://m.media-amazon.com/images/I/blue-jeans-${index + 1}.jpg`
      }))
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });

  const result = await orchestrateAiStudio({
    user: { _id: `ten-online-${t.name}`, genderPreference: 'female' },
    message: 'Search online for blue jeans'
  });

  assert.equal(requests.length, 2);
  assert.equal(result.products.length, 10);
  assert.ok(result.products.every((product) => product.source === 'web'));
  assert.ok(result.products.every((product) => product.sourceLabel === 'Amazon result'));
  assert.ok(result.products.every((product) => /^https:\/\/www\.amazon\.in\/dp\//.test(product.sourceUrl)));
  assert.ok(result.products.every((product) => product.tryOnAvailable === false && product.aiTryOnAvailable === false));
  assert.ok(!result.actions.some((action) => /try[_ -]?on/i.test(`${action.type} ${action.label} ${action.prompt}`)));
  assert.deepEqual(result.outfits, []);
});

test("an explicit men's online request overrides a female profile and excludes women's products", async (t) => {
  mockContext(t);
  withEnv(t, {
    CATALOG_SEARCH_PROVIDER: 'serpapi',
    SERPAPI_API_KEY: 'gender-override-key',
    SERPAPI_AMAZON_DOMAIN: 'amazon.in',
    LOOKMEFY_CATALOG_API_BASE_URL: '',
    CATALOG_API_BASE_URL: '',
    VITE_API_BASE_URL: ''
  });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(String(url));
    return new Response(JSON.stringify({
      organic_results: [
        ...Array.from({ length: 10 }, (_, index) => ({
          asin: `B0MEN${String(index).padStart(5, '0')}`,
          title: `Men Blue Straight Jeans Style ${index + 1}`,
          extracted_price: 999 + index,
          thumbnail: `https://m.media-amazon.com/images/I/men-blue-jeans-${index + 1}.jpg`
        })),
        {
          asin: 'B0WOMEN0001',
          title: 'Women Blue Straight Jeans',
          extracted_price: 899,
          thumbnail: 'https://m.media-amazon.com/images/I/women-blue-jeans.jpg'
        }
      ]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });

  const result = await orchestrateAiStudio({
    user: { _id: `gender-override-${t.name}`, genderPreference: 'female' },
    message: "Search online for men's blue jeans"
  });

  assert.equal(result.filters.gender, 'male');
  assert.equal(requests.length, 2);
  assert.ok(requests.every((url) => new URL(url).searchParams.get('k') === 'men blue jeans'));
  assert.equal(result.products.length, 10);
  assert.ok(result.products.every((product) => /^Men\b/i.test(product.name)));
  assert.ok(result.products.every((product) => product.source === 'web'));
});

test("a men's request keeps its override after the user taps Search online", async (t) => {
  mockContext(t);
  withEnv(t, {
    CATALOG_SEARCH_PROVIDER: 'serpapi',
    SERPAPI_API_KEY: 'gender-source-choice-key',
    SERPAPI_AMAZON_DOMAIN: 'amazon.in',
    LOOKMEFY_CATALOG_API_BASE_URL: '',
    CATALOG_API_BASE_URL: '',
    VITE_API_BASE_URL: ''
  });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(String(url));
    return new Response(JSON.stringify({
      organic_results: [{
        asin: 'B0MEN00001',
        title: 'Men Blue Straight Jeans',
        extracted_price: 1199,
        thumbnail: 'https://m.media-amazon.com/images/I/men-choice-blue-jeans.jpg'
      }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const user = { _id: `gender-source-choice-${t.name}`, genderPreference: 'female' };

  const choice = await orchestrateAiStudio({ user, message: 'Give me blue jeans for men' });
  assert.equal(choice.mode, 'product_choice');
  assert.equal(choice.filters.gender, 'male');
  assert.equal(requests.length, 0);

  const result = await orchestrateAiStudio({
    user,
    message: 'Search online',
    conversationId: choice.conversationId
  });

  assert.equal(result.filters.gender, 'male');
  assert.ok(requests.every((url) => new URL(url).searchParams.get('k') === 'men blue jeans'));
  assert.deepEqual(result.products.map((product) => product.name), ['Men Blue Straight Jeans']);
  assert.ok(result.products.every((product) => product.source === 'web'));
});

test('a general beach request searches and returns a diversified beach capsule', async (t) => {
  mockContext(t);
  withEnv(t, {
    CATALOG_SEARCH_PROVIDER: 'serpapi',
    SERPAPI_API_KEY: 'beach-search-test-key',
    SERPAPI_AMAZON_DOMAIN: 'amazon.in',
    AI_STUDIO_WEB_QUERY_LIMIT: '4',
    AI_STUDIO_WEB_RESULT_LIMIT: '4',
    AI_STUDIO_DIRECT_WEB_FALLBACK_ENABLED: 'false',
    FAL_AI_STUDIO_ENABLED: 'false',
    LOOKMEFY_CATALOG_API_BASE_URL: '',
    CATALOG_API_BASE_URL: '',
    VITE_API_BASE_URL: ''
  });

  const requestedQueries = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const candidateUrl = new URL(url);
    const query = candidateUrl.searchParams.get('k') || '';
    requestedQueries.push(query);
    let organicResults = [];
    if (/bikini|swimsuit/.test(query)) {
      organicResults = [
        { asin: 'B0BEACH001', title: 'Women Blue Bikini Swimsuit', extracted_price: 899, thumbnail: 'https://m.media-amazon.com/images/I/bikini.jpg' },
        { asin: 'B0GENERIC1', title: 'Women Floral Midi Dress', extracted_price: 999, thumbnail: 'https://m.media-amazon.com/images/I/generic.jpg' }
      ];
    } else if (/cover up|kaftan|sarong/.test(query)) {
      organicResults = [{ asin: 'B0BEACH002', title: 'Women Crochet Beach Cover Up Kaftan', extracted_price: 1099, thumbnail: 'https://m.media-amazon.com/images/I/coverup.jpg' }];
    } else if (/linen|shorts/.test(query)) {
      organicResults = [{ asin: 'B0BEACH003', title: 'Women Linen Beach Shorts', extracted_price: 799, thumbnail: 'https://m.media-amazon.com/images/I/shorts.jpg' }];
    } else if (/sandals|sunglasses|hat/.test(query)) {
      organicResults = [{ asin: 'B0BEACH004', title: 'Women Beach Sandals', extracted_price: 699, thumbnail: 'https://m.media-amazon.com/images/I/sandals.jpg' }];
    }
    return new Response(JSON.stringify({ organic_results: organicResults }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  });

  const result = await orchestrateAiStudio({
    user: { _id: `beach-search-${t.name}`, genderPreference: 'female' },
    message: 'Search online for I want a beach outfit'
  });

  assert.equal(requestedQueries.length, 4);
  assert.ok(requestedQueries.some((query) => /bikini.*swimsuit.*swimwear/.test(query)));
  assert.ok(requestedQueries.some((query) => /cover up.*kaftan.*sarong/.test(query)));
  assert.ok(requestedQueries.some((query) => /linen.*beach.*shorts/.test(query)));
  assert.ok(requestedQueries.some((query) => /sandals.*sunglasses.*sun hat/.test(query)));
  assert.deepEqual(new Set(result.products.map((product) => product.category)), new Set(['swimwear', 'bottoms', 'shoes']));
  assert.equal(result.products.length, 4);
  assert.ok(result.products.some((product) => /bikini swimsuit/i.test(product.name)));
  assert.ok(result.products.some((product) => /cover up/i.test(product.name)));
  assert.ok(result.products.some((product) => /linen beach shorts/i.test(product.name)));
  assert.ok(result.products.some((product) => /beach sandals/i.test(product.name)));
  assert.ok(!result.products.some((product) => /generic|floral midi dress/i.test(product.name)));
  assert.doesNotMatch(result.reply, /amazon/i);
});

test('AI Studio product cards never turn missing commerce data into a room image or zero price', async () => {
  const source = await readFile('src/App.jsx', 'utf8');
  const cardStart = source.indexOf('function StyleBotProduct(');
  const cardEnd = source.indexOf('\nfunction ImageLightbox', cardStart);
  const card = source.slice(cardStart, cardEnd);

  assert.ok(cardStart > 0 && cardEnd > cardStart);
  assert.doesNotMatch(card, /asset\(['"]hero2\.png['"]\)/);
  assert.doesNotMatch(card, /Shop the suggestion|Amazon result/);
  assert.match(card, /fallbackSrc=""/);
  assert.match(card, /Image unavailable/);
  assert.match(card, /Price unavailable/);
  assert.match(card, /const canTryOn = !onlineProduct && !product\.searchLink && hasProductImage/);
  assert.match(card, /Search Amazon/);
  assert.match(card, /View product/);
  assert.match(card, /const detailHref = onlineProduct \? shopHref : localDetailHref/);
  assert.match(card, /const displayedImage = hasUsableTryOn \? String\(tryOn\.imageUrl\) : productImage/);
  assert.match(card, /<button className="concierge-product-image"/);
  assert.match(card, /<h2><a href=\{detailHref\}/);
  assert.match(card, /externalShop \? 'View on Amazon' : 'View product'/);
});

test('the iOS AI Studio card opens Amazon products without exposing try-on', async (t) => {
  const source = await readOptionalFixture('../fit-look-APP/mobile/App.js');
  if (!source) {
    t.skip('fit-look-APP is not present in this checkout');
    return;
  }

  const screenStart = source.indexOf('function StyleBotScreen(');
  const screenEnd = source.indexOf('\nfunction ', screenStart + 30);
  const screen = source.slice(screenStart, screenEnd > screenStart ? screenEnd : undefined);

  assert.ok(screenStart > 0);
  assert.match(screen, /const onlineProduct = isOnlineAiStudioProduct\(product\)/);
  assert.match(screen, /onlineProduct \? \(product\.searchLink \? 'Search Amazon' : 'View on Amazon'\)/);
  assert.match(screen, /onOpenProduct=\{\(\) => onlineProduct/);
  assert.match(screen, /: onNavigate\('product', \{ id: product\.id \}\)\}/);
  assert.match(screen, /onTryOn=\{onlineProduct \? undefined/);
  assert.match(source, /isOnlineAiStudioProduct\(product\) \|\| chatTryOnLoading/);
  assert.match(source, /const handleCardPress = onOpenProduct \|\| onShop/);
  assert.match(source, /const handleImagePress = onPreview \|\| handleCardPress/);
  assert.match(screen, /const previewUri = productImageSource\(product, tryOn\)\?\.uri/);
  assert.match(screen, /onPreview=\{previewUri \? \(\) => setLightbox\(previewUri\) : null\}/);
  assert.match(source, /accessibilityLabel=\{tryOn\?\.imageUrl \? `View AI preview/);
  assert.match(source, /accessibilityLabel=\{`Open product details/);
});

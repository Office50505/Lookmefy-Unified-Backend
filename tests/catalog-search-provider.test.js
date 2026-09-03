import assert from 'node:assert/strict';
import test from 'node:test';
import {
  catalogSearchProviderName,
  normalizeSerpApiAmazonResult,
  searchSerpApiAmazon
} from '../server/services/catalogSearchProvider.js';

test('selects SerpApi automatically when its API key is configured', () => {
  assert.equal(catalogSearchProviderName({ SERPAPI_API_KEY: 'configured' }), 'serpapi');
  assert.equal(catalogSearchProviderName({}), 'amazon-html');
  assert.equal(catalogSearchProviderName({ CATALOG_SEARCH_PROVIDER: 'SERPAPI' }), 'serpapi');
});

test('normalizes SerpApi Amazon results into smart-import candidates', () => {
  const result = normalizeSerpApiAmazonResult({
    asin: 'B0ABCDEF12',
    title: 'Acme Women White Midi Dress',
    extracted_price: 799,
    extracted_old_price: 1199,
    rating: 4.3,
    reviews: 182,
    thumbnail: 'https://m.media-amazon.com/images/I/example.jpg'
  }, { amazonDomain: 'amazon.in' });

  assert.deepEqual(result, {
    provider: 'serpapi',
    asin: 'B0ABCDEF12',
    link: 'https://www.amazon.in/dp/B0ABCDEF12',
    name: 'Acme Women White Midi Dress',
    brand: '',
    description: '',
    price: 799,
    compareAtPrice: 1199,
    currency: 'INR',
    rating: 4.3,
    ratingCount: 182,
    remoteImageUrl: 'https://m.media-amazon.com/images/I/example.jpg'
  });
});

test('searches SerpApi without exposing its key in returned records', async () => {
  let requestedUrl = '';
  const fetchImpl = async (url) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({
      organic_results: [{
        asin: 'B0ABCDEF12',
        title: 'Acme Black T-Shirt',
        extracted_price: 599,
        thumbnail: 'https://m.media-amazon.com/images/I/example.jpg'
      }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const results = await searchSerpApiAmazon('black t-shirts', {
    env: { SERPAPI_API_KEY: 'private-test-key', SERPAPI_AMAZON_DOMAIN: 'amazon.in' },
    fetchImpl
  });

  assert.match(requestedUrl, /engine=amazon/);
  assert.match(requestedUrl, /amazon_domain=amazon.in/);
  assert.match(requestedUrl, /api_key=private-test-key/);
  assert.equal(JSON.stringify(results).includes('private-test-key'), false);
  assert.equal(results[0].link, 'https://www.amazon.in/dp/B0ABCDEF12');
});

test('returns a safe error when SerpApi rejects the request', async () => {
  await assert.rejects(
    searchSerpApiAmazon('dress', {
      env: { SERPAPI_API_KEY: 'bad-key' },
      fetchImpl: async () => new Response(JSON.stringify({ error: 'Invalid API key' }), { status: 401 })
    }),
    /SerpApi catalog search failed: Invalid API key/
  );
});

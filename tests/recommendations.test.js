import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRecentProfile,
  normalizeGender,
  ratingQuality,
  rerankDiverse,
  scoreProduct
} from '../server/routes/recommendations.js';

const now = new Date('2026-08-20T12:00:00.000Z');
let productSequence = 0;

function product(overrides = {}) {
  return {
    _id: overrides._id || `product-${productSequence += 1}`,
    category: 'Dresses',
    brand: 'Acme',
    gender: 'women',
    tags: ['cotton', 'casual'],
    price: 999,
    rating: 4.4,
    ratingCount: 40,
    createdAt: '2026-07-20T12:00:00.000Z',
    isNewArrival: false,
    isFeatured: false,
    ...overrides
  };
}

test('recent behavior outweighs an otherwise equal older signal', () => {
  const recentProfile = buildRecentProfile([
    {
      type: 'product_view',
      product: product({ _id: 'recent', category: 'Dresses' }),
      createdAt: now
    },
    {
      type: 'product_view',
      product: product({ _id: 'old', category: 'Jeans' }),
      createdAt: new Date(now.getTime() - (28 * 24 * 60 * 60 * 1000))
    }
  ], now);

  assert.ok(recentProfile.categories.get('dresses') > recentProfile.categories.get('jeans') * 3.9);
  assert.equal(recentProfile.signalCount, 2);
});

test('ranking combines learned taste with the explicit gender preference', () => {
  const preference = {
    categories: { dresses: 12 },
    brands: { acme: 8 },
    genders: { women: 10 },
    tags: { cotton: 6 },
    priceTotal: 9990,
    priceCount: 10
  };
  const matching = scoreProduct(product({ _id: 'matching' }), { preference, genderPreference: 'female', now });
  const unrelated = scoreProduct(product({
    _id: 'unrelated',
    category: 'Shirts',
    brand: 'Other',
    gender: 'men',
    tags: ['formal'],
    price: 2500
  }), { preference, genderPreference: 'female', now });

  assert.ok(matching.score > unrelated.score + 8);
  assert.ok(matching.reasons.includes('category'));
});

test('rating quality favors evidence over an unsupported perfect rating', () => {
  assert.ok(
    ratingQuality(product({ rating: 4.8, ratingCount: 100 }))
      > ratingQuality(product({ rating: 5, ratingCount: 0 }))
  );
});

test('recent exposure lowers an exact product without suppressing its whole category', () => {
  const viewed = product({ _id: 'viewed' });
  const unseen = product({ _id: 'unseen' });
  const recentProfile = buildRecentProfile([
    { type: 'product_view', product: viewed, createdAt: now },
    { type: 'product_view', product: viewed, createdAt: now },
    { type: 'product_click', product: viewed, createdAt: now }
  ], now);

  const viewedScore = scoreProduct(viewed, { recentProfile, genderPreference: 'female', now });
  const unseenScore = scoreProduct(unseen, { recentProfile, genderPreference: 'female', now });
  assert.ok(unseenScore.score > viewedScore.score + 1);
});

test('search terms match product names and categories as style signals', () => {
  const recentProfile = buildRecentProfile([
    { type: 'search', query: 'summer dresses', createdAt: now }
  ], now);
  const match = scoreProduct(product({ name: 'Summer Dress', category: 'Dresses' }), { recentProfile, now });
  const unrelated = scoreProduct(product({ name: 'Formal Blazer', category: 'Blazers', tags: ['formal'] }), { recentProfile, now });

  assert.ok(match.score > unrelated.score + 1);
  assert.ok(match.reasons.includes('style'));
});

test('diversity reranking breaks up repeated brands and categories', () => {
  const scored = [
    { product: product({ _id: 'a', category: 'Dresses', brand: 'Acme' }), score: 10 },
    { product: product({ _id: 'b', category: 'Dresses', brand: 'Acme' }), score: 9.8 },
    { product: product({ _id: 'c', category: 'Dresses', brand: 'Acme' }), score: 9.6 },
    { product: product({ _id: 'd', category: 'Jeans', brand: 'Denim Co' }), score: 9.4 }
  ];

  const ranked = rerankDiverse(scored, 4);
  assert.deepEqual(ranked.slice(0, 2).map((item) => item.product._id), ['a', 'd']);
  assert.equal(ranked.length, 4);
});

test('catalog gender labels normalize consistently', () => {
  assert.equal(normalizeGender("Women's"), 'female');
  assert.equal(normalizeGender('Men'), 'male');
  assert.equal(normalizeGender('Unisex'), 'unisex');
});

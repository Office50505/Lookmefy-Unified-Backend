import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRecentProfile,
  normalizeGender,
  ratingQuality,
  rerankDiverse,
  scoreProduct
} from '../server/routes/recommendations.js';
import {
  buildRecommendationContext,
  normalizeRecommendationClient,
  normalizeRecommendationSurface
} from '../server/services/recommendationContext.js';
import {
  buildForYouCandidatePools,
  buildCatalogCandidatePools,
  mergeCandidatePools,
  normalizeCandidateSource
} from '../server/services/recommendationCandidates.js';
import {
  buildRecommendationReasons,
  recommendationReasonLabel
} from '../server/services/recommendationReasons.js';
import {
  scoreSummary,
  summarizeRecommendationDiagnostics
} from '../server/services/recommendationDiagnostics.js';
import {
  applyScoringConfig,
  boundedComponentWeight,
  normalizeComponentWeights,
  scoringConfigForContext
} from '../server/services/recommendationScoringConfig.js';
import {
  annotateRecommendationCandidates,
  hasRecommendationDisplayBasics,
  productRecommendationImageUrl,
  recommendationCatalogFilter,
  recommendationEligibilityIssues
} from '../server/services/recommendationEligibility.js';
import {
  productPreferenceIncrements,
  queryPreferenceIncrements
} from '../server/services/recommendationPreferences.js';
import {
  isUsefulQueryTerm,
  priceBandForPrice,
  productStyleSignals,
  queryTerms,
  shouldLearnFromQueryEvent,
  styleSignalsFromText
} from '../server/services/recommendationScoring.js';

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

test('surface scoring config is neutral until a surface is intentionally tuned', () => {
  const preference = {
    categories: { dresses: 12 },
    brands: { acme: 8 },
    genders: { women: 10 },
    tags: { cotton: 6 },
    priceTotal: 9990,
    priceCount: 10
  };
  const base = scoreProduct(product({ _id: 'neutral-base' }), { preference, genderPreference: 'female', now });
  const configured = scoreProduct(product({ _id: 'neutral-configured' }), {
    preference,
    genderPreference: 'female',
    scoringConfig: scoringConfigForContext({ surface: 'home', client: 'ios' }),
    now
  });

  assert.equal(scoringConfigForContext({ surface: 'home', client: 'ios' }).id, 'home-balanced-v1:app-ios');
  assert.deepEqual(
    {
      surface: scoringConfigForContext({ surface: 'unknown', client: 'mystery' }).surface,
      client: scoringConfigForContext({ surface: 'unknown', client: 'mystery' }).client
    },
    { surface: 'for_you', client: 'unknown' }
  );
  assert.equal(configured.score, base.score);
  assert.deepEqual(configured.components, base.components);
});

test('component scoring weights are bounded and can tune scores explicitly', () => {
  const productInput = product({ _id: 'weighted-score', isFeatured: true });
  const base = scoreProduct(productInput, { genderPreference: 'female', now });
  const tuned = scoreProduct(productInput, {
    genderPreference: 'female',
    scoringConfig: {
      componentWeights: {
        quality: 0,
        freshness: 2,
        explicitGender: 1.5,
        category: 99
      }
    },
    now
  });

  assert.equal(boundedComponentWeight(99), 4);
  assert.equal(boundedComponentWeight(-2), 0);
  assert.equal(normalizeComponentWeights({ freshness: 2, unknown: 10 }).freshness, 2);
  assert.equal(normalizeComponentWeights({ freshness: 2, unknown: 10 }).category, 1);
  assert.equal(applyScoringConfig({ quality: 1.2, freshness: 0.5 }, { componentWeights: { quality: 0 } }).quality, 0);
  assert.equal(tuned.components.quality, 0);
  assert.equal(tuned.components.freshness, base.components.freshness * 2);
  assert.equal(tuned.components.category, base.components.category * 4);
  assert.ok(tuned.score > base.score);
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

test('query terms filter chat noise while keeping fashion intent terms', () => {
  assert.deepEqual(queryTerms('hi hii what weather show me black office formal blazer under 1500'), [
    'black',
    'office',
    'formal',
    'blazer'
  ]);
  assert.equal(isUsefulQueryTerm('hiiiiiiiiiiiii'), false);
  assert.equal(isUsefulQueryTerm('hnbfkjdsbkkjfbvkads'), false);
  assert.equal(isUsefulQueryTerm('black'), true);
});

test('style bot query learning is gated by fashion intent metadata', () => {
  assert.equal(shouldLearnFromQueryEvent({
    type: 'style_bot_query',
    query: 'what is the weather',
    metadata: { mode: 'chat_control', intent: 'out_of_scope' }
  }), false);
  assert.equal(shouldLearnFromQueryEvent({
    type: 'style_bot_query',
    query: 'black office blazer',
    metadata: { mode: 'product_search', intent: 'product_search_confirmed' }
  }), true);
  assert.equal(shouldLearnFromQueryEvent({
    type: 'search',
    query: 'black office blazer'
  }), true);
});

test('recent profile ignores non-fashion style bot query text', () => {
  const recentProfile = buildRecentProfile([
    {
      type: 'style_bot_query',
      query: 'what is the weather',
      metadata: { mode: 'chat_control', intent: 'out_of_scope' },
      createdAt: now
    },
    {
      type: 'style_bot_query',
      query: 'black office formal blazer',
      metadata: { mode: 'product_search', intent: 'product_search_confirmed' },
      createdAt: now
    }
  ], now);

  assert.equal(recentProfile.tags.has('weather'), false);
  assert.equal(recentProfile.tags.has('black'), true);
  assert.equal(recentProfile.colors.has('black'), true);
  assert.equal(recentProfile.occasions.has('work'), true);
  assert.equal(recentProfile.formalities.has('formal'), true);
});

test('richer style signals learn color, occasion, formality, placement, and price band', () => {
  const recentProfile = buildRecentProfile([
    {
      type: 'search',
      query: 'red wedding formal dress',
      createdAt: now
    }
  ], now);
  const match = scoreProduct(product({
    _id: 'style-match',
    colors: ['Red'],
    garmentPlacement: 'full-body',
    tags: ['wedding', 'formal'],
    price: 1200
  }), { recentProfile, now });
  const unrelated = scoreProduct(product({
    _id: 'style-miss',
    category: 'Jeans',
    colors: ['Blue'],
    garmentPlacement: 'bottom',
    tags: ['casual'],
    price: 3500
  }), { recentProfile, now });

  assert.equal(priceBandForPrice(1200), 'value');
  assert.deepEqual(productStyleSignals({ colors: ['Red'], tags: ['wedding'], garmentPlacement: 'full-body', price: 1200 }).priceBands, ['value']);
  assert.deepEqual(styleSignalsFromText('black office formal blazer').colors, ['black']);
  assert.ok(match.components.colors > 0);
  assert.ok(match.components.occasion > 0);
  assert.ok(match.components.formality > 0);
  assert.ok(match.components.garmentPlacement > 0);
  assert.ok(match.score > unrelated.score + 2);
});

test('preference increments include richer style metadata and avoid buckets', () => {
  const increments = productPreferenceIncrements({
    category: 'Dresses',
    brand: 'Acme',
    gender: 'women',
    tags: ['party'],
    colors: ['Red'],
    garmentPlacement: 'full-body',
    occasion: 'wedding',
    formality: 'formal',
    price: 1200
  }, 2);
  const avoidIncrements = productPreferenceIncrements({
    category: 'Dresses',
    colors: ['Red'],
    priceBand: 'value'
  }, 2, { prefix: 'avoid', includePriceAverage: false });
  const queryIncrements = queryPreferenceIncrements('black office formal blazer', 3);

  assert.equal(increments['colors.red'], 1.6);
  assert.equal(increments['garmentPlacements.full_body'], 1.3);
  assert.equal(increments['occasions.wedding'], 1.7);
  assert.equal(increments['formalities.formal'], 1.5);
  assert.equal(increments['priceBands.value'], 0.9);
  assert.equal(increments.priceTotal, 2400);
  assert.equal(avoidIncrements['avoidCategories.dresses'], 2);
  assert.equal(avoidIncrements['avoidColors.red'], 1.6);
  assert.equal(avoidIncrements['avoidPriceBands.value'], 0.9);
  assert.equal(Number(queryIncrements['colors.black'].toFixed(2)), 2.4);
  assert.equal(queryIncrements['occasions.work'], 2.55);
  assert.equal(queryIncrements['formalities.formal'], 2.25);
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

test('recommendation context normalizes supported surfaces and falls back safely', () => {
  assert.equal(normalizeRecommendationSurface('wardrobe'), 'from_your_wardrobe');
  assert.equal(normalizeRecommendationSurface('product-detail'), 'similar');
  assert.equal(normalizeRecommendationSurface('try on'), 'tryon_next');
  assert.equal(normalizeRecommendationSurface('unknown surface'), 'for_you');
  assert.equal(normalizeRecommendationSurface('', 'similar'), 'similar');
});

test('recommendation context normalizes clients from query, body, and headers', () => {
  assert.equal(normalizeRecommendationClient('iPhone'), 'ios');
  assert.equal(normalizeRecommendationClient('react-native-android'), 'android');
  assert.equal(normalizeRecommendationClient('website'), 'web');
  assert.equal(normalizeRecommendationClient('mystery'), 'unknown');
  assert.deepEqual(
    buildRecommendationContext({
      query: { surface: 'wishlist', client: 'web' },
      body: { client: 'ios' },
      defaultSurface: 'for_you'
    }),
    { surface: 'wishlist_next', client: 'ios' }
  );
  assert.deepEqual(
    buildRecommendationContext({
      headers: { 'x-lookmefy-client': 'rn_android' },
      defaultSurface: 'similar'
    }),
    { surface: 'similar', client: 'android' }
  );
});

test('candidate pools dedupe products while preserving candidate sources', () => {
  const shared = product({ _id: 'shared' });
  const merged = mergeCandidatePools([
    { source: 'Recent Intent', products: [shared, product({ _id: 'fresh' })] },
    { source: 'wardrobe-match', products: [product({ _id: 'shared' }), product({ _id: 'closet' })] },
    { source: '', products: [product({ _id: 'ignored' })] }
  ]);

  assert.equal(normalizeCandidateSource('Recent Intent'), 'recent_intent');
  assert.deepEqual(merged.map((candidate) => candidate.product._id), ['shared', 'fresh', 'closet']);
  assert.deepEqual(merged[0].candidateSources, ['recent_intent', 'wardrobe_match']);
});

test('catalog candidate pools label featured and fresh products without changing candidates', () => {
  const featured = product({ _id: 'featured', isFeatured: true });
  const fresh = product({ _id: 'fresh-new', isNewArrival: true });
  const ordinary = product({ _id: 'ordinary' });
  const merged = mergeCandidatePools(buildCatalogCandidatePools([featured, fresh, ordinary]));

  assert.deepEqual(merged.map((candidate) => candidate.product._id), ['featured', 'fresh-new', 'ordinary']);
  assert.deepEqual(merged[0].candidateSources, ['catalog_pool', 'featured_catalog']);
  assert.deepEqual(merged[1].candidateSources, ['catalog_pool', 'fresh_catalog']);
  assert.deepEqual(merged[2].candidateSources, ['catalog_pool']);
});

test('for-you candidate pools add popular, preference, and recent intent sources', () => {
  const preference = {
    colors: { red: 4 },
    occasions: { wedding: 2 },
    priceBands: { value: 2 }
  };
  const recentProfile = buildRecentProfile([
    { type: 'search', query: 'black office formal blazer', createdAt: now }
  ], now);
  const preferenceProduct = product({
    _id: 'candidate-pref',
    colors: ['red'],
    tags: ['wedding'],
    price: 1200
  });
  const recentProduct = product({
    _id: 'candidate-recent',
    colors: ['black'],
    tags: ['office', 'formal'],
    category: 'Blazers',
    price: 2500
  });
  const popularProduct = product({
    _id: 'candidate-popular',
    rating: 4.8,
    ratingCount: 100
  });
  const merged = mergeCandidatePools(buildForYouCandidatePools([
    preferenceProduct,
    recentProduct,
    popularProduct
  ], { preference, recentProfile }));

  assert.ok(merged.find((candidate) => candidate.product._id === 'candidate-pref').candidateSources.includes('preference_match'));
  assert.ok(merged.find((candidate) => candidate.product._id === 'candidate-recent').candidateSources.includes('recent_intent'));
  assert.ok(merged.find((candidate) => candidate.product._id === 'candidate-popular').candidateSources.includes('popular_catalog'));
});

test('recommendation reasons preserve score priority and labels', () => {
  const reasons = buildRecommendationReasons({
    category: 2.5,
    brand: 1.1,
    tags: 3.2,
    price: 0.7,
    explicitGender: 0.8,
    quality: 1.9,
    freshness: 0.2
  });

  assert.deepEqual(reasons, ['style', 'category', 'popular']);
  assert.equal(recommendationReasonLabel('style'), 'Style match');
  assert.equal(recommendationReasonLabel('unknown'), '');
});

test('recommendation catalog filter preserves active and availability constraints', () => {
  const filter = recommendationCatalogFilter({ category: 'Dresses', $and: [{ price: { $gte: 500 } }] });

  assert.equal(filter.category, 'Dresses');
  assert.equal(filter.isActive, true);
  assert.ok(Array.isArray(filter.$nor));
  assert.ok(Array.isArray(filter.$and));
  assert.equal(filter.$and.length, 2);
});

test('recommendation eligibility reports display issues without rejecting in scoring', () => {
  const ready = {
    _id: 'ready-product',
    name: 'Ready Dress',
    category: 'Dresses',
    price: 999,
    image: { url: '/dress.jpg' },
    availabilityStatus: 'available',
    isActive: true
  };
  const broken = product({
    name: '',
    category: '',
    price: -1,
    image: {},
    availabilityStatus: 'out_of_stock',
    isActive: false
  });

  assert.equal(productRecommendationImageUrl(ready), '/dress.jpg');
  assert.equal(hasRecommendationDisplayBasics(ready), true);
  assert.deepEqual(recommendationEligibilityIssues(broken), [
    'missing_name',
    'missing_category',
    'invalid_price',
    'missing_image',
    'unavailable',
    'inactive'
  ]);
});

test('recommendation eligibility annotates candidates without removing them', () => {
  const ready = {
    product: {
      _id: 'ready-product',
      name: 'Ready Dress',
      category: 'Dresses',
      price: 999,
      image: { url: '/dress.jpg' },
      availabilityStatus: 'available',
      isActive: true
    },
    candidateSources: ['catalog_pool']
  };
  const broken = {
    product: product({
      _id: 'broken-product',
      name: '',
      image: {},
      availabilityStatus: 'out_of_stock'
    }),
    candidateSources: ['catalog_pool']
  };
  const annotated = annotateRecommendationCandidates([ready, broken]);

  assert.equal(annotated.length, 2);
  assert.equal(annotated[0].eligibleForRecommendation, true);
  assert.deepEqual(annotated[0].eligibilityIssues, []);
  assert.equal(annotated[1].eligibleForRecommendation, false);
  assert.ok(annotated[1].eligibilityIssues.includes('missing_name'));
  assert.ok(annotated[1].eligibilityIssues.includes('missing_image'));
});

test('recommendation diagnostics summarize candidates and selected products', () => {
  const candidates = [
    {
      product: product({ _id: 'diagnostic-a' }),
      score: 8.5,
      components: { category: 2, quality: 1.2, exposure: -0.5 },
      reasons: ['category', 'popular'],
      candidateSources: ['catalog_pool', 'featured_catalog'],
      eligibleForRecommendation: true,
      eligibilityIssues: []
    },
    {
      product: product({ _id: 'diagnostic-b' }),
      score: 4,
      components: { category: 0.5, quality: 0.8, exposure: 0 },
      reasons: ['popular'],
      candidateSources: ['catalog_pool'],
      eligibleForRecommendation: false,
      eligibilityIssues: ['missing_image']
    }
  ];

  const diagnostics = summarizeRecommendationDiagnostics(candidates, candidates.slice(0, 1), {
    surface: 'for_you',
    scoringProfile: 'for-you-balanced-v1:web',
    personalized: true,
    signalCount: 3
  });

  assert.deepEqual(scoreSummary(candidates), { min: 4, max: 8.5, average: 6.25 });
  assert.equal(diagnostics.surface, 'for_you');
  assert.equal(diagnostics.scoringProfile, 'for-you-balanced-v1:web');
  assert.equal(diagnostics.personalized, true);
  assert.equal(diagnostics.signalCount, 3);
  assert.equal(diagnostics.candidates.total, 2);
  assert.deepEqual(diagnostics.candidates.candidateSources, {
    catalog_pool: 2,
    featured_catalog: 1
  });
  assert.deepEqual(diagnostics.candidates.reasons, {
    popular: 2,
    category: 1
  });
  assert.deepEqual(diagnostics.candidates.eligibility, {
    eligible: 1,
    ineligible: 1
  });
  assert.deepEqual(diagnostics.candidates.eligibilityIssues, {
    missing_image: 1
  });
  assert.equal(diagnostics.candidates.components.category.average, 1.25);
  assert.equal(diagnostics.selected.total, 1);
  assert.equal(diagnostics.selected.scores.average, 8.5);
});

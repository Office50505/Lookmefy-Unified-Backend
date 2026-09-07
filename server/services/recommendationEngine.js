import { randomUUID } from 'node:crypto';
import Product, { productToClient } from '../models/Product.js';
import UserEvent from '../models/UserEvent.js';
import UserPreference from '../models/UserPreference.js';
import { createHybridCache } from '../utils/cache.js';
import { buildForYouCandidatePools, mergeCandidatePools } from './recommendationCandidates.js';
import { normalizeRecommendationClient, normalizeRecommendationSurface } from './recommendationContext.js';
import { summarizeRecommendationDiagnostics } from './recommendationDiagnostics.js';
import { annotateRecommendationCandidates, recommendationCatalogFilter } from './recommendationEligibility.js';
import {
  DAY_MS,
  RECENT_EVENT_WINDOW_DAYS,
  RECOMMENDATION_ALGORITHM_VERSION,
  SIMILAR_ALGORITHM_VERSION,
  boundedLimit,
  buildRecentProfile,
  normalizeGender,
  rerankDiverse,
  scoreProduct,
  similarScore
} from './recommendationScoring.js';
import { scoringConfigForContext } from './recommendationScoringConfig.js';

const recommendationCacheTtlMs = Number(process.env.RECOMMENDATION_READ_CACHE_TTL_MS || 5 * 60 * 1000);
const productPoolCache = createHybridCache('recommendations:product-pool', { ttlMs: recommendationCacheTtlMs, maxItems: 20 });
const similarProductsCache = createHybridCache('recommendations:similar', { ttlMs: recommendationCacheTtlMs, maxItems: 300 });
const recommendationCandidatePoolSize = Math.min(1000, Math.max(100, Math.floor(Number(process.env.RECOMMENDATION_CANDIDATE_POOL_SIZE) || 400)));

const catalogFilter = recommendationCatalogFilter;

function recommendationRequestId(surface) {
  return `rec_${surface}_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

function recommendationDiagnosticsEnabled() {
  const value = String(process.env.RECOMMENDATION_DEBUG_RESPONSES || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  return String(process.env.NODE_ENV || '').trim().toLowerCase() !== 'production';
}

function attachRecommendationDiagnostics(payload, diagnostics, includeDiagnostics) {
  if (!includeDiagnostics || !recommendationDiagnosticsEnabled()) return payload;
  return {
    ...payload,
    recommendationDiagnostics: diagnostics
  };
}

function recommendationScoringProfile(config) {
  return String(config?.id || '').trim();
}

async function clearRecommendationCaches() {
  await Promise.all([
    productPoolCache.clear(),
    similarProductsCache.clear()
  ]);
}

async function getForYouRecommendations({ user, limit: requestedLimit, surface: requestedSurface, client: requestedClient, includeDiagnostics = false, now = new Date() }) {
  const limit = boundedLimit(requestedLimit, 8, 24);
  const surface = normalizeRecommendationSurface(requestedSurface, 'for_you');
  const client = normalizeRecommendationClient(requestedClient);
  const scoringConfig = scoringConfigForContext({ surface, client });
  const scoringProfile = recommendationScoringProfile(scoringConfig);
  const requestId = recommendationRequestId(surface);
  const recentSince = new Date(now.getTime() - (RECENT_EVENT_WINDOW_DAYS * DAY_MS));
  const [preference, recentEvents, products] = await Promise.all([
    UserPreference.findOne({ user: user._id }).lean(),
    UserEvent.find({ user: user._id, createdAt: { $gte: recentSince } })
      .sort({ createdAt: -1 })
      .limit(250)
      .populate('product', 'category brand gender tags price')
      .lean(),
    productPoolCache.remember(
      `for-you-catalog:${recommendationCandidatePoolSize}`,
      () => Product.find(catalogFilter()).sort({ isFeatured: -1, createdAt: -1 }).limit(recommendationCandidatePoolSize).lean()
    )
  ]);
  const recentProfile = buildRecentProfile(recentEvents, now);
  const candidates = annotateRecommendationCandidates(mergeCandidatePools(buildForYouCandidatePools(products, {
    preference,
    recentProfile
  })));
  const scoredProducts = candidates.map(({ product, candidateSources, eligibilityIssues, eligibleForRecommendation }) => {
    const result = scoreProduct(product, {
      preference,
      recentProfile,
      genderPreference: user.genderPreference,
      scoringConfig,
      now
    });
    return { product, candidateSources, eligibilityIssues, eligibleForRecommendation, ...result };
  });
  const personalized = Boolean(preference || recentProfile.signalCount || ['male', 'female'].includes(normalizeGender(user.genderPreference)));
  const selected = rerankDiverse(scoredProducts, limit);
  const ranked = selected
    .map(({ product, candidateSources, score, reasons }, index) => ({
      ...productToClient(product),
      recommendationScore: Math.round(score * 100) / 100,
      recommendationReasons: reasons,
      recommendationContext: {
        source: surface,
        candidateSources,
        algorithmVersion: RECOMMENDATION_ALGORITHM_VERSION,
        scoringProfile,
        rank: index + 1,
        personalized
      }
    }));

  const payload = {
    requestId,
    surface,
    client,
    products: ranked,
    personalized,
    algorithmVersion: RECOMMENDATION_ALGORITHM_VERSION,
    scoringProfile,
    signalCount: recentProfile.signalCount
  };
  return attachRecommendationDiagnostics(
    payload,
    summarizeRecommendationDiagnostics(scoredProducts, selected, {
      surface,
      scoringProfile,
      personalized,
      signalCount: recentProfile.signalCount
    }),
    includeDiagnostics
  );
}

async function getSimilarRecommendations({ productId, limit: requestedLimit, client: requestedClient, includeDiagnostics = false }) {
  const limit = Math.min(Number(requestedLimit) || 4, 12);
  const surface = 'similar';
  const client = normalizeRecommendationClient(requestedClient);
  const requestId = recommendationRequestId(surface);
  const cacheKey = `${productId}:${limit}`;
  const payload = await similarProductsCache.remember(cacheKey, async () => {
    const base = await Product.findOne(catalogFilter({ _id: productId })).lean();
    if (!base) {
      const error = new Error('Product not found');
      error.statusCode = 404;
      throw error;
    }
    const products = await Product.find(catalogFilter({ _id: { $ne: base._id } })).limit(160).lean();
    const scoredProducts = annotateRecommendationCandidates(mergeCandidatePools([{ source: 'similar_catalog', products }]))
      .map(({ product, candidateSources, eligibilityIssues, eligibleForRecommendation }) => ({
        product,
        candidateSources,
        eligibilityIssues,
        eligibleForRecommendation,
        score: similarScore(base, product)
      }))
      .sort((a, b) => b.score - a.score);
    const selected = scoredProducts.slice(0, limit);
    const ranked = selected
      .map(({ product, candidateSources, score }, index) => ({
        ...productToClient(product),
        recommendationScore: Math.round(score * 100) / 100,
        recommendationContext: {
          source: surface,
          candidateSources,
          algorithmVersion: SIMILAR_ALGORITHM_VERSION,
          rank: index + 1,
          personalized: false
        }
      }));
    return {
      products: ranked,
      algorithmVersion: SIMILAR_ALGORITHM_VERSION,
      diagnostics: summarizeRecommendationDiagnostics(scoredProducts, selected, {
        surface,
        personalized: false,
        signalCount: 0
      })
    };
  });

  const { diagnostics, ...responsePayload } = payload;
  return attachRecommendationDiagnostics(
    { requestId, surface, client, ...responsePayload },
    diagnostics,
    includeDiagnostics
  );
}

export {
  catalogFilter,
  clearRecommendationCaches,
  getForYouRecommendations,
  getSimilarRecommendations
};

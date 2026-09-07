import {
  normalizeKey,
  productStyleSignals,
  ratingQuality
} from './recommendationScoring.js';

function candidateProductId(product) {
  const id = product?._id ?? product?.id ?? product;
  if (!id) return '';
  return typeof id === 'string' ? id : id.toString?.() || '';
}

function normalizeCandidateSource(source = '') {
  return String(source || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

function mergeCandidatePools(pools = []) {
  const merged = new Map();
  for (const pool of pools) {
    const source = normalizeCandidateSource(pool?.source);
    const products = Array.isArray(pool?.products) ? pool.products : [];
    if (!source || !products.length) continue;
    for (const product of products) {
      const id = candidateProductId(product);
      if (!id) continue;
      const existing = merged.get(id);
      if (existing) {
        if (!existing.candidateSources.includes(source)) existing.candidateSources.push(source);
      } else {
        merged.set(id, { product, candidateSources: [source] });
      }
    }
  }
  return [...merged.values()];
}

function buildCatalogCandidatePools(products = []) {
  const safeProducts = Array.isArray(products) ? products : [];
  return [
    { source: 'catalog_pool', products: safeProducts },
    { source: 'featured_catalog', products: safeProducts.filter((product) => product?.isFeatured) },
    { source: 'fresh_catalog', products: safeProducts.filter((product) => product?.isNewArrival) }
  ];
}

function mapValue(map, key) {
  if (!map || !key) return 0;
  return Number(map.get?.(key) || map[key] || 0);
}

function signalSetScore(keys = [], preferenceMap, recentMap) {
  return [...new Set(keys.map(normalizeKey).filter(Boolean))]
    .reduce((sum, key) => sum + mapValue(preferenceMap, key) + mapValue(recentMap, key), 0);
}

function preferenceMatchScore(product, preference) {
  const signals = productStyleSignals(product);
  return (
    mapValue(preference?.categories, normalizeKey(product?.category))
    + mapValue(preference?.brands, normalizeKey(product?.brand)) * 0.75
    + signalSetScore(product?.tags || [], preference?.tags, null) * 0.65
    + signalSetScore(signals.colors, preference?.colors, null) * 0.8
    + signalSetScore(signals.garmentPlacements, preference?.garmentPlacements, null) * 0.65
    + signalSetScore(signals.occasions, preference?.occasions, null) * 0.85
    + signalSetScore(signals.formalities, preference?.formalities, null) * 0.75
    + signalSetScore(signals.priceBands, preference?.priceBands, null) * 0.45
  );
}

function recentIntentScore(product, recentProfile) {
  const signals = productStyleSignals(product);
  return (
    mapValue(recentProfile?.categories, normalizeKey(product?.category))
    + mapValue(recentProfile?.brands, normalizeKey(product?.brand)) * 0.75
    + signalSetScore(product?.tags || [], null, recentProfile?.tags) * 0.65
    + signalSetScore(signals.colors, null, recentProfile?.colors) * 0.8
    + signalSetScore(signals.garmentPlacements, null, recentProfile?.garmentPlacements) * 0.65
    + signalSetScore(signals.occasions, null, recentProfile?.occasions) * 0.85
    + signalSetScore(signals.formalities, null, recentProfile?.formalities) * 0.75
    + signalSetScore(signals.priceBands, null, recentProfile?.priceBands) * 0.45
  );
}

function topScoredProducts(products, scoreFn, limit) {
  return products
    .map((product) => ({ product, score: scoreFn(product) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || candidateProductId(a.product).localeCompare(candidateProductId(b.product)))
    .slice(0, limit)
    .map((item) => item.product);
}

function buildForYouCandidatePools(products = [], { preference, recentProfile } = {}) {
  const safeProducts = Array.isArray(products) ? products : [];
  const popularProducts = [...safeProducts]
    .filter((product) => Number(product?.ratingCount || 0) > 0 || Number(product?.rating || 0) > 0)
    .sort((a, b) => ratingQuality(b) - ratingQuality(a) || Number(b.ratingCount || 0) - Number(a.ratingCount || 0))
    .slice(0, 120);

  return [
    ...buildCatalogCandidatePools(safeProducts),
    { source: 'popular_catalog', products: popularProducts },
    { source: 'preference_match', products: topScoredProducts(safeProducts, (product) => preferenceMatchScore(product, preference), 160) },
    { source: 'recent_intent', products: topScoredProducts(safeProducts, (product) => recentIntentScore(product, recentProfile), 160) }
  ];
}

export {
  buildForYouCandidatePools,
  buildCatalogCandidatePools,
  candidateProductId,
  mergeCandidatePools,
  normalizeCandidateSource
};

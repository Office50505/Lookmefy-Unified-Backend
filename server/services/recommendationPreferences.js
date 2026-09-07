import UserPreference from '../models/UserPreference.js';
import {
  eventWeight,
  listValues,
  normalizeGender,
  normalizeKey,
  priceBandForPrice,
  productStyleSignals,
  queryTerms,
  shouldLearnFromQueryEvent,
  styleSignalsFromText
} from './recommendationScoring.js';

const AVOID_EVENT_WEIGHTS = {
  wishlist_remove: 2.5
};

function addIncrement(increments, bucket, value, weight, scale = 1) {
  const key = normalizeKey(value);
  if (!key || !Number.isFinite(weight) || weight <= 0) return;
  increments[`${bucket}.${key}`] = (increments[`${bucket}.${key}`] || 0) + weight * scale;
}

function metadataList(product, pluralKey, singularKey) {
  return [
    ...listValues(product?.[pluralKey]),
    ...listValues(product?.[singularKey])
  ];
}

function explicitStyleSignals(product = {}) {
  return {
    colors: metadataList(product, 'colors', 'color'),
    garmentPlacements: metadataList(product, 'garmentPlacements', 'garmentPlacement'),
    occasions: metadataList(product, 'occasions', 'occasion'),
    formalities: metadataList(product, 'formalities', 'formality'),
    priceBands: metadataList(product, 'priceBands', 'priceBand')
  };
}

function styleSignalIncrements(product, weight, buckets) {
  const increments = {};
  const derived = productStyleSignals(product || {});
  const explicit = explicitStyleSignals(product || {});

  [...new Set([...derived.colors, ...explicit.colors].map(normalizeKey).filter(Boolean))]
    .forEach((color) => addIncrement(increments, buckets.colors, color, weight, 0.8));
  [...new Set([...derived.garmentPlacements, ...explicit.garmentPlacements].map(normalizeKey).filter(Boolean))]
    .forEach((placement) => addIncrement(increments, buckets.garmentPlacements, placement, weight, 0.65));
  [...new Set([...derived.occasions, ...explicit.occasions].map(normalizeKey).filter(Boolean))]
    .forEach((occasion) => addIncrement(increments, buckets.occasions, occasion, weight, 0.85));
  [...new Set([...derived.formalities, ...explicit.formalities].map(normalizeKey).filter(Boolean))]
    .forEach((formality) => addIncrement(increments, buckets.formalities, formality, weight, 0.75));
  [...new Set([...derived.priceBands, ...explicit.priceBands, priceBandForPrice(product?.price)].map(normalizeKey).filter(Boolean))]
    .forEach((priceBand) => addIncrement(increments, buckets.priceBands, priceBand, weight, 0.45));

  return increments;
}

function preferenceBuckets(prefix = '') {
  const title = prefix ? prefix[0].toUpperCase() + prefix.slice(1) : '';
  return {
    categories: `${prefix}${title ? 'Categories' : 'categories'}`,
    brands: `${prefix}${title ? 'Brands' : 'brands'}`,
    genders: `${prefix}${title ? 'Genders' : 'genders'}`,
    tags: `${prefix}${title ? 'Tags' : 'tags'}`,
    colors: `${prefix}${title ? 'Colors' : 'colors'}`,
    garmentPlacements: `${prefix}${title ? 'GarmentPlacements' : 'garmentPlacements'}`,
    occasions: `${prefix}${title ? 'Occasions' : 'occasions'}`,
    formalities: `${prefix}${title ? 'Formalities' : 'formalities'}`,
    priceBands: `${prefix}${title ? 'PriceBands' : 'priceBands'}`
  };
}

function productPreferenceIncrements(product, weight, { prefix = '', includePriceAverage = true } = {}) {
  const increments = {};
  const buckets = preferenceBuckets(prefix);

  addIncrement(increments, buckets.categories, product?.category, weight, 1);
  addIncrement(increments, buckets.brands, product?.brand, weight, 0.75);
  const gender = normalizeGender(product?.gender);
  addIncrement(increments, buckets.genders, gender === 'other' ? product?.gender : gender, weight, 0.8);
  listValues(product?.tags).slice(0, 10).forEach((tag) => addIncrement(increments, buckets.tags, tag, weight, 0.7));
  Object.assign(increments, styleSignalIncrements(product, weight, buckets));
  if (includePriceAverage && Number.isFinite(Number(product?.price))) {
    increments.priceTotal = Number(product.price) * weight;
    increments.priceCount = weight;
  }
  return increments;
}

function queryPreferenceIncrements(query, weight) {
  const increments = {};
  queryTerms(query).forEach((term) => {
    const key = normalizeKey(term);
    if (key) increments[`tags.${key}`] = (increments[`tags.${key}`] || 0) + weight;
  });
  const signals = styleSignalsFromText(query);
  signals.colors.forEach((color) => addIncrement(increments, 'colors', color, weight, 0.8));
  signals.garmentPlacements.forEach((placement) => addIncrement(increments, 'garmentPlacements', placement, weight, 0.65));
  signals.occasions.forEach((occasion) => addIncrement(increments, 'occasions', occasion, weight, 0.85));
  signals.formalities.forEach((formality) => addIncrement(increments, 'formalities', formality, weight, 0.75));
  return increments;
}

async function updatePreference({ userId, type, product, query, metadata }) {
  const weight = eventWeight(type);
  const avoidWeight = AVOID_EVENT_WEIGHTS[type] || 0;
  const preferenceSource = product || metadata?.product || metadata;
  const shouldLearnQuery = shouldLearnFromQueryEvent({ type, query, metadata });
  const increments = {
    ...(weight > 0 && shouldLearnQuery ? queryPreferenceIncrements(query, weight) : {}),
    ...(weight > 0 ? productPreferenceIncrements(preferenceSource, weight) : {}),
    ...(avoidWeight > 0 ? productPreferenceIncrements(preferenceSource, avoidWeight, { prefix: 'avoid', includePriceAverage: false }) : {})
  };
  if (Object.keys(increments).length === 0) return null;

  return UserPreference.findOneAndUpdate(
    { user: userId },
    { $inc: increments, $setOnInsert: { user: userId } },
    { upsert: true, new: true }
  );
}

export {
  productPreferenceIncrements,
  queryPreferenceIncrements,
  updatePreference
};

const RECOMMENDATION_REASON_LABELS = {
  category: 'Similar category',
  brand: 'Brand match',
  style: 'Style match',
  price: 'Similar price range',
  'for-you': 'For you',
  popular: 'Popular pick',
  'new-arrival': 'New arrival'
};

const DEFAULT_REASON_THRESHOLD = 0.75;
const DEFAULT_REASON_LIMIT = 3;

function buildRecommendationReasons(components = {}, { threshold = DEFAULT_REASON_THRESHOLD, limit = DEFAULT_REASON_LIMIT } = {}) {
  const reasonCandidates = [
    ['category', components.category],
    ['brand', components.brand],
    ['style', Number(components.tags || 0) + Number(components.colors || 0) + Number(components.occasion || 0) + Number(components.formality || 0) + Number(components.garmentPlacement || 0)],
    ['price', Number(components.price || 0) + Number(components.priceBand || 0)],
    ['for-you', components.explicitGender],
    ['popular', components.quality],
    ['new-arrival', components.freshness]
  ];
  return reasonCandidates
    .filter(([, value]) => Number(value) >= threshold)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([reason]) => reason);
}

function recommendationReasonLabel(reason) {
  return RECOMMENDATION_REASON_LABELS[reason] || '';
}

export {
  RECOMMENDATION_REASON_LABELS,
  buildRecommendationReasons,
  recommendationReasonLabel
};

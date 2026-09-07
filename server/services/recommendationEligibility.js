import { availableStatusClause, productAvailabilityStatus } from '../utils/productAvailability.js';

function recommendationCatalogFilter(extra = {}) {
  const botAmazonRecord = { badge: 'Amazon', $or: [{ sourceUrl: /amazon\.[a-z.]+\/dp\//i }, { affiliateLink: /amazon\.[a-z.]+\/dp\//i }] };
  const extraAnd = Array.isArray(extra.$and) ? extra.$and : [];
  const filter = { ...extra };
  delete filter.$and;
  return { ...filter, isActive: true, $nor: [botAmazonRecord], $and: [availableStatusClause(), ...extraAnd] };
}

function productRecommendationImageUrl(product = {}) {
  return product.image?.url || product.image?.remoteUrl || product.image?.path || '';
}

function recommendationEligibilityIssues(product = {}) {
  const issues = [];
  if (!String(product.name || '').trim()) issues.push('missing_name');
  if (!String(product.category || '').trim()) issues.push('missing_category');
  if (!Number.isFinite(Number(product.price)) || Number(product.price) < 0) issues.push('invalid_price');
  if (!productRecommendationImageUrl(product)) issues.push('missing_image');
  if (productAvailabilityStatus(product) !== 'available') issues.push('unavailable');
  if (product.isActive === false) issues.push('inactive');
  return issues;
}

function hasRecommendationDisplayBasics(product = {}) {
  return recommendationEligibilityIssues(product).length === 0;
}

function annotateRecommendationCandidateEligibility(candidate = {}) {
  const eligibilityIssues = recommendationEligibilityIssues(candidate.product);
  return {
    ...candidate,
    eligibilityIssues,
    eligibleForRecommendation: eligibilityIssues.length === 0
  };
}

function annotateRecommendationCandidates(candidates = []) {
  return (Array.isArray(candidates) ? candidates : []).map(annotateRecommendationCandidateEligibility);
}

export {
  annotateRecommendationCandidateEligibility,
  annotateRecommendationCandidates,
  hasRecommendationDisplayBasics,
  productRecommendationImageUrl,
  recommendationCatalogFilter,
  recommendationEligibilityIssues
};

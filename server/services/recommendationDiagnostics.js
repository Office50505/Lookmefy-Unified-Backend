const DEFAULT_COMPONENT_KEYS = [
  'category',
  'brand',
  'genderHistory',
  'tags',
  'colors',
  'garmentPlacement',
  'occasion',
  'formality',
  'priceBand',
  'explicitGender',
  'price',
  'quality',
  'freshness',
  'avoid',
  'exposure'
];

function roundMetric(value, digits = 4) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  const factor = 10 ** digits;
  return Math.round(number * factor) / factor;
}

function incrementCounter(counter, key, amount = 1) {
  const normalized = String(key || '').trim();
  if (!normalized) return;
  counter[normalized] = (counter[normalized] || 0) + amount;
}

function sortedCounter(counter) {
  return Object.fromEntries(
    Object.entries(counter)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  );
}

function scoreSummary(items = []) {
  const scores = items
    .map((item) => Number(item?.score))
    .filter((value) => Number.isFinite(value));
  if (!scores.length) return { min: 0, max: 0, average: 0 };
  const total = scores.reduce((sum, value) => sum + value, 0);
  return {
    min: roundMetric(Math.min(...scores)),
    max: roundMetric(Math.max(...scores)),
    average: roundMetric(total / scores.length)
  };
}

function componentSummary(items = [], componentKeys = DEFAULT_COMPONENT_KEYS) {
  const summary = {};
  for (const key of componentKeys) {
    const values = items
      .map((item) => Number(item?.components?.[key]))
      .filter((value) => Number.isFinite(value));
    if (!values.length) continue;
    const total = values.reduce((sum, value) => sum + value, 0);
    summary[key] = {
      average: roundMetric(total / values.length),
      max: roundMetric(Math.max(...values)),
      min: roundMetric(Math.min(...values))
    };
  }
  return summary;
}

function countSignals(items = []) {
  const candidateSources = {};
  const reasons = {};
  const eligibilityIssues = {};
  let eligible = 0;
  let ineligible = 0;

  for (const item of items) {
    for (const source of item?.candidateSources || []) incrementCounter(candidateSources, source);
    for (const reason of item?.reasons || []) incrementCounter(reasons, reason);
    for (const issue of item?.eligibilityIssues || []) incrementCounter(eligibilityIssues, issue);
    if (item?.eligibleForRecommendation === false) ineligible += 1;
    else eligible += 1;
  }

  return {
    candidateSources: sortedCounter(candidateSources),
    reasons: sortedCounter(reasons),
    eligibilityIssues: sortedCounter(eligibilityIssues),
    eligibility: {
      eligible,
      ineligible
    }
  };
}

function summarizeRecommendationDiagnostics(candidates = [], selected = [], options = {}) {
  const candidateSignals = countSignals(candidates);
  const selectedSignals = countSignals(selected);

  const diagnostics = {
    surface: String(options.surface || ''),
    personalized: Boolean(options.personalized),
    signalCount: Number(options.signalCount || 0),
    candidates: {
      total: candidates.length,
      scores: scoreSummary(candidates),
      components: componentSummary(candidates),
      ...candidateSignals
    },
    selected: {
      total: selected.length,
      scores: scoreSummary(selected),
      components: componentSummary(selected),
      ...selectedSignals
    }
  };
  if (options.scoringProfile) diagnostics.scoringProfile = String(options.scoringProfile);
  return diagnostics;
}

export {
  componentSummary,
  scoreSummary,
  summarizeRecommendationDiagnostics
};

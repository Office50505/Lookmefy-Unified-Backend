function temporaryExternalAmazonFilter() {
  return {
    catalogApproved: { $ne: true },
    badge: 'Amazon',
    availabilityStatus: { $ne: 'draft' },
    $or: [{ sourceUrl: /amazon\.[a-z.]+\/dp\//i }, { affiliateLink: /amazon\.[a-z.]+\/dp\//i }]
  };
}

function loadTestProductFilter() {
  return { name: /^Load Test Product(?:\b|$)/i };
}

function publicCatalogExclusions() {
  return [temporaryExternalAmazonFilter(), loadTestProductFilter()];
}

export { loadTestProductFilter, publicCatalogExclusions, temporaryExternalAmazonFilter };

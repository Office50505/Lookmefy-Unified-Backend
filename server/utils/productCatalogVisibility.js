function temporaryExternalAmazonFilter() {
  return {
    catalogApproved: { $ne: true },
    badge: 'Amazon',
    availabilityStatus: { $ne: 'draft' },
    $or: [{ sourceUrl: /amazon\.[a-z.]+\/dp\//i }, { affiliateLink: /amazon\.[a-z.]+\/dp\//i }]
  };
}

export { temporaryExternalAmazonFilter };

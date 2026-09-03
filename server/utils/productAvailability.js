const PRODUCT_AVAILABILITY_STATUSES = ['draft', 'available', 'out_of_stock', 'unavailable', 'archived'];

function normalizeAvailabilityStatus(value, fallback = 'available') {
  const normalized = String(value || '').trim().toLowerCase();
  if (PRODUCT_AVAILABILITY_STATUSES.includes(normalized)) return normalized;
  if (fallback === null) return null;
  return PRODUCT_AVAILABILITY_STATUSES.includes(fallback) ? fallback : 'available';
}

function productAvailabilityStatus(product = {}) {
  const explicit = normalizeAvailabilityStatus(product.availabilityStatus, null);
  if (explicit === 'available' && product.isActive === false) return 'archived';
  if (explicit) return explicit;
  return product.isActive === false ? 'archived' : 'available';
}

function availabilityUpdate(status, { now = new Date(), source = 'manual', notes } = {}) {
  const normalized = normalizeAvailabilityStatus(status, null);
  if (!normalized) throw new Error(`Availability must be one of: ${PRODUCT_AVAILABILITY_STATUSES.join(', ')}`);
  const update = {
    availabilityStatus: normalized,
    availabilityCheckedAt: now,
    availabilitySource: source,
    isActive: normalized === 'available'
  };
  if (notes !== undefined) update.inventoryNotes = String(notes || '').trim();
  return update;
}

function availableStatusClause() {
  return {
    $or: [
      { availabilityStatus: 'available' },
      { availabilityStatus: { $exists: false }, isActive: true }
    ]
  };
}

function adminAvailabilityClause(status) {
  const normalized = normalizeAvailabilityStatus(status, null);
  if (!normalized) return null;
  if (normalized === 'available') return availableStatusClause();
  if (normalized === 'archived') {
    return {
      $or: [
        { availabilityStatus: 'archived' },
        { availabilityStatus: { $exists: false }, isActive: false }
      ]
    };
  }
  return { availabilityStatus: normalized };
}

export {
  PRODUCT_AVAILABILITY_STATUSES,
  adminAvailabilityClause,
  availabilityUpdate,
  availableStatusClause,
  normalizeAvailabilityStatus,
  productAvailabilityStatus
};

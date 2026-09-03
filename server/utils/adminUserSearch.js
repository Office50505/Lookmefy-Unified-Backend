import mongoose from 'mongoose';
import { normalizeIndianMobile } from './phone.js';

const searchableStringFields = [
  'name',
  'email',
  'phone',
  'username',
  'genderPreference',
  'accountStatus',
  'banReason',
  'bannedBy',
  'subscription.planId',
  'subscription.status',
  'subscription.lastOrderId',
  'bodyPhoto.status',
  'bodyPhoto.source',
  'bodyPhoto.storage',
  'bodyPhoto.mimetype'
];

const searchableDateFields = [
  'createdAt',
  'updatedAt',
  'bannedAt',
  'deletedAt',
  'onboardingSeenAt',
  'subscription.currentPeriodStart',
  'subscription.currentPeriodEnd',
  'bodyPhoto.generatedAt'
];

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function validUtcDateRange(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const start = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(start.getTime()) || start.toISOString().slice(0, 10) !== value) return null;
  return { $gte: start, $lt: new Date(start.getTime() + (24 * 60 * 60 * 1000)) };
}

function buildAdminUserSearchFilter(value) {
  const query = String(value || '').trim().slice(0, 160);
  if (!query) return null;

  const textPattern = new RegExp(escapeRegex(query), 'i');
  const alternatives = searchableStringFields.map((field) => ({ [field]: textPattern }));
  const normalizedPhone = normalizeIndianMobile(query);
  if (normalizedPhone && normalizedPhone !== query) {
    alternatives.push({ phone: new RegExp(escapeRegex(normalizedPhone), 'i') });
  }

  if (/^[a-f\d]{24}$/i.test(query) && mongoose.Types.ObjectId.isValid(query)) {
    alternatives.push({ _id: new mongoose.Types.ObjectId(query) });
  }

  if (/^\d+$/.test(query)) {
    const number = Number(query);
    if (Number.isSafeInteger(number)) {
      alternatives.push(
        { tokens: number },
        { 'subscription.tokensPerMonth': number },
        { 'bodyPhoto.size': number }
      );
    }
  }

  const lowerQuery = query.toLowerCase();
  if (lowerQuery === 'true' || lowerQuery === 'false') {
    alternatives.push({ devMode: lowerQuery === 'true' });
  }

  const dateRange = validUtcDateRange(query);
  if (dateRange) {
    searchableDateFields.forEach((field) => alternatives.push({ [field]: dateRange }));
  }

  return { $or: alternatives };
}

function tokenBoundary(value, label) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) throw new Error(`${label} tokens must be a non-negative whole number`);
  const number = Number(raw);
  if (!Number.isSafeInteger(number)) throw new Error(`${label} tokens must be a safe whole number`);
  return number;
}

function buildAdminUserTokenFilter(minValue, maxValue) {
  const minimum = tokenBoundary(minValue, 'Minimum');
  const maximum = tokenBoundary(maxValue, 'Maximum');
  if (minimum === null && maximum === null) return null;
  if (minimum !== null && maximum !== null && minimum > maximum) {
    throw new Error('Minimum tokens cannot be greater than maximum tokens');
  }

  const range = {};
  if (minimum !== null) range.$gte = minimum;
  if (maximum !== null) range.$lte = maximum;
  return { tokens: range };
}

export {
  buildAdminUserSearchFilter,
  buildAdminUserTokenFilter,
  searchableDateFields,
  searchableStringFields
};

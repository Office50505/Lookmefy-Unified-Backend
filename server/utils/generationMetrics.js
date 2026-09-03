import mongoose from 'mongoose';
import GenerationMetric from '../models/GenerationMetric.js';

function generationErrorCategory(value) {
  const message = String(value?.message || value || '').toLowerCase();
  if (/insufficient|not enough tokens/.test(message)) return 'insufficient_tokens';
  if (/profile|body photo|selfie/.test(message)) return 'profile_not_ready';
  if (/content|safety|policy|flagged/.test(message)) return 'content_policy';
  if (/timeout|timed out|still running/.test(message)) return 'timeout';
  if (/storage|save|upload|download/.test(message)) return 'storage';
  if (/invalid|missing|required|not found|unsupported/.test(message)) return 'validation';
  if (/provider|pruna|pixverse|fal|fitroom|prediction|generation/.test(message)) return 'provider';
  return message ? 'unknown' : '';
}

async function recordGenerationMetric(entry = {}) {
  if (!entry.user) return null;
  try {
    return await GenerationMetric.create({
      user: entry.user,
      product: mongoose.Types.ObjectId.isValid(entry.product) ? entry.product : undefined,
      type: entry.type,
      status: entry.status,
      provider: String(entry.provider || 'unknown').slice(0, 80),
      model: String(entry.model || 'unknown').slice(0, 160),
      durationMs: Math.max(0, Math.round(Number(entry.durationMs) || 0)),
      tokensCharged: Math.max(0, Number(entry.tokensCharged) || 0),
      tokensRefunded: Math.max(0, Number(entry.tokensRefunded) || 0),
      providerCostUsd: Math.max(0, Number(entry.providerCostUsd) || 0),
      errorCategory: entry.errorCategory || generationErrorCategory(entry.error)
    });
  } catch (error) {
    console.warn('[generation-metrics] could not record outcome', error?.message || error);
    return null;
  }
}

export { generationErrorCategory, recordGenerationMetric };

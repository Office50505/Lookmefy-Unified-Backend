import { MockOtpProvider, Msg91OtpProvider, WebhookOtpProvider, otpDeliveryFailure } from './otpProviders.js';
import { fixedOtpCode } from './otp.js';
import { isProductionEnv } from './urlValidation.js';
import OtpDeliveryMetric from '../models/OtpDeliveryMetric.js';

function recordOtpDeliveryMetric(entry) {
  if (OtpDeliveryMetric.db?.readyState !== 1) return Promise.resolve(null);
  return OtpDeliveryMetric.create(entry).catch(() => null);
}

function otpDeliveryProvider(env = process.env) {
  const provider = String(env.OTP_DELIVERY_PROVIDER || '').trim().toLowerCase();
  if (provider) return provider;
  return isProductionEnv(env) ? '' : 'mock';
}

function createOtpProvider(env = process.env) {
  const provider = otpDeliveryProvider(env);
  if (!provider || provider === 'disabled') {
    throw otpDeliveryFailure('OTP delivery is not configured');
  }
  if (provider === 'mock') return new MockOtpProvider(env);
  if (provider === 'msg91') return new Msg91OtpProvider(env);
  if (provider === 'webhook') return new WebhookOtpProvider(env);
  throw otpDeliveryFailure(`Unsupported OTP delivery provider: ${provider}`);
}

async function deliverOtp(message, env = process.env) {
  const startedAt = Date.now();
  const hasFixedOtp = Boolean(fixedOtpCode(env));
  const provider = hasFixedOtp ? 'fixed' : otpDeliveryProvider(env) || 'disabled';
  const estimatedCostUsd = Math.max(0, Number(env.OTP_COST_PER_MESSAGE_USD) || 0);
  try {
    const result = hasFixedOtp ? { fixedOtp: true } : await createOtpProvider(env).deliver(message);
    await recordOtpDeliveryMetric({
      provider,
      purpose: ['signup', 'login'].includes(message?.purpose) ? message.purpose : 'other',
      status: 'succeeded',
      durationMs: Date.now() - startedAt,
      estimatedCostUsd
    });
    return result;
  } catch (error) {
    await recordOtpDeliveryMetric({
      provider,
      purpose: ['signup', 'login'].includes(message?.purpose) ? message.purpose : 'other',
      status: 'failed',
      durationMs: Date.now() - startedAt,
      estimatedCostUsd: 0,
      errorCategory: error?.name === 'AbortError' || /timed out/i.test(error?.message || '') ? 'timeout' : 'provider'
    });
    throw error;
  }
}
export { createOtpProvider, deliverOtp, otpDeliveryProvider };

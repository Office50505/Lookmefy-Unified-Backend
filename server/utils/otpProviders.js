import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateConfiguredHttpsUrl } from './urlValidation.js';

function otpDeliveryFailure(message = 'OTP delivery is not configured') {
  const error = new Error(message);
  error.statusCode = 503;
  return error;
}

function nonRetryableOtpDeliveryFailure(message) {
  const error = otpDeliveryFailure(message);
  error.nonRetryable = true;
  return error;
}

function otpProviderPayload({ phone, otp, purpose, expiresAt }) {
  return {
    destinationPhone: phone,
    code: otp,
    purpose,
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined
  };
}

function retryAttempts(env = process.env) {
  const value = Number(env.OTP_DELIVERY_RETRY_ATTEMPTS || 1);
  return Number.isFinite(value) && value > 0 ? Math.min(Math.ceil(value), 3) : 1;
}

function retryDelayMs(env = process.env) {
  const value = Number(env.OTP_DELIVERY_RETRY_DELAY_MS || 250);
  return Number.isFinite(value) && value >= 0 ? Math.min(Math.ceil(value), 2000) : 250;
}

function timeoutMs(env = process.env) {
  const value = Number(env.OTP_DELIVERY_TIMEOUT_MS || 5000);
  return Number.isFinite(value) ? Math.max(1000, Math.min(Math.ceil(value), 30000)) : 5000;
}

function mockOtpStorePath(env = process.env) {
  return String(env.OTP_MOCK_STORE_PATH || '').trim() || path.join(os.tmpdir(), 'fitlook-local-otp.jsonl');
}

function wait(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function isRetryableStatus(status) {
  return Number(status) === 429 || Number(status) >= 500;
}

class MockOtpProvider {
  constructor(env = process.env) {
    this.env = env;
  }

  async deliver(message) {
    if (String(this.env.NODE_ENV || '').toLowerCase() === 'production') {
      throw otpDeliveryFailure('Mock OTP delivery is not allowed in production');
    }
    const storePath = mockOtpStorePath(this.env);
    if (!storePath) throw otpDeliveryFailure('Mock OTP delivery store is not configured');
    await fs.appendFile(storePath, `${JSON.stringify({
      phone: message.phone,
      otp: message.otp,
      purpose: message.purpose,
      otpSession: message.otpSession,
      expiresAt: message.expiresAt ? new Date(message.expiresAt).toISOString() : undefined,
      createdAt: new Date().toISOString()
    })}\n`, 'utf8');
  }
}

class WebhookOtpProvider {
  constructor(env = process.env) {
    this.env = env;
  }

  async deliver(message) {
    const url = validateConfiguredHttpsUrl(this.env.OTP_DELIVERY_WEBHOOK_URL, {
      name: 'OTP_DELIVERY_WEBHOOK_URL',
      env: this.env
    }).toString();
    const headers = { 'Content-Type': 'application/json' };
    const bearer = String(this.env.OTP_DELIVERY_WEBHOOK_TOKEN || '').trim();
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    if (message.otpSession) headers['Idempotency-Key'] = String(message.otpSession);

    const attempts = retryAttempts(this.env);
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs(this.env));
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers,
          signal: controller.signal,
          body: JSON.stringify(otpProviderPayload(message))
        });
        if (!response || typeof response.ok !== 'boolean' || !Number.isFinite(Number(response.status))) {
          throw otpDeliveryFailure('OTP delivery provider returned an invalid response');
        }
        if (response.ok) return;
        if (!isRetryableStatus(response.status)) throw nonRetryableOtpDeliveryFailure('OTP delivery provider rejected the request');
        if (attempt >= attempts) throw otpDeliveryFailure('OTP delivery provider rejected the request');
        lastError = otpDeliveryFailure('OTP delivery provider rejected the request');
      } catch (error) {
        if (error?.nonRetryable) throw error;
        if (error?.statusCode === 503 && /invalid response/i.test(error.message)) throw error;
        if (error?.statusCode === 503 && !/rejected/i.test(error.message)) throw error;
        if (error?.name === 'AbortError') lastError = otpDeliveryFailure('OTP delivery timed out. Please try again.');
        else lastError = error?.statusCode === 503 ? error : otpDeliveryFailure('OTP delivery failed. Please try again.');
        if (attempt >= attempts) throw lastError;
      } finally {
        clearTimeout(timeout);
      }
      await wait(retryDelayMs(this.env));
    }
    throw lastError || otpDeliveryFailure('OTP delivery failed. Please try again.');
  }
}

function msg91Mobile(phone) {
  const mobile = String(phone || '').replace(/\D/g, '');
  if (!/^\d{10,15}$/.test(mobile)) throw nonRetryableOtpDeliveryFailure('OTP destination phone is invalid');
  return mobile;
}

class Msg91OtpProvider {
  constructor(env = process.env) {
    this.env = env;
  }

  async deliver(message) {
    const authKey = String(this.env.MSG91_AUTH_KEY || '').trim();
    const templateId = String(this.env.MSG91_TEMPLATE_ID || '').trim();
    if (!authKey || !templateId) throw otpDeliveryFailure('MSG91 OTP delivery is not configured');

    const otp = String(message?.otp || '').trim();
    if (!/^\d{6}$/.test(otp)) throw nonRetryableOtpDeliveryFailure('OTP code is invalid');

    const url = validateConfiguredHttpsUrl(
      String(this.env.MSG91_BASE_URL || '').trim() || 'https://control.msg91.com/api/v5',
      { name: 'MSG91_BASE_URL', env: this.env }
    );
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/otp`;
    url.search = '';
    url.hash = '';
    url.searchParams.set('template_id', templateId);
    url.searchParams.set('mobile', msg91Mobile(message?.phone));
    url.searchParams.set('authkey', authKey);
    url.searchParams.set('otp', otp);

    const attempts = retryAttempts(this.env);
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs(this.env));
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: '{}'
        });
        if (!response || typeof response.ok !== 'boolean' || !Number.isFinite(Number(response.status))) {
          throw nonRetryableOtpDeliveryFailure('MSG91 returned an invalid response');
        }
        if (!response.ok) {
          if (!isRetryableStatus(response.status)) throw nonRetryableOtpDeliveryFailure('MSG91 rejected the OTP request');
          throw otpDeliveryFailure('MSG91 temporarily rejected the OTP request');
        }

        let result;
        try {
          result = await response.json();
        } catch {
          throw nonRetryableOtpDeliveryFailure('MSG91 returned an invalid response');
        }
        if (String(result?.type || '').trim().toLowerCase() !== 'success') {
          throw nonRetryableOtpDeliveryFailure('MSG91 rejected the OTP request');
        }
        return { requestId: String(result?.request_id || '').trim() || undefined };
      } catch (error) {
        if (error?.nonRetryable) throw error;
        if (error?.name === 'AbortError') lastError = otpDeliveryFailure('OTP delivery timed out. Please try again.');
        else lastError = error?.statusCode === 503 ? error : otpDeliveryFailure('OTP delivery failed. Please try again.');
        if (attempt >= attempts) throw lastError;
      } finally {
        clearTimeout(timeout);
      }
      await wait(retryDelayMs(this.env));
    }
    throw lastError || otpDeliveryFailure('OTP delivery failed. Please try again.');
  }
}

export { MockOtpProvider, Msg91OtpProvider, WebhookOtpProvider, mockOtpStorePath, otpDeliveryFailure, otpProviderPayload, retryAttempts, timeoutMs };

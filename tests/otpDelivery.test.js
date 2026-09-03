import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { deliverOtp } from '../server/utils/otpDelivery.js';

test('OTP delivery fails closed in production when no provider is configured', async () => {
  await assert.rejects(
    deliverOtp({ phone: '+919876543210', otp: '123456', purpose: 'signup' }, { NODE_ENV: 'production' }),
    /OTP delivery is not configured/
  );
});

test('OTP delivery skips external provider for explicitly enabled production fixed OTP', async () => {
  const result = await deliverOtp(
    { phone: '+919876543210', otp: '123456', purpose: 'login' },
    {
      NODE_ENV: 'production',
      OTP_DELIVERY_PROVIDER: 'disabled',
      OTP_FIXED_CODE: '123456',
      ALLOW_FIXED_OTP_IN_PRODUCTION: 'true'
    }
  );

  assert.deepEqual(result, { fixedOtp: true });
});

test('OTP delivery defaults to local mock outside production when provider is unset', async () => {
  const storePath = `/private/tmp/fitlook-otp-default-${Date.now()}-${Math.random()}.jsonl`;
  await deliverOtp(
    { phone: '+919876543210', otp: '123456', purpose: 'signup', otpSession: 'local-session' },
    { NODE_ENV: 'development', OTP_MOCK_STORE_PATH: storePath }
  );
  const stored = (await fs.readFile(storePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(stored[0].otp, '123456');
  assert.equal(stored[0].otpSession, 'local-session');
  await fs.unlink(storePath).catch(() => {});
});

test('OTP delivery posts the code to the configured webhook provider', async () => {
  const originalFetch = globalThis.fetch;
  let received = null;
  globalThis.fetch = async (url, options) => {
    received = { url, options };
    return { ok: true, status: 204 };
  };

  try {
    await deliverOtp(
      { phone: '+919876543210', otp: '123456', purpose: 'login' },
      {
        OTP_DELIVERY_PROVIDER: 'webhook',
        OTP_DELIVERY_WEBHOOK_URL: 'https://otp-provider.example/send',
        OTP_DELIVERY_WEBHOOK_TOKEN: 'secret-token'
      }
    );

    assert.equal(received.url, 'https://otp-provider.example/send');
    assert.equal(received.options.method, 'POST');
    assert.equal(received.options.headers.Authorization, 'Bearer secret-token');
    assert.deepEqual(JSON.parse(received.options.body), {
      destinationPhone: '+919876543210',
      code: '123456',
      purpose: 'login'
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('MSG91 delivery sends the Fitlook OTP through the configured V5 template', async () => {
  const originalFetch = globalThis.fetch;
  let received = null;
  globalThis.fetch = async (url, options) => {
    received = { url: new URL(url), options };
    return {
      ok: true,
      status: 200,
      json: async () => ({ type: 'success', request_id: 'msg91-request-1' })
    };
  };

  try {
    const result = await deliverOtp(
      { phone: '+919876543210', otp: '123456', purpose: 'login' },
      {
        OTP_DELIVERY_PROVIDER: 'msg91',
        MSG91_AUTH_KEY: 'server-only-key',
        MSG91_TEMPLATE_ID: 'template-1',
        MSG91_BASE_URL: 'https://control.msg91.com/api/v5'
      }
    );

    assert.equal(received.url.origin, 'https://control.msg91.com');
    assert.equal(received.url.pathname, '/api/v5/otp');
    assert.equal(received.url.searchParams.get('template_id'), 'template-1');
    assert.equal(received.url.searchParams.get('mobile'), '919876543210');
    assert.equal(received.url.searchParams.get('authkey'), 'server-only-key');
    assert.equal(received.url.searchParams.get('otp'), '123456');
    assert.equal(received.options.method, 'POST');
    assert.equal(received.options.body, '{}');
    assert.deepEqual(result, { requestId: 'msg91-request-1' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('MSG91 delivery rejects HTTP 200 business failures', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ type: 'error', message: 'provider detail must stay private' })
    };
  };

  try {
    await assert.rejects(
      deliverOtp(
        { phone: '+919876543210', otp: '123456', purpose: 'signup' },
        {
          OTP_DELIVERY_PROVIDER: 'msg91',
          MSG91_AUTH_KEY: 'server-only-key',
          MSG91_TEMPLATE_ID: 'template-1',
          OTP_DELIVERY_RETRY_ATTEMPTS: '3'
        }
      ),
      (error) => error.statusCode === 503
        && /MSG91 rejected the OTP request/.test(error.message)
        && !/provider detail/.test(error.message)
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OTP webhook delivery times out safely', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
  });

  try {
    await assert.rejects(
      deliverOtp(
        { phone: '+919876543210', otp: '123456', purpose: 'signup' },
        {
          OTP_DELIVERY_PROVIDER: 'webhook',
          OTP_DELIVERY_WEBHOOK_URL: 'https://otp-provider.example/send',
          OTP_DELIVERY_TIMEOUT_MS: '1000'
        }
      ),
      /timed out/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OTP webhook delivery rejects provider 4xx and 5xx responses safely', async () => {
  const originalFetch = globalThis.fetch;

  try {
    for (const status of [400, 401, 403, 429, 500]) {
      globalThis.fetch = async () => ({ ok: false, status });
      await assert.rejects(
        deliverOtp(
          { phone: '+919876543210', otp: '123456', purpose: 'signup' },
          {
            OTP_DELIVERY_PROVIDER: 'webhook',
            OTP_DELIVERY_WEBHOOK_URL: 'https://otp-provider.example/send'
          }
        ),
        /rejected/
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OTP webhook retries transient responses only when configured', async () => {
  const originalFetch = globalThis.fetch;
  const statuses = [500, 204];
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    const status = statuses.shift();
    return { ok: status < 400, status };
  };

  try {
    await deliverOtp(
      { phone: '+919876543210', otp: '123456', purpose: 'signup', otpSession: 'otp-session-1', expiresAt: Date.now() + 300000 },
      {
        OTP_DELIVERY_PROVIDER: 'webhook',
        OTP_DELIVERY_WEBHOOK_URL: 'https://otp-provider.example/send',
        OTP_DELIVERY_RETRY_ATTEMPTS: '2',
        OTP_DELIVERY_RETRY_DELAY_MS: '0'
      }
    );
    assert.equal(calls.length, 2);
    assert.equal(calls[0].destinationPhone, '+919876543210');
    assert.equal(calls[0].code, '123456');
    assert.equal(typeof calls[0].expiresAt, 'string');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OTP webhook does not retry non-retryable authorization failures', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: false, status: 401 };
  };

  try {
    await assert.rejects(
      deliverOtp(
        { phone: '+919876543210', otp: '123456', purpose: 'signup' },
        {
          OTP_DELIVERY_PROVIDER: 'webhook',
          OTP_DELIVERY_WEBHOOK_URL: 'https://otp-provider.example/send',
          OTP_DELIVERY_RETRY_ATTEMPTS: '3'
        }
      ),
      /rejected/
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OTP webhook rejects unsafe production URLs', async () => {
  await assert.rejects(
    deliverOtp(
      { phone: '+919876543210', otp: '123456', purpose: 'signup' },
      {
        NODE_ENV: 'production',
        OTP_DELIVERY_PROVIDER: 'webhook',
        OTP_DELIVERY_WEBHOOK_URL: 'http://localhost:3000/otp'
      }
    ),
    /HTTPS|localhost/
  );
});

test('OTP webhook delivery rejects malformed provider responses safely', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true });

  try {
    await assert.rejects(
      deliverOtp(
        { phone: '+919876543210', otp: '123456', purpose: 'signup' },
        {
          OTP_DELIVERY_PROVIDER: 'webhook',
          OTP_DELIVERY_WEBHOOK_URL: 'https://otp-provider.example/send'
        }
      ),
      /invalid response/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('mock OTP delivery writes only to server-local test storage and is blocked in production', async () => {
  const storePath = `/private/tmp/fitlook-otp-${Date.now()}-${Math.random()}.jsonl`;
  await deliverOtp(
    { phone: '+919876543210', otp: '123456', purpose: 'login' },
    {
      NODE_ENV: 'test',
      OTP_DELIVERY_PROVIDER: 'mock',
      OTP_MOCK_STORE_PATH: storePath
    }
  );

  const stored = (await fs.readFile(storePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(stored.length, 1);
  assert.deepEqual({
    phone: stored[0].phone,
    otp: stored[0].otp,
    purpose: stored[0].purpose
  }, {
    phone: '+919876543210',
    otp: '123456',
    purpose: 'login'
  });

  await assert.rejects(
    deliverOtp(
      { phone: '+919876543210', otp: '654321', purpose: 'signup' },
      {
        NODE_ENV: 'production',
        OTP_DELIVERY_PROVIDER: 'mock',
        OTP_MOCK_STORE_PATH: storePath
      }
    ),
    /not allowed in production/
  );

  await fs.unlink(storePath).catch(() => {});
});

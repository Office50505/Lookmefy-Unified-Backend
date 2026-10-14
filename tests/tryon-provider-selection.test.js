import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureRealImageProviderConfigured,
  hasConfiguredImageProviderKey,
  useFitRoomProvider,
  usePrunaProvider
} from '../server/routes/tryons.js';

function withProviderEnv(values, fn) {
  const keys = ['AI_PROVIDER', 'PRUNA_API_KEY', 'FAL_KEY', 'FITROOM_API_KEY'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, values);
    fn();
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test('Pruna routing requires a Pruna key', () => {
  withProviderEnv({ AI_PROVIDER: 'pruna', FITROOM_API_KEY: 'fitroom-key' }, () => {
    assert.equal(usePrunaProvider(), false);
    assert.equal(useFitRoomProvider(), true);
    assert.equal(hasConfiguredImageProviderKey(), true);
  });
});

test('explicit FitRoom routing is selected when configured', () => {
  withProviderEnv({ AI_PROVIDER: 'fitroom', FITROOM_API_KEY: 'fitroom-key' }, () => {
    assert.equal(usePrunaProvider(), false);
    assert.equal(useFitRoomProvider(), true);
    assert.equal(hasConfiguredImageProviderKey(), true);
  });
});

test('missing image provider key fails with a clear real try-on configuration error', () => {
  withProviderEnv({}, () => {
    assert.equal(usePrunaProvider(), false);
    assert.equal(useFitRoomProvider(), false);
    assert.equal(hasConfiguredImageProviderKey(), false);
    assert.throws(
      () => ensureRealImageProviderConfigured(),
      /Real AI try-on provider is not configured/
    );
  });
});

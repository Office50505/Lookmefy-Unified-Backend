import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const UNIFIED_API_URL = 'https://api.lookmefy.in/api';

async function readOptionalFixture(relativePath) {
  try {
    return await readFile(new URL(relativePath, import.meta.url), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function skipWhenMobileWorkspaceIsAbsent(t, fixtures) {
  if (fixtures.some((content) => content === null)) {
    t.skip('fit-look-APP is not present in this checkout');
    return true;
  }
  return false;
}

test('mobile production builds point at the unified backend API', async (t) => {
  const [mobileApi, mobileEnv, mobileEas] = await Promise.all([
    readOptionalFixture('../fit-look-APP/mobile/src/api.js'),
    readOptionalFixture('../fit-look-APP/mobile/.env.example'),
    readOptionalFixture('../fit-look-APP/mobile/eas.json')
  ]);

  if (skipWhenMobileWorkspaceIsAbsent(t, [mobileApi, mobileEnv, mobileEas])) {
    return;
  }

  assert.match(mobileApi, new RegExp(`defaultProductionApi = '${UNIFIED_API_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
  assert.match(mobileEnv, new RegExp(`^EXPO_PUBLIC_API_URL=${UNIFIED_API_URL}$`, 'm'));
  const eas = JSON.parse(mobileEas);
  assert.equal(eas.build.production.env.EXPO_PUBLIC_API_URL, UNIFIED_API_URL);
  assert.equal(eas.build['production-apk'].env.EXPO_PUBLIC_API_URL, UNIFIED_API_URL);
});

test('mobile token checkout uses provider-neutral Razorpay flow instead of PhonePe routes', async (t) => {
  const mobileApp = await readOptionalFixture('../fit-look-APP/mobile/App.js');

  if (skipWhenMobileWorkspaceIsAbsent(t, [mobileApp])) {
    return;
  }

  assert.match(mobileApp, /api\('\/payments\/checkout'/);
  assert.match(mobileApp, /\/payments\/razorpay\/verify/);
  assert.doesNotMatch(mobileApp, /\/payments\/phonepe\/(?:top-up|subscription)/i);
});

test('root repository ignores the nested app/backend workspace during unified backend pushes', async () => {
  const gitignore = await readFile(new URL('../.gitignore', import.meta.url), 'utf8');
  assert.match(gitignore, /^fit-look-APP\/$/m);
});

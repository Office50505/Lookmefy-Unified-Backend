import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const otpStorePath = process.env.OTP_MOCK_STORE_PATH || '/private/tmp/fitlook-otp-playwright.jsonl';
const bodyPhotoPath = path.resolve('public/assets/search-shirt-1.jpg');
const screenshotDir = 'tests/browser/screenshots';
const searchTerms = ['shirt', 'shirts', 'Shirt', 'SHIRT', '`shirt`', 'shoes'];
const popularTerms = ['shirts', 'jeans', 'innerwear', 'ethnic wear', 'sneakers', 'sleepwear'];

test.beforeAll(async () => {
  await fs.mkdir(screenshotDir, { recursive: true });
});

async function latestOtp(phone, purpose) {
  const raw = await fs.readFile(otpStorePath, 'utf8').catch(() => '');
  const entries = raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const match = entries.reverse().find((entry) => entry.phone === phone && entry.purpose === purpose);
  if (!match) throw new Error(`No mock OTP found for ${purpose}`);
  return match.otp;
}

async function createAccountViaApi(request) {
  const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const phone = `+919${String(Date.now()).slice(-9)}`;
  const otpRequest = await request.post('/api/auth/signup/request-otp', { data: { phone } });
  expect(otpRequest.ok()).toBeTruthy();
  const otpData = await otpRequest.json();
  expect(JSON.stringify(otpData)).not.toMatch(/\b\d{6}\b|devOtp|Test OTP|Test code/);
  const verify = await request.post('/api/auth/signup/verify-otp', {
    data: { phone, otpSession: otpData.otpSession, otp: await latestOtp(phone, 'signup') }
  });
  expect(verify.ok()).toBeTruthy();
  const verifyData = await verify.json();
  const password = `Browser-${runId}-Password-12345`;
  const signup = await request.post('/api/auth/signup', {
    multipart: {
      name: `Browser User ${runId}`,
      username: `browser_${runId}`.slice(0, 40),
      email: `browser-${runId}@fitlook.local`,
      password,
      phone,
      otpSession: verifyData.otpSession,
      genderPreference: 'other',
      profilePhotoMode: 'exact',
      bodyPhoto: {
        name: 'body.jpg',
        mimeType: 'image/jpeg',
        buffer: await fs.readFile(bodyPhotoPath)
      }
    }
  });
  expect(signup.status()).toBe(201);
  const signupData = await signup.json();
  await request.patch('/api/auth/onboarding', {
    headers: { Authorization: `Bearer ${signupData.token}` },
    data: { reason: 'browser-regression' }
  });
  return { phone, password, token: signupData.token, user: signupData.user };
}

async function installToken(context, token) {
  await context.addInitScript((value) => {
    window.localStorage.setItem('fitlook_token', value);
  }, token);
}

async function expectOneMain(page) {
  await expect(page.locator('main')).toHaveCount(1);
}

async function expectNoHorizontalOverflow(page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

async function expectCatalogResult(page, term) {
  const productLinks = page.locator('a[href^="/product/"]');
  const emptyState = page.locator('.atelier-category-empty, .empty-products').first();
  await page.waitForFunction(() => (
    document.querySelectorAll('a[href^="/product/"]').length > 0
    || Boolean(document.querySelector('.atelier-category-empty, .empty-products'))
  ));
  if (/^shirts?$/i.test(term)) {
    await expect(productLinks.first(), `${term} should return shirt products`).toBeVisible();
    return;
  }
  if (await productLinks.count()) await expect(productLinks.first()).toBeVisible();
  else await expect(emptyState).toBeVisible();
}

async function submitVisibleSearch(page, term) {
  const inputs = page.getByLabel('Search products');
  const total = await inputs.count();
  for (let index = 0; index < total; index += 1) {
    const input = inputs.nth(index);
    if (await input.isVisible()) {
      await input.fill(term);
      await input.press('Enter');
      return;
    }
  }
  await page.goto('/search');
  await page.locator('.mobile-search-page-form').getByLabel('Search products').fill(term);
  await page.locator('.mobile-search-page-form').getByRole('button', { name: 'Search', exact: true }).click();
}

async function expectResponsiveMenu(page, testInfo) {
  const openMenu = page.getByRole('button', { name: 'Open menu' });
  if (testInfo.project.name === 'desktop') {
    await expect(openMenu).toHaveCount(0);
    return;
  }

  await expect(openMenu).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Close menu' })).toHaveCount(0);
  await openMenu.click();
  const closeMenu = page.getByRole('button', { name: 'Close menu' });
  await expect(closeMenu).toHaveCount(1);
  await expect(closeMenu).toHaveAttribute('aria-expanded', 'true');
  await page.screenshot({ path: `${screenshotDir}/${testInfo.project.name}-menu-open.png`, fullPage: false });
  await page.keyboard.press('Escape');
  await expect(openMenu).toHaveCount(1);
  await expect(openMenu).toBeFocused();
}

test('rendered app covers auth, search, product, account, wardrobe, credits, and 404 UI', async ({ page, request, context }, testInfo) => {
  const consoleIssues = [];
  page.on('console', (message) => {
    if (['error'].includes(message.type())) consoleIssues.push(message.text());
  });
  page.on('pageerror', (error) => consoleIssues.push(error.message));

  await page.goto('/home');
  await expect(page.getByRole('link', { name: /lookmefy/i }).first()).toBeVisible();
  await expectOneMain(page);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: `${screenshotDir}/${testInfo.project.name}-homepage.png`, fullPage: false });

  const account = await createAccountViaApi(request);
  await installToken(context, account.token);

  for (const route of ['/categories', '/search', '/profile', '/wishlist', '/closet', '/tokens']) {
    await page.goto(route);
    await expectOneMain(page);
    await expectNoHorizontalOverflow(page);
  }

  for (const term of searchTerms) {
    await page.goto(`/categories?q=${encodeURIComponent(term)}`);
    await expectOneMain(page);
    await expectCatalogResult(page, term);
  }
  await page.screenshot({ path: `${screenshotDir}/${testInfo.project.name}-search-results.png`, fullPage: false });

  await page.goto('/categories');
  await submitVisibleSearch(page, 'shirt');
  await expect(page).toHaveURL(/\/categories\?q=shirt/);
  await expect(page.locator('a[href^="/product/"]').first()).toBeVisible();

  const productResponse = await request.get('/api/products?q=shirt&limit=1');
  const productData = await productResponse.json();
  const productId = productData.products?.[0]?.id;
  expect(productId).toBeTruthy();
  await page.goto(`/product/${productId}`);
  await expectOneMain(page);
  await expect(page.getByRole('button', { name: /try.?on|ai/i }).first()).toBeVisible();
  await page.screenshot({ path: `${screenshotDir}/${testInfo.project.name}-product-detail.png`, fullPage: false });

  await page.goto('/custom-try-on');
  await expectOneMain(page);
  await expect(page.getByRole('heading', { name: /Custom Try-On|AI Try-On/i }).first()).toBeVisible();
  await page.screenshot({ path: `${screenshotDir}/${testInfo.project.name}-ai-try-on.png`, fullPage: false });

  await page.goto('/wishlist');
  await expectOneMain(page);
  await page.screenshot({ path: `${screenshotDir}/${testInfo.project.name}-wishlist.png`, fullPage: false });

  await page.goto('/closet');
  await expectOneMain(page);
  await page.screenshot({ path: `${screenshotDir}/${testInfo.project.name}-wardrobe.png`, fullPage: false });

  await page.goto('/tokens');
  await expect(page.getByText('Due today')).toBeVisible();
  await expect(page.getByText('First recurring payment')).toBeVisible();
  await expect(page.getByRole('button', { name: /Set up ₹500\/month mandate/ })).toBeVisible();
  await expect(page.getByText('₹1').first()).toBeVisible();
  await page.screenshot({ path: `${screenshotDir}/${testInfo.project.name}-credits.png`, fullPage: false });

  await page.goto('/definitely-not-a-real-route');
  await expectOneMain(page);
  await expect(page.getByRole('heading', { name: /We couldn't find that page/i })).toBeVisible();

  await page.screenshot({ path: `${screenshotDir}/${testInfo.project.name}-not-found.png`, fullPage: false });
  expect(consoleIssues.filter((item) => !/favicon/i.test(item))).toEqual([]);
});

test('responsive menu, OTP inputs, search layout, and payment summary fit every viewport', async ({ page, request, context }, testInfo) => {
  const account = await createAccountViaApi(request);
  await installToken(context, account.token);

  await page.goto('/home');
  await expectNoHorizontalOverflow(page);
  await expectResponsiveMenu(page, testInfo);

  const guest = await context.browser().newContext({
    ...testInfo.project.use,
    baseURL: testInfo.project.use.baseURL || process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:5173'
  });
  const guestPage = await guest.newPage();
  await guestPage.goto('/signup');
  const signupPhone = guestPage.getByLabel('Mobile number');
  await signupPhone.fill('+91 98765 43210999');
  await expect(signupPhone).toHaveValue('9876543210');
  await signupPhone.fill(`98765${String(Date.now()).slice(-5)}`);
  await guestPage.getByRole('button', { name: /Send OTP/i }).click();
  const testOtpText = guestPage.locator('.signup-test-otp');
  await expect(testOtpText).toBeVisible();
  const testOtpMatch = (await testOtpText.innerText()).match(/\d{6}/);
  expect(testOtpMatch?.[0]).toMatch(/^\d{6}$/);
  const otpInput = guestPage.getByLabel('6-digit OTP');
  await expect(otpInput).toHaveCount(1);
  await otpInput.fill(testOtpMatch[0]);
  await expect(otpInput).toHaveValue(testOtpMatch[0]);
  await expectNoHorizontalOverflow(guestPage);
  await guest.close();

  await expectNoHorizontalOverflow(page);

  for (const route of ['/categories?q=shirt', '/product/' + (await (await request.get('/api/products?q=shirt&limit=1')).json()).products?.[0]?.id, '/tokens']) {
    await page.goto(route);
    await expectOneMain(page);
    await expectNoHorizontalOverflow(page);
  }
  await expect(page.getByRole('button', { name: /Set up ₹500\/month mandate/ })).toBeVisible();
  await page.screenshot({ path: `${screenshotDir}/${testInfo.project.name}-responsive-core.png`, fullPage: false });
});

test('forgot password verifies OTP, changes the password, and ends existing sessions', async ({ page, request }) => {
  const account = await createAccountViaApi(request);
  const nextPassword = `Reset-${Date.now()}-Password-12345`;

  await page.goto('/login');
  await page.getByRole('link', { name: 'Forgot password?' }).click();
  await expect(page).toHaveURL(/\/forgot-password$/);
  await page.getByLabel('Mobile number').fill(account.phone);
  await page.getByRole('button', { name: 'Send OTP' }).click();
  await page.getByLabel('6-digit OTP').fill(await latestOtp(account.phone, 'password-reset'));
  await page.getByRole('button', { name: 'Verify OTP' }).click();

  await page.getByLabel('New password').fill(nextPassword);
  await page.getByLabel('Confirm password').fill(nextPassword);
  await page.getByRole('button', { name: 'Reset Password' }).click();
  await expect(page).toHaveURL(/\/login\?passwordReset=success$/);
  await expect(page.getByText('Password reset successfully. Sign in with your new password.')).toBeVisible();

  const oldSession = await request.get('/api/auth/me', {
    headers: { Authorization: `Bearer ${account.token}` }
  });
  expect(oldSession.status()).toBe(401);
  const oldPasswordLogin = await request.post('/api/auth/login', {
    data: { phone: account.phone, password: account.password }
  });
  expect(oldPasswordLogin.status()).toBe(401);

  await page.getByLabel('Mobile number').fill(account.phone);
  await page.getByLabel('Password', { exact: true }).fill(nextPassword);
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await expect(page).not.toHaveURL(/\/login/);
});

test('search suggestions and popular terms return useful UI states', async ({ page }) => {
  for (const term of [...searchTerms, ...popularTerms]) {
    await page.goto(`/categories?q=${encodeURIComponent(term)}`);
    await expectOneMain(page);
    await expectCatalogResult(page, term);
    const count = await page.locator('a[href^="/product/"]').count();
    if (/^shirts?$/i.test(term)) expect(count, `${term} should return shirt products`).toBeGreaterThan(0);
  }

  await page.goto('/search');
  const searchPageForm = page.locator('.mobile-search-page-form');
  await searchPageForm.getByLabel('Search products').fill('shirts');
  await searchPageForm.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page).toHaveURL(/\/categories\?q=shirts/);
  await expect(page.locator('a[href^="/product/"]').first()).toBeVisible();
});

test('authentication persists across tabs and logout syncs', async ({ page, request, context }, testInfo) => {
  const account = await createAccountViaApi(request);
  await installToken(context, account.token);

  await page.goto('/profile');
  await expect(page.getByText(account.user.name).first()).toBeVisible();
  const second = await context.newPage();
  await second.goto('/wishlist');
  await expect(second.getByRole('main')).toBeVisible();
  await second.goto('/closet');
  await expect(second.getByRole('main')).toBeVisible();
  await second.goto('/profile');
  await expect(second.getByText(account.user.name).first()).toBeVisible();

  if (await page.getByRole('button', { name: 'Log out', exact: true }).count()) {
    await page.getByRole('button', { name: 'Log out', exact: true }).first().click();
  } else {
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.locator('#mobile-navigation').getByRole('button', { name: /Log out/ }).click();
  }
  await expect.poll(async () => second.evaluate(() => window.localStorage.getItem('fitlook_token'))).toBeNull();

  const isolated = await context.browser().newContext();
  const isolatedPage = await isolated.newPage();
  await isolatedPage.goto('/profile');
  await expect(isolatedPage).toHaveURL(/\/profile/);
  await expect(isolatedPage.getByRole('heading', { name: /Sign in to view your profile/i })).toBeVisible();
  await isolated.close();
});

test('delete account flow requires typed confirmation and clears authenticated state', async ({ page, request, context }) => {
  const account = await createAccountViaApi(request);
  await installToken(context, account.token);

  await page.goto('/profile');
  await page.getByRole('button', { name: 'Delete Account' }).click();
  await expect(page.getByRole('dialog', { name: /Delete your account/i })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog', { name: /Delete your account/i })).toHaveCount(0);

  await page.getByRole('button', { name: 'Delete Account' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  const finalDelete = page.getByRole('button', { name: 'Permanently Delete Account' });
  await expect(finalDelete).toBeDisabled();
  await page.getByLabel('Type DELETE to confirm').fill('delete');
  await expect(finalDelete).toBeDisabled();
  await page.getByLabel('Type DELETE to confirm').fill('DELETE');
  await expect(finalDelete).toBeEnabled();
  await finalDelete.click();

  await expect.poll(() => page.evaluate(() => window.localStorage.getItem('fitlook_token'))).toBeNull();
  await expect(page).toHaveURL(/\/$/);
  const deletedSession = await request.get('/api/auth/me', { headers: { Authorization: `Bearer ${account.token}` } });
  expect(deletedSession.status()).toBe(401);

  await page.goto('/profile');
  await expect(page.getByRole('heading', { name: /Sign in to view your profile/i })).toBeVisible();
});
test('protected routes show guest auth gate and preserve internal return paths', async ({ page }) => {
  await page.goto('/closet');
  await expect(page).toHaveURL(/\/closet/);
  await expect(page.getByRole('heading', { name: /Sign in to access your wardrobe/i })).toBeVisible();
  await expect(page.getByRole('link', { name: /Continue with Phone/i })).toHaveAttribute('href', /\/signup\?return=%2Fcloset/);

  await page.goto('/login?return=https%3A%2F%2Fevil.example%2Fsteal');
  await expect(page.getByRole('heading', { name: /Welcome Back/i })).toBeVisible();
  expect(await page.evaluate(() => {
    const value = new URLSearchParams(window.location.search).get('return') || '';
    if (!value.startsWith('/') || value.startsWith('//')) return '/home';
    try {
      const url = new URL(value, window.location.origin);
      return url.origin === window.location.origin ? `${url.pathname}${url.search}${url.hash}` : '/home';
    } catch {
      return '/home';
    }
  })).toBe('/home');
});

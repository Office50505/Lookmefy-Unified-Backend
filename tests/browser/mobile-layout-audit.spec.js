import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const otpStorePath = process.env.OTP_MOCK_STORE_PATH || '/private/tmp/fitlook-otp-playwright.jsonl';
const bodyPhotoPath = path.resolve('public/assets/search-shirt-1.jpg');

const publicRoutes = [
  '/',
  '/home',
  '/categories',
  '/explore',
  '/search',
  '/try-on',
  '/custom-try-on',
  '/closet',
  '/closet/add',
  '/closet/combo',
  '/closet/items',
  '/wishlist',
  '/cart',
  '/checkout',
  '/style-bot',
  '/tokens',
  '/tokens/top-up',
  '/profile',
  '/generation-history',
  '/signup',
  '/login',
  '/forgot-password',
  '/how-it-works',
  '/about',
  '/download',
  '/support',
  '/contact',
  '/privacy',
  '/terms',
  '/returns',
  '/shipping',
  '/copyright',
  '/data-deletion',
  '/ai-disclaimer'
];

async function latestOtp(phone) {
  const raw = await fs.readFile(otpStorePath, 'utf8').catch(() => '');
  const entries = raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const match = entries.reverse().find((entry) => entry.phone === phone && entry.purpose === 'signup');
  if (!match) throw new Error('No signup OTP found');
  return match.otp;
}

async function createAccount(request) {
  const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const phone = `+919${String(Date.now()).slice(-9)}`;
  const otpRequest = await request.post('/api/auth/signup/request-otp', { data: { phone } });
  const otpData = await otpRequest.json();
  const verify = await request.post('/api/auth/signup/verify-otp', {
    data: { phone, otpSession: otpData.otpSession, otp: await latestOtp(phone) }
  });
  const verifyData = await verify.json();
  const signup = await request.post('/api/auth/signup', {
    multipart: {
      name: `Mobile Audit ${runId}`,
      username: `mobile_audit_${runId}`.slice(0, 40),
      email: `mobile-audit-${runId}@fitlook.local`,
      password: `Mobile-${runId}-Password-12345`,
      phone,
      otpSession: verifyData.otpSession,
      genderPreference: 'other',
      profilePhotoMode: 'exact',
      bodyPhoto: { name: 'body.jpg', mimeType: 'image/jpeg', buffer: await fs.readFile(bodyPhotoPath) }
    }
  });
  expect(signup.status()).toBe(201);
  const data = await signup.json();
  await request.patch('/api/auth/onboarding', {
    headers: { Authorization: `Bearer ${data.token}` },
    data: { reason: 'mobile-layout-audit' }
  });
  return data.token;
}

test('every public route stays inside the mobile viewport', async ({ page, request }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('mobile-'), 'Mobile-only route inventory');

  const productResponse = await request.get('/api/products?limit=1');
  expect(productResponse.ok()).toBeTruthy();
  const productId = (await productResponse.json()).products?.[0]?.id;
  const routes = productId ? [...publicRoutes, `/product/${productId}`] : publicRoutes;
  const failures = [];

  for (const route of routes) {
    await page.goto(route, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('main')).toHaveCount(1);
    await page.waitForTimeout(75);

    const result = await page.evaluate(() => {
      const root = document.documentElement;
      const viewportWidth = root.clientWidth;
      const overflow = Math.max(0, root.scrollWidth - viewportWidth);
      const escapedFixedElements = [];
      const clippedControls = [];

      const isInsideHorizontalScroller = (element) => {
        for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
          const style = getComputedStyle(parent);
          if (['auto', 'scroll'].includes(style.overflowX) && parent.scrollWidth > parent.clientWidth + 1) return true;
        }
        return false;
      };

      for (const element of document.querySelectorAll('body *')) {
        const style = getComputedStyle(element);
        if (!['fixed', 'sticky'].includes(style.position)) continue;
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0 || rect.bottom <= 0 || rect.top >= innerHeight) continue;
        if (rect.left < -1 || rect.right > viewportWidth + 1) {
          escapedFixedElements.push({
            element: `${element.tagName.toLowerCase()}.${String(element.className || '').trim().replace(/\s+/g, '.')}`,
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            viewportWidth
          });
        }
      }

      for (const element of document.querySelectorAll('a, button, input, select, textarea, [role="button"]')) {
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0 || rect.bottom <= 0 || rect.top >= innerHeight) continue;
        if (!isInsideHorizontalScroller(element) && (rect.left < -1 || rect.right > viewportWidth + 1)) {
          clippedControls.push({
            element: `${element.tagName.toLowerCase()}.${String(element.className || '').trim().replace(/\s+/g, '.')}`,
            label: String(element.getAttribute('aria-label') || element.textContent || '').trim().slice(0, 60),
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            viewportWidth
          });
        }
      }

      return { overflow, escapedFixedElements, clippedControls };
    });

    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(40);
    result.bottomNavObstructions = await page.evaluate(() => {
      const navigation = document.querySelector('.mobile-bottom-nav');
      if (!navigation) return [];
      const navRect = navigation.getBoundingClientRect();
      return [...document.querySelectorAll('main a, main button, main input, main select, main textarea, main [role="button"]')].flatMap((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const overlaps = rect.left < navRect.right && rect.right > navRect.left && rect.top < navRect.bottom && rect.bottom > navRect.top;
        if (!overlaps || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return [];
        return [{
          element: `${element.tagName.toLowerCase()}.${String(element.className || '').trim().replace(/\s+/g, '.')}`,
          label: String(element.getAttribute('aria-label') || element.textContent || '').trim().slice(0, 60)
        }];
      });
    });

    if (result.overflow > 1 || result.escapedFixedElements.length || result.clippedControls.length || result.bottomNavObstructions.length) {
      failures.push({ route, ...result });
    }
  }

  expect(failures).toEqual([]);
});

test('home secondary action is not covered by the workflow preview', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('mobile-'), 'Mobile-only interaction audit');

  await page.goto('/home');
  const action = page.locator('.reference-secondary-cta');
  await expect(action).toBeVisible();

  const hitTest = await action.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const points = [
      [rect.left + 6, rect.top + 6],
      [rect.left + rect.width / 2, rect.top + 6],
      [rect.right - 6, rect.top + 6],
      [rect.left + 6, rect.top + rect.height / 2],
      [rect.left + rect.width / 2, rect.top + rect.height / 2],
      [rect.right - 6, rect.top + rect.height / 2],
      [rect.left + 6, rect.bottom - 6],
      [rect.left + rect.width / 2, rect.bottom - 6],
      [rect.right - 6, rect.bottom - 6]
    ];
    const blocked = points.flatMap(([x, y]) => {
      const topElement = document.elementFromPoint(x, y);
      return topElement && (topElement === element || element.contains(topElement))
        ? []
        : [{ x: Math.round(x), y: Math.round(y), topElement: topElement?.className || topElement?.tagName || 'none' }];
    });
    return { blocked, total: points.length };
  });

  expect(hitTest.blocked, `${hitTest.blocked.length}/${hitTest.total} sampled tap points are obstructed`).toEqual([]);

  const actionBox = await action.boundingBox();
  const workflowBox = await page.locator('.reference-tryon-workflow').boundingBox();
  const overlapHeight = actionBox && workflowBox
    ? Math.max(0, Math.min(actionBox.y + actionBox.height, workflowBox.y + workflowBox.height) - Math.max(actionBox.y, workflowBox.y))
    : 0;
  expect(overlapHeight, 'The workflow preview must not visually overlap the Explore Styles action').toBe(0);
});

test('mobile menu isolates the bottom navigation while open', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('mobile-'), 'Mobile-only interaction audit');

  await page.goto('/home');
  await page.getByRole('button', { name: 'Open menu' }).click();
  await expect(page.locator('#mobile-navigation')).toHaveAttribute('aria-modal', 'true');

  const bottomNavigation = page.locator('.mobile-bottom-nav');
  await expect(bottomNavigation, 'A modal drawer must hide or disable navigation outside the dialog').toBeHidden();
});

test('authenticated mobile pages keep controls inside the viewport', async ({ page, request, context }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('mobile-'), 'Mobile-only authenticated audit');

  const token = await createAccount(request);
  await context.addInitScript((value) => localStorage.setItem('fitlook_token', value), token);
  const routes = [
    '/closet', '/closet/add', '/closet/combo', '/closet/items', '/wishlist', '/cart', '/checkout',
    '/custom-try-on', '/style-bot', '/tokens', '/tokens/top-up', '/profile', '/generation-history'
  ];
  const failures = [];

  for (const route of routes) {
    await page.goto(route, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('link', { name: 'Profile', exact: true })).toBeVisible();
    await page.waitForTimeout(150);
    const result = await page.evaluate(() => {
      const viewportWidth = document.documentElement.clientWidth;
      const clipped = [...document.querySelectorAll('a, button, input, select, textarea, [role="button"]')].flatMap((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return [];
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          const parentStyle = getComputedStyle(parent);
          if (parentStyle.display === 'none' || parentStyle.visibility === 'hidden' || Number(parentStyle.opacity) === 0) return [];
        }
        if (rect.width === 0 || rect.height === 0 || rect.bottom <= 0 || rect.top >= innerHeight) return [];
        for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
          const parentStyle = getComputedStyle(parent);
          if (['auto', 'scroll'].includes(parentStyle.overflowX) && parent.scrollWidth > parent.clientWidth + 1) return [];
        }
        if (rect.left >= -1 && rect.right <= viewportWidth + 1) return [];
        return [{
          element: `${element.tagName.toLowerCase()}.${String(element.className || '').trim().replace(/\s+/g, '.')}`,
          label: String(element.getAttribute('aria-label') || element.textContent || '').trim().slice(0, 60),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          viewportWidth
        }];
      });
      return {
        overflow: Math.max(0, document.documentElement.scrollWidth - viewportWidth),
        clipped
      };
    });
    if (result.overflow > 1 || result.clipped.length) failures.push({ route, ...result });
  }

  expect(failures).toEqual([]);
});

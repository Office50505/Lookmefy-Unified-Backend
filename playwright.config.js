import { defineConfig, devices } from '@playwright/test';

const otpStorePath = process.env.OTP_MOCK_STORE_PATH || '/private/tmp/fitlook-otp-playwright.jsonl';
const apiPort = Number(process.env.PLAYWRIGHT_API_PORT || 5051);
const webPort = Number(process.env.PLAYWRIGHT_WEB_PORT || 5174);
const apiBaseUrl = `http://localhost:${apiPort}`;
const webBaseUrl = process.env.PLAYWRIGHT_BASE_URL || `http://localhost:${webPort}`;

export default defineConfig({
  testDir: './tests/browser',
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: [['list']],
  use: {
    baseURL: webBaseUrl,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL || 'chrome'
  },
  webServer: [
    {
      command: `PORT=${apiPort} NODE_ENV=test OTP_DELIVERY_PROVIDER=mock OTP_MOCK_STORE_PATH=${otpStorePath} ENABLE_TEST_OTP_HELPER=true PHONEPE_CALLBACK_USERNAME=playwright PHONEPE_CALLBACK_PASSWORD=playwright QUEUE_ENABLED=false TEMP_SESSION_REQUIRE_REDIS=false REDIS_URL= RATE_LIMIT_GLOBAL_MAX=10000 RATE_LIMIT_AUTH_OTP_REQUEST_IP_MAX=1000 RATE_LIMIT_AUTH_OTP_REQUEST_PHONE_MAX=100 RATE_LIMIT_AUTH_OTP_REQUEST_PHONE_HOURLY_MAX=100 npm run server`,
      url: `${apiBaseUrl}/api/health`,
      reuseExistingServer: true,
      timeout: 30_000
    },
    {
      command: `VITE_DEV_PROXY_TARGET=${apiBaseUrl} VITE_ENABLE_TEST_OTP_HELPER=true npm run dev -- --port ${webPort}`,
      url: `${webBaseUrl}/`,
      reuseExistingServer: true,
      timeout: 30_000
    }
  ],
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } }
    },
    {
      name: 'mobile-390',
      use: { ...devices['Pixel 5'], viewport: { width: 390, height: 844 } }
    },
    {
      name: 'tablet-768',
      use: { ...devices['Desktop Chrome'], viewport: { width: 768, height: 1024 }, isMobile: false, hasTouch: true }
    }
  ]
});

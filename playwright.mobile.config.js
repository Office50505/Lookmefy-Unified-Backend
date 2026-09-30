import { defineConfig, devices } from '@playwright/test';
import baseConfig from './playwright.config.js';

const mobileChrome = devices['Pixel 5'];

export default defineConfig({
  ...baseConfig,
  projects: [
    {
      name: 'mobile-320',
      use: { ...mobileChrome, viewport: { width: 320, height: 568 } }
    },
    {
      name: 'mobile-360',
      use: { ...mobileChrome, viewport: { width: 360, height: 800 } }
    },
    {
      name: 'mobile-390',
      use: { ...mobileChrome, viewport: { width: 390, height: 844 } }
    },
    {
      name: 'mobile-430',
      use: { ...mobileChrome, viewport: { width: 430, height: 932 } }
    }
  ]
});

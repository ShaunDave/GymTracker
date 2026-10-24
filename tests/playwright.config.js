// @ts-check
const { defineConfig } = require('@playwright/test');
const path = require('path');

module.exports = defineConfig({
  testDir: '.',
  testMatch: ['test-config-page.js', 'emulator.js', 'test-csv-export.js', 'test-e2e.js',
              'test-countdown-config.js', 'test-countdown-watch.js'],
  timeout: 60_000,
  snapshotPathTemplate: '{testDir}/golden/{arg}{ext}',
  expect: { timeout: 5_000 },
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  use: {
    headless: true,
    viewport: { width: 400, height: 800 },
    actionTimeout: 5_000,
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});

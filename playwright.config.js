import { defineConfig, devices } from '@playwright/test';

const PORT = 4321;

export default defineConfig({
  testDir: 'tests/browser',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    acceptDownloads: true,
    trace: 'retain-on-failure',
    // A synthetic camera for the scanner tests; no permission prompt.
    launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] }, grepInvert: /@mobile/ },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] }, grep: /@mobile/ },
  ],
  webServer: {
    command: `node server.js`,
    env: { PORT: String(PORT), ...(process.env.FOLDR_PUBLIC_DIR ? { FOLDR_PUBLIC_DIR: process.env.FOLDR_PUBLIC_DIR } : {}) },
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: false,
  },
});

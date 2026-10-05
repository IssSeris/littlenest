import { defineConfig, devices, webkit } from '@playwright/test';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureNixBrowserLibraries } from './tests/browser/nix-libraries';

configureNixBrowserLibraries();
const nixWebKit = process.env.PASTE_BROWSER_NIX_LIBRARIES_READY === '1';
if (nixWebKit) process.env.PASTE_BROWSER_WEBKIT_DIR = dirname(webkit.executablePath());

const baseURL = process.env.PASTE_BROWSER_BASE_URL
  ?? (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : '');
const url = new URL(baseURL);
if (url.pathname !== '/' || process.env.NODE_ENV === 'production'
  || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !url.hostname.endsWith('.replit.dev')) {
  throw new Error('Paste browser regressions may only run against a development app.');
}

export default defineConfig({
  testDir: './tests/browser',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  // Authentication tickets must never be recorded in traces or video.
  use: { baseURL, trace: 'off', video: 'off', screenshot: 'only-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: {
      ...devices['Desktop Safari'],
      ...(nixWebKit ? { launchOptions: {
        executablePath: fileURLToPath(new URL('./tests/browser/webkit-nix.sh', import.meta.url)),
      } } : {}),
    } },
  ],
});
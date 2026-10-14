import { defineConfig } from "@playwright/test";

// Synthetic fixture only (preview/fixtures.js): no daemon, no real browser session, no network writes.
// Hosts without system Chromium libraries pass them in with LD_LIBRARY_PATH as usual.
const port = Number(process.env.SERVER_BROWSER_PREVIEW_PORT) || 4196;
export default defineConfig({
  testDir: ".", testMatch: "ui.spec.ts", fullyParallel: false, workers: 1, timeout: 30000, retries: 0,
  reporter: "list", outputDir: "../test-results",
  use: { baseURL: `http://127.0.0.1:${port}`, screenshot: "only-on-failure", launchOptions: process.env.BROWSER_TEST_EXECUTABLE ? { executablePath: process.env.BROWSER_TEST_EXECUTABLE } : undefined },
  webServer: { command: "node scripts/preview.mjs --serve", cwd: new URL("..", import.meta.url).pathname, url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 30000 },
  projects: [{ name: "desktop", use: { viewport: { width: 1120, height: 760 } } }, { name: "mobile", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } }],
});

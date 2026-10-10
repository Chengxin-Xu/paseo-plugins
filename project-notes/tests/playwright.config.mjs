import { defineConfig } from "@playwright/test";

// UI flows against the fixture preview (scripts/preview.mjs: synthetic notes, in-memory RPCs, no daemon).
// The browser runs in UTC whatever the host's zone, so dates render the same everywhere.
export default defineConfig({
  testDir: ".", testMatch: "ui.spec.ts", fullyParallel: false, workers: 1, timeout: 20_000, retries: 0,
  reporter: "list", outputDir: "../test-results",
  use: { baseURL: "http://127.0.0.1:4693", timezoneId: "UTC", locale: "zh-CN", screenshot: "only-on-failure" },
  webServer: { command: "node scripts/preview.mjs --serve", cwd: new URL("..", import.meta.url).pathname, url: "http://127.0.0.1:4693", reuseExistingServer: false, timeout: 30_000 },
  projects: [
    { name: "desktop", use: { viewport: { width: 1120, height: 760 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
});

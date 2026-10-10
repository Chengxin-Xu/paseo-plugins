import { defineConfig } from "@playwright/test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Optional local font installation keeps Chinese fixture screenshots legible on
// minimal Linux images. It does not modify system font directories or config.
const fontDirectory = process.env.OBSERVATORY_PREVIEW_FONT_DIR;
const browserEnvironment = { ...process.env };
if (fontDirectory && existsSync(fontDirectory)) {
  const fontHome = join(tmpdir(), "observatory-preview-fontconfig");
  mkdirSync(fontHome, { recursive: true });
  const configuration = join(fontHome, "fonts.conf");
  const xmlDirectory = fontDirectory.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  writeFileSync(configuration, `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><include ignore_missing="yes">/etc/fonts/fonts.conf</include><dir>${xmlDirectory}</dir><cachedir>${fontHome}/cache</cachedir></fontconfig>`);
  browserEnvironment.FONTCONFIG_FILE = configuration;
}

export default defineConfig({
  testDir: ".", testMatch: "ui.spec.ts", timeout: 30_000, expect: { timeout: 8_000 },
  fullyParallel: false, workers: 1, retries: 0, forbidOnly: Boolean(process.env.CI),
  reporter: "list", outputDir: "../test-results",
  use: { baseURL: "http://127.0.0.1:4177", browserName: "chromium", screenshot: "only-on-failure", trace: "retain-on-failure", launchOptions: { env: browserEnvironment } },
  webServer: { command: "node scripts/build-preview.mjs --serve", cwd: new URL("..", import.meta.url).pathname,
    url: "http://127.0.0.1:4177", reuseExistingServer: false, timeout: 30_000 },
  projects: [
    { name: "desktop-dark", use: { viewport: { width: 1440, height: 1000 }, colorScheme: "dark" } },
    { name: "desktop-light", use: { viewport: { width: 1440, height: 1000 }, colorScheme: "light" } },
    { name: "desktop-short", use: { viewport: { width: 1280, height: 720 }, colorScheme: "dark" } },
    { name: "mobile-390", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: "mobile-320", use: { viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true } },
  ],
});

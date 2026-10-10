import { defineConfig } from "vitest/config";

// tests/ui.spec.ts is the Playwright suite (npm run test:ui); vitest runs the *.test files only.
export default defineConfig({ test: { setupFiles: ["tests/setup.ts"], include: ["tests/**/*.test.{ts,tsx}"] } });

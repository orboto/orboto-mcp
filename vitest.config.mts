import { defineConfig } from 'vitest/config';

// ORB-1853 - the mcp package ran on vitest defaults until now; this config
// exists for the coverage block (same shape as api/web).
export default defineConfig({
  test: {
    // ORB-1948 - the 5 s vitest default was sized for an idle laptop. On the
    // saturated CI host (release + develop + tag + PR runs sharing one
    // runner) page-render smokes and cold lazy-route transforms exceeded it
    // and a green suite went red on the release commit twice in one day.
    // Same budget the api suite carries since ORB-1551; a hang still fails.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ['src/**/*.test.ts'],
    // ORB-1853 - coverage is measured on every CI run and ratcheted per
    // package by scripts/check-coverage.mjs (json-summary is what it reads).
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: './coverage',
      // A red run still writes the summary, so a local baseline measurement
      // survives one flaky file (CI fails on the red test anyway).
      reportOnFailure: true,
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/**/*.d.ts', 'src/db/migrations/**', 'src/db/seed-demo/**', 'src/scripts/**'],
    },
  },
});

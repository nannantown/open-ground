import { defineConfig, devices } from '@playwright/test'

// Dedicated Playwright config for the PERFORMANCE harness (NOT part of the e2e
// smoke suite — the default playwright.config.ts only scans ./e2e). Run with:
//   npx playwright test --config perf/perf.config.ts
//
// It builds the SPA + server bundle and boots the Hono server in PROD mode, so
// the numbers reflect the real minified React build the packaged app ships —
// not dev-mode noise. Fully isolated HOME + OPENGROUND_HOME so seeding 50
// projects / 200 cards / 300 elements never touches the real ~/.openground.
//
// A dedicated port (47900) keeps it clear of `npm run dev` (5174/47776) and the
// e2e suite (47876). One worker, long timeout (seeding + heavy gestures).
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  timeout: 240_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: 'http://127.0.0.1:47900',
    viewport: { width: 1600, height: 1000 },
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // PERF_NO_BUILD=1 reuses the existing prod build (fast iteration on the
    // spec); default rebuilds so a before/after run measures the current code.
    command:
      (process.env.PERF_NO_BUILD ? 'true' : 'npm run build') +
      ' && H="$(mktemp -d)" && mkdir -p "$H/.openground" "$H/.claude" && ' +
      'HOME="$H" OPENGROUND_HOME="$H/.openground" ' +
      'OPENGROUND_TERMINAL_SHELL=/bin/sh ' +
      'PORT=47900 node server/dist/index.cjs',
    // Playwright defaults webServer cwd to the CONFIG file's dir (perf/); pin it
    // to the repo root so `npm run build` + `node server/dist/index.cjs` resolve.
    cwd: process.cwd(),
    port: 47900,
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})

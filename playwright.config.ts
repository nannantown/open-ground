import { defineConfig, devices } from '@playwright/test'

// E2E config — kept narrow so the suite stays a smoke-level catch for
// "is the app even bootable?" rather than a full UI replacement for
// vitest's pure-logic tests. We run a single worker against a single
// dev-server instance because OPEN GROUND's runner has shared
// in-memory state (sessions Map, projectLocks) that doesn't tolerate
// being hammered from parallel test contexts.
export default defineConfig({
  testDir: './e2e',
  // Per-file parallelism is fine; cross-file is not (shared dev-server
  // state). Workers=1 enforces the serial outer loop.
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    // The Hono server serves both the Vite SPA and /api on the fixed port,
    // so one origin covers page loads and API smoke checks.
    baseURL: 'http://127.0.0.1:47776',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Build the SPA + server bundle, then boot the Hono server in prod mode so
  // it serves dist-web (the SPA) AND /api on the fixed port — one origin, the
  // same thing the packaged app forks. Plain `node` (not Electron): node-pty
  // is loaded lazily on first terminal use, and the smoke suite never spawns a
  // terminal, so the Electron-ABI binding is never touched here.
  webServer: {
    command:
      'npm run build && OPENGROUND_WEB_ROOT="$PWD/dist-web" OPENGROUND_BOOT_ID=e2e PORT=47776 HOSTNAME=127.0.0.1 node server/dist/index.cjs',
    url: 'http://127.0.0.1:47776/api/health',
    reuseExistingServer: !process.env.CI,
    // build + boot can be slow on CI cold start — give it 3 minutes.
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})

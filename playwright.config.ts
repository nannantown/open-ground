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
    // The Hono server serves both the Vite SPA and /api on one origin, so a
    // single baseURL covers page loads and API checks. We use a DEDICATED e2e
    // port (47876, not the app's default 47776) so the suite boots its own
    // fully-isolated server without colliding with a running `npm run dev`.
    // Prod-mode SPA calls /api relative to its own origin, so the port is free
    // to change.
    baseURL: 'http://127.0.0.1:47876',
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
  // Build the SPA + server bundle, then boot the Hono server in prod mode so it
  // serves dist-web (the SPA) AND /api on one origin — the same thing the
  // packaged app forks. Plain `node` (not Electron): node-pty is loaded lazily
  // on first terminal use; here the run/terminal specs DO spawn a PTY, but
  // node-pty's plain-node binding handles that fine outside Electron.
  //
  // Full isolation so the destructive specs (create/delete projects, runs) can
  // never touch the real environment:
  //   - HOME=tmp           → claude's session JSONLs + folder-trust land in a
  //                          throwaway ~/.claude, never the user's.
  //   - OPENGROUND_HOME=tmp → all app/project data (settings, registry, runs)
  //                          lands in a throwaway ~/.openground.
  //   - OPENGROUND_CLAUDE_BIN=fixture → the runner spawns the deterministic
  //                          fake-claude stub instead of the real CLI, so the
  //                          whole run flow works with no live subscription.
  //   - OPENGROUND_TERMINAL_SHELL=/bin/sh → a predictable login shell for the
  //                          PTY regardless of the host's $SHELL / dotfiles.
  webServer: {
    command:
      'npm run build && ' +
      'H="$(mktemp -d)" && mkdir -p "$H/.openground" "$H/.claude" && ' +
      'HOME="$H" OPENGROUND_HOME="$H/.openground" ' +
      'OPENGROUND_CLAUDE_BIN="$PWD/e2e/fixtures/fake-claude.sh" ' +
      'OPENGROUND_TERMINAL_SHELL=/bin/sh ' +
      'OPENGROUND_WEB_ROOT="$PWD/dist-web" OPENGROUND_BOOT_ID=e2e ' +
      'PORT=47876 HOSTNAME=127.0.0.1 node server/dist/index.cjs',
    url: 'http://127.0.0.1:47876/api/health',
    // Always boot a fresh, isolated server — never reuse a foreign one on this
    // port (a stray real-env server would defeat the isolation above).
    reuseExistingServer: false,
    // build + boot can be slow on CI cold start — give it 3 minutes.
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})

import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

// Vitest config — kept tiny so the first wave of tests is purely about
// covering important *pure* logic (string parsers, slug generators, schema
// validation). Component / browser tests can be layered on later by adding
// a `jsdom` environment to specific files via the `// @vitest-environment`
// pragma; the global default stays `node` for fast startup.
export default defineConfig({
  test: {
    // src/** covers the pure-logic unit tests; server/** covers the Hono
    // route integration tests (server/**/__tests__/*.test.ts) that import the
    // bare `app` and exercise routes via app.request(...) without binding a
    // TCP port. Both trees compile under the same tsconfig include + `@` alias.
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'server/**/*.test.ts',
    ],
    // Global default stays `node` for fast startup. Component / hook tests opt
    // into a DOM per-file with a `// @vitest-environment jsdom` pragma.
    environment: 'node',
    // setup-home: redirect OPENGROUND_HOME to a throwaway tmp dir before any
    //   test module loads, so server code never touches the real ~/.openground.
    // setup-dom: register @testing-library/jest-dom matchers + RTL auto-cleanup
    //   (a no-op in node-environment tests; see the file's note).
    setupFiles: ['./src/test/setup-home.ts', './src/test/setup-dom.ts'],
    // ── Timezone ──────────────────────────────────────────────────────────
    // PIN THE RUNNER'S TIMEZONE TO CI's. Do not remove this to "use the real
    // local time" — a local run that disagrees with CI is the whole problem.
    //
    // Measured 2026-07-29: three `swarmQuota.test.ts` cases were green on the
    // author's machine (Asia/Tokyo) and red on every CI run for 4 consecutive
    // pushes, INCLUDING the 0.11.40 release commit. The cause was not the code:
    // `parseResetLabel`'s bare-clock branch resolves through `setHours`, i.e. in
    // LOCAL time, and the fixture compared it against a hardcoded "3pm". The
    // injected clock reads 07:13 in Asia/Tokyo (3pm ahead) but 22:13 in UTC
    // (3pm long past), so the two environments genuinely disagreed. A full
    // `npm test` at green is the release gate, so this shipped.
    //
    // ubuntu-latest runners are UTC, so UTC here makes "green locally" mean
    // "green on CI" for anything that touches a wall clock. It does NOT make a
    // test timezone-INDEPENDENT — it makes the whole fleet agree on one zone.
    // Logic that must hold in every zone still has to say so itself (build the
    // expected value from the injected clock, as swarmQuota.test.ts's
    // `atLocalHour` now does), because pinning proves nothing about zones the
    // suite never runs in.
    env: { TZ: 'UTC' },
    // ── Timeouts ──────────────────────────────────────────────────────────
    // Vitest's own defaults are testTimeout 5_000 / hookTimeout 10_000 in the
    // node environment (vitest 4.1.7; https://vitest.dev/config/testtimeout,
    // checked 2026-07-23). Those defaults DO NOT fit this repo — do not
    // "clean up" these two lines back to the default.
    //
    // Why: most tests under src/lib/server + server/ are real I/O — mkdtemp,
    // real fs writes, realpath canonicalization, and in the swarm/git suites
    // actual `git` child processes. At idle each finishes in ~200-400ms, but
    // they are wall-clock bound, so under CPU contention they stretch 14-20x
    // (measured 2026-07-20). Contention is the NORMAL state here, not an
    // exception: the swarm engine keeps several claude workers and reviewer
    // sub-agents running while a suite is being verified.
    //
    // What the 5s default actually cost (measured 2026-07-23, load avg 5-7):
    //   - an UNMODIFIED origin/main reported 400 failing tests; the very same
    //     commit was 285 files / 5711 passed / 0 failed a few hours earlier
    //     at idle.
    //   - the failures were nondeterministic: re-running one file on its own
    //     failed a DIFFERENT test each run (slowest took 7125ms). That is a
    //     stopwatch result, not a regression — but it reads exactly like
    //     "main is broken" and sent the commander into a ~40min hunt (three
    //     full-suite runs + a bisect) for a bug that never existed.
    // 60_000 is >8x the worst run observed under normal load (7.2s), so an
    // ordinary load spike is very unlikely to reach it. It does NOT make timeouts
    // impossible: under pathological oversubscription (the whole 285-file suite
    // running several times over at once) an unfenced fs-heavy test has been seen
    // to hit 60000ms too — the fix kills the 5s CHRONIC flap, it doesn't promise
    // zero timeouts at any load. It is also the value the 15 files that had
    // already self-defended with `vi.setConfig` converged on — hoisted here so
    // all ~285 files get it instead of 5%.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // The guard that keeps a 60s ceiling from hiding a genuine hang: the
    // default reporter prints any test slower than this in yellow. Vitest's
    // default (300ms) would flag nearly every I/O test here = no signal at
    // all. 10s sits above the worst load-induced runtime observed (7.2s) and
    // 6x below the timeout, so a test drifting toward a real hang becomes
    // visible long before it starts failing.
    slowTestThreshold: 10_000,
    // Test files share the same `@/*` path alias as the app does
    // (tsconfig.json `paths`). Without this, imports like
    // `from '@/lib/types'` fail in test files.
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
})

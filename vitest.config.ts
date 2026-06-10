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

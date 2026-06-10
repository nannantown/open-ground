// DOM test setup — registers @testing-library/jest-dom's matchers (toBeVisible,
// toHaveTextContent, toBeDisabled, …) on vitest's expect, and auto-cleans the
// React tree after each test so jsdom-environment specs don't leak DOM between
// cases.
//
// This is in the GLOBAL setupFiles list (vitest.config.ts) so it runs for every
// test file, but the suite default environment stays `node` for speed — only
// files with a `// @vitest-environment jsdom` pragma get a DOM. The jest-dom
// matcher registration is a harmless no-op for node-environment tests; the RTL
// cleanup is guarded on `document` existing so it never runs (and never throws)
// in a node test.
import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

afterEach(() => {
  if (typeof document !== 'undefined') cleanup()
})

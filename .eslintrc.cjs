// ESLint config — .cjs, not .json, ON PURPOSE.
//
// The import ban below is the repository's answer to a defect class that nine
// rounds of code review could not close (2026-08-01). Every exemption in it is
// a claim about why one file may reach a desk pool directly, and a claim with
// no reason attached is the kind a later reader deletes to make the build pass.
// JSON cannot hold the reasons. So the config moved to CJS and the reasons live
// beside the paths.

/**
 * ⚠ THE DEFECT CLASS THIS FILE EXISTS TO CLOSE.
 *
 * OPEN GROUND runs claude desks on two runtimes with two independent pools:
 * `terminal.ts` (node-pty) and `sdkSession.ts` (Agent SDK). The identity
 * invariant is `pty ⇔ terminalId` / `sdk ⇔ sdkSessionId`, and an SDK worker's
 * terminalId is the EMPTY STRING — never absent. So a call site that reaches
 * one pool directly does not fail loudly for the other runtime's workers. It
 * does nothing, or it hits the wrong worker, and it says neither.
 *
 * Measured: nine adversarial review rounds confirmed 60+ defects in this
 * migration, and 15+ of them were this ONE shape, re-appearing every round at a
 * NEW call site. Among them: a cleaner that removed a running worker's worktree
 * (both pools were live, one was asked); a dedup key `S4:${w.terminalId}` that
 * collapsed the whole SDK fleet onto one slot and silently discarded every
 * worker's escalation but the first; a roster that drew healthy workers as
 * exited and offered a Restart that started a SECOND claude in the same tree.
 *
 * WHY A LINT RULE AND NOT ANOTHER TEST. Round 8 built a static inventory test
 * that registered every risky call site with a reason and failed on unregistered
 * ones. Four production defects were then planted in it by hand — and all four
 * passed. The reason is structural: an inventory asks "is this listed?", so a
 * gap in the list is silence. This rule asks "is the name even in scope?", so a
 * gap is a compile-time error. Same allowlist shape, opposite direction of
 * failure — and only one of the two can go quietly out of date.
 *
 * It also reaches what no test can: a call site that does not exist yet. A new
 * file cannot ask one pool without an explicit, reasoned edit HERE.
 *
 * THE RIGHT WAY TO ASK. `workerRuntime.ts` (`workerKey` / `runtimeOf` — address
 * and operate a worker on whichever runtime it runs) and `liveDesks.ts` ("who
 * is alive / where", asked ONCE across both pools). See docs/MAP.md §5.
 */
const POOL_IMPORTS = {
  pty: ['**/lib/server/terminal', '@/lib/server/terminal', './terminal', '../terminal'],
  sdk: ['**/lib/server/sdkSession', '@/lib/server/sdkSession', './sdkSession', '../sdkSession'],
}

const ASK_THE_SEAM =
  ' Reach a worker through workerRuntime (workerKey / runtimeOf) or liveDesks ' +
  '(both pools at once) instead. An SDK worker\'s terminalId is EMPTY, so a direct ' +
  'pool call does not fail for it — it silently does nothing or hits the wrong ' +
  'worker. If this file genuinely belongs to one runtime, add it to the exemption ' +
  'list in .eslintrc.cjs WITH THE REASON. See docs/MAP.md §5.'

const ban = (which) => ({
  patterns: [
    {
      group: POOL_IMPORTS[which],
      message: `Direct ${which === 'pty' ? 'PTY' : 'SDK'} desk-pool import.${ASK_THE_SEAM}`,
    },
  ],
})

const banBoth = () => ({
  patterns: [
    { group: POOL_IMPORTS.pty, message: `Direct PTY desk-pool import.${ASK_THE_SEAM}` },
    { group: POOL_IMPORTS.sdk, message: `Direct SDK desk-pool import.${ASK_THE_SEAM}` },
  ],
})

const { SEAMS, PTY_BY_DESIGN, BOTH_POOLS_DEBT } = require('./scripts/importBoundary.cjs')

module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  plugins: ['@typescript-eslint', 'react-hooks'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  env: { browser: true, node: true, es2022: true },
  ignorePatterns: ['node_modules', 'dist-web', 'dist-electron', 'server/dist', '.next'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-unused-vars': [
      'warn',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    'no-empty': ['error', { allowEmptyCatch: true }],
    'no-control-regex': 'off',
    'no-useless-escape': 'warn',
    'no-extra-semi': 'off',
    '@typescript-eslint/no-unused-expressions': 'off',
    '@typescript-eslint/no-require-imports': 'off',
    '@typescript-eslint/no-empty-object-type': 'off',
    // The default for every file: neither pool is reachable from here.
    'no-restricted-imports': ['error', banBoth()],
  },
  overrides: [
    {
      // Tests DRIVE the pools — spawning a real session against a fake queryFn
      // is how the contract is pinned at all. Banning them would delete the
      // guards this rule exists to complement.
      files: ['**/*.test.ts', '**/*.test.tsx', '**/__tests__/**', 'scripts/**'],
      rules: { 'no-restricted-imports': 'off' },
    },
    { files: SEAMS, rules: { 'no-restricted-imports': 'off' } },
    { files: PTY_BY_DESIGN, rules: { 'no-restricted-imports': ['error', ban('sdk')] } },
    { files: BOTH_POOLS_DEBT, rules: { 'no-restricted-imports': 'off' } },
  ],
}



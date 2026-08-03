// The SDK runtime has to survive BUNDLING — and "it loaded" has to mean the ESM
// module actually loaded, not that a function returned without throwing.
//
// WHY THIS FILE EXISTS. `sdkSession.ts` reached the Agent SDK with
// `require('@anthropic-ai/claude-agent-sdk')`. That package is ESM-only
// (`"type":"module"`, main `sdk.mjs`) and is deliberately `external` in
// scripts/build-server.js, so inside `server/dist/index.cjs` — the CommonJS
// bundle Electron forks in the packaged app — the require hit a real ES module.
// Electron 31.7.7 carries Node 20.18.0 and `require(esm)` exists only from Node
// 20.19 / 22.12 onward, so EVERY SDK spawn in a shipped build threw
// ERR_REQUIRE_ESM and silently degraded to a PTY. 0.11.47 and 0.11.48 shipped
// "the default runtime is SDK" and never started one SDK desk as a product.
//
// Nothing could see it. Dev runs tsx (real ESM), vitest is ESM, and
// `node server/dist/index.cjs` only boots the server — it never reaches a spawn.
// The identical shape had already been paid for once: sdkGuardBundleShape.test.ts
// exists because `import.meta` is absent in CJS output. So this file follows that
// file's rule — EXECUTE the build and then EXECUTE its output, because "the
// source says import()" and "the shipped bundle can load the module" are
// different claims and only the second one ships.
//
// The three assertions are deliberately layered: the premise (require really is
// fatal without require(esm)), the shape (esbuild left the `import()` alone), and
// the measurement (a bundle built with the PRODUCTION options really pulled the
// SDK's own exports into memory).
//
// ⚠ WHAT THIS FILE DOES NOT PROVE: it runs the bundle on THIS machine's Node
// (22.22) with require(esm) switched off — not on the Node 20.18 that Electron
// embeds and forks. That gap is no longer unmeasured, only unmeasured *here*:
// on 2026-08-03 the shipped app was probed directly and a packaged-app SDK
// worker ran end to end. See the note on `nodeArgs` for what was seen.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as esbuild from 'esbuild'
import { spawnSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { REPO_PROBE_PREFIX, REPO_ROOT } from '../../test/repoRootFence'

const distDir = join(REPO_ROOT, 'server', 'dist')
const SDK = '@anthropic-ai/claude-agent-sdk'

// The REAL production options, not a copy — the point of the test is that the
// combination the ship uses (`format:'cjs'` + `target:'node20'` + SDK external)
// is the combination that preserves `import()`. A hand-written config here would
// keep passing while scripts/build-server.js drifted underneath it.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildOptions } = require(join(REPO_ROOT, 'scripts', 'build-server.js')) as {
  buildOptions: esbuild.BuildOptions
}

/** Node flags that reproduce the ONE property of Electron's Node 20.18 that this
 *  defect turns on: `require(esm)` not being available.
 *
 *  ⚠ WITHOUT THIS THE WHOLE FILE IS A FALSE GREEN. The dev machine runs Node
 *  22.22, where `require(esm)` has been unflagged since 22.12 and therefore
 *  SUCCEEDS — so the broken `require()` this file guards against would have
 *  satisfied every assertion below on the very machine the fix was written on,
 *  while the shipped app kept failing.
 *
 *  ⚠ AND THIS IS STILL NOT THE SHIPPING RUNTIME — SAY SO RATHER THAN IMPLY
 *  OTHERWISE. The flag removes `require(esm)`; it does not turn Node 22.22 into
 *  the Node 20.18 that Electron 31.7.7 embeds, and the child process below is
 *  `process.execPath`, not Electron. BOTH defects of this class so far were
 *  "green on the dev Node, dead on the forked Electron Node" (docs/MAP.md says
 *  exactly that), so the honest claim for this file is narrow, and unchanged:
 *  **the emitted CJS loads the ESM package on a Node that has no require(esm)**.
 *
 *  WHAT ELECTRON'S OWN NODE DOES was measured on 2026-08-03 — off to the side,
 *  on the owner's machine against the packaged app, because a test run still
 *  cannot reach it from here (`node_modules/electron/dist` holds only LICENSE +
 *  version, same as 2026-08-02):
 *    - `ELECTRON_RUN_AS_NODE=1 "…/OPEN GROUND.app/Contents/MacOS/OPEN GROUND"`
 *      reports `node 20.18.0 | electron 31.7.7`, and there
 *      `require('@anthropic-ai/claude-agent-sdk')` FAILS ERR_REQUIRE_ESM while
 *      the system Node 22.22.0 succeeds. So the missing `require(esm)` is about
 *      20.18.0 specifically, not "Node 20" — it landed in 20.19 / 22.12.
 *    - the `import()` half was confirmed IN THAT RECORD end to end rather than by
 *      probe: on 0.11.49 a packaged-app worker dispatched with the runtime dial
 *      untouched came up `runtime:'sdk'` (sdkSessionId set, terminalId empty) and
 *      reached commit, with zero `runtime fallback (SDK→PTY)` lines for that boot.
 *      That narrow wording is deliberate — a DIRECT `import(ESM)` probe against
 *      Electron 31.7.7 does exist (docs/VERIFICATION.md §4.1, and the probe
 *      docs/DISTRIBUTION.md recommends). This record is not that probe and does
 *      not supersede it; the two corroborate each other.
 *      Both records: docs/SDK_WORKER_MIGRATION_PLAN.md §12「実機実測ログ 2」.
 *  ⚠ Probe with the BARE specifier. Requiring the unexported subpath
 *  `…/@anthropic-ai/claude-agent-sdk/sdk.mjs` — the path the 0802 crash message
 *  names — fails ERR_PACKAGE_PATH_NOT_EXPORTED on BOTH runtimes, which looks
 *  like this defect and is a different one.
 *
 *  None of that makes THIS file run under Electron's Node. The next defect of
 *  this class still costs one real packaged-app pass; see docs/DISTRIBUTION.md. */
const nodeArgs = ((): string[] => {
  const probe = spawnSync(process.execPath, ['--no-experimental-require-module', '-e', '0'])
  // A Node old enough to reject the flag is a Node with no `require(esm)` to
  // disable — the semantics we want either way. The premise test proves which.
  return probe.status === 0 ? ['--no-experimental-require-module'] : []
})()

const runNode = (args: string[]): { out: string; err: string; status: number | null } => {
  const r = spawnSync(process.execPath, [...nodeArgs, ...args], { cwd: REPO_ROOT, encoding: 'utf8' })
  return { out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim(), status: r.status }
}

describe('the ESM-only SDK loads from the CJS bundle the app ships', () => {
  it('require() of the SDK is FATAL on the runtime the packaged app runs', () => {
    // Pin the premise. The day this prints LOADED, every other assertion in this
    // file has quietly stopped testing anything and must be re-derived.
    const r = runNode([
      '-e',
      `try { require(${JSON.stringify(SDK)}); console.log('LOADED') }` +
        ` catch (e) { console.log('CODE:' + e.code) }`,
    ])
    expect(r.out, `stderr: ${r.err}`).toBe('CODE:ERR_REQUIRE_ESM')
  })

  describe('a bundle built with the production options', () => {
    let dir = ''
    let outfile = ''
    let bundled = ''

    beforeAll(async () => {
      // ⚠ INSIDE THE REPO ON PURPOSE, AND NOT IN tmpdir(). `import()` resolves
      // from the EMITTED FILE's own directory, so only a bundle sitting inside
      // the repo walks up to the same node_modules the packaged bundle walks up
      // to; a probe in os.tmpdir() would fail to resolve for a reason production
      // never has, and the test would be measuring the tmpdir rather than the
      // fix. Routed through REPO_PROBE_PREFIX because that is the sanctioned way
      // to need a non-temp path — .gitignore covers it, so it cannot dirty
      // `git status` or be swept into a commit (src/test/repoRootFence.ts).
      dir = mkdtempSync(join(REPO_ROOT, REPO_PROBE_PREFIX))
      const entry = join(dir, 'entry.ts')
      outfile = join(dir, 'out.cjs')
      writeFileSync(
        entry,
        `import { preloadSdk } from ${JSON.stringify(join(REPO_ROOT, 'src', 'lib', 'server', 'sdkSession'))}\n` +
          `preloadSdk().then((r) => console.log('OG_SDK_PROBE:' + JSON.stringify(r)))\n`,
      )
      await esbuild.build({
        ...buildOptions,
        entryPoints: [entry],
        outfile,
        sourcemap: false,
        logLevel: 'silent',
      })
      bundled = readFileSync(outfile, 'utf8')
    })

    afterAll(() => {
      if (dir) rmSync(dir, { recursive: true, force: true })
    })

    it('keeps the SDK behind import(), never require()', () => {
      // The shape, so a failure below can be told apart from a broken install.
      // esbuild rewrites `import()` to `require()` when the target lacks the
      // dynamic-import feature or when the module is bundled instead of external
      // — both are one edit away in scripts/build-server.js.
      expect(bundled).toMatch(new RegExp(`import\\("${SDK}"\\)`))
      expect(bundled).not.toMatch(new RegExp(`require\\("${SDK}"\\)`))
    })

    it('actually pulls the SDK’s own exports into memory when RUN', () => {
      const r = runNode([outfile])
      const line = r.out.split('\n').find((l) => l.startsWith('OG_SDK_PROBE:'))
      expect(line, `bundle produced no probe line. stderr: ${r.err}`).toBeTruthy()
      const got = JSON.parse(line!.slice('OG_SDK_PROBE:'.length)) as {
        loaded: boolean
        error?: string
        quotaPrefixCount: number
      }
      expect(got.loaded, `loader failed: ${got.error ?? ''}`).toBe(true)
      // ⚠ NOT "the call returned". `USAGE_LIMIT_ERROR_PREFIXES` is a non-empty
      // array declared INSIDE sdk.mjs, so a count above zero is only reachable if
      // the ES module was evaluated. An interop stub, a caught error, or a
      // resolved-but-empty namespace all score zero here.
      expect(got.quotaPrefixCount).toBeGreaterThan(0)
    })
  })

  // The artifact itself, when one is on disk. This is the check whose ABSENCE
  // let the defect ship: the suite only ever read the sources.
  const shipped = join(distDir, 'index.cjs')
  it.skipIf(!existsSync(shipped))('the built server/dist/index.cjs loads the SDK, and loads it with import()', () => {
    const js = readFileSync(shipped, 'utf8')
    expect(
      js,
      'server/dist/index.cjs requires the ESM-only SDK — it is stale or built from the broken source. Run `npm run build`.',
    ).not.toMatch(new RegExp(`require\\("${SDK}"\\)`))
    // ⚠ ABSENCE IS NOT ENOUGH, AND THAT IS NOT A THEORETICAL GAP. Drop the SDK
    // from `external` in build-server.js and it gets BUNDLED: the specifier then
    // appears in neither form, so a `require(` = 0 assertion passes while the
    // deliberate lazy load is gone and a 4MB SDK is inlined. The positive check
    // is what distinguishes "loaded correctly" from "not there at all".
    expect(
      js,
      'server/dist/index.cjs has no import() of the SDK at all — it was probably bundled (dropped from `external`) rather than loaded.',
    ).toMatch(new RegExp(`import\\("${SDK}"\\)`))
  })
})

// The A3/L4 veto has to survive BUNDLING, not just `npm test`.
//
// WHY THIS FILE EXISTS. `sdkGuardHook.loadGuardEvaluate` used
// `createRequire(import.meta.url)`. esbuild has no import.meta in CJS output and
// substitutes `{}`, so in `server/dist/index.cjs` — the bundle Electron forks in
// the packaged app — that read `undefined`, and `createRequire(undefined)`
// throws. The hook fails CLOSED by design, so the SDK worker preflight failed,
// so **the SDK runtime could not start a single worker in the shipped app**
// while every dev run (real ESM, real import.meta) worked perfectly. Nothing in
// the suite could see it: vitest is ESM too.
//
// esbuild warns about exactly this (`empty-import-meta`). The build silenced the
// warning for an unrelated branch in hooksInstall.ts that really was dead, and
// the silence then covered a live one. So there are two guards here — one for
// the reader, one for the build — and the second one EXECUTES esbuild rather
// than grepping the config, because "the option is spelled correctly" and "the
// shim produces a usable value" are different claims and only the second matters.

import { describe, expect, it } from 'vitest'
import * as esbuild from 'esbuild'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createRequire } from 'module'

const repoRoot = join(__dirname, '..', '..', '..')
const buildScript = join(repoRoot, 'scripts', 'build-server.js')

describe('the guard hook survives the CJS bundle', () => {
  it('createRequire(undefined) throws — the mechanism this file guards against', () => {
    // Pin the premise. If node ever made this tolerant the guards below would
    // still be right, but the story in the header would need rewriting.
    expect(() => createRequire(undefined as unknown as string)).toThrow(TypeError)
  })

  it('sdkGuardHook reads no import.meta — its code runs LIVE in the CJS bundle', () => {
    const src = readFileSync(join(__dirname, 'sdkGuardHook.ts'), 'utf8')
    // Strip the comment that explains the rule so it cannot satisfy itself.
    const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(code).not.toMatch(/import\s*\.\s*meta/)
  })

  it('the build gives import.meta.url a REAL value — measured by running esbuild', async () => {
    const cfg = readFileSync(buildScript, 'utf8')
    // Comments stripped: the config's own explanation quotes the banned option.
    expect(cfg.replace(/\/\/.*$/gm, '')).not.toMatch(/'empty-import-meta':\s*'silent'/)

    // Take the shim the build actually uses, verbatim, and prove it works.
    const banner = cfg.match(/js:\s*"([^"]*__filename[^"]*)"/)?.[1]
    const define = cfg.match(/define:\s*\{\s*'import\.meta\.url':\s*'([^']+)'/)?.[1]
    expect(banner, 'build-server.js must carry an import.meta.url banner').toBeTruthy()
    expect(define, 'build-server.js must define import.meta.url').toBeTruthy()

    const dir = mkdtempSync(join(tmpdir(), 'og-meta-shim-'))
    try {
      writeFileSync(
        join(dir, 'in.mjs'),
        // Exactly what the guard hook does: build a require() from import.meta.url.
        "import { createRequire } from 'module'\n" +
          'export const ok = typeof createRequire(import.meta.url).resolve === "function"\n' +
          'export const url = import.meta.url\n',
      )
      await esbuild.build({
        entryPoints: [join(dir, 'in.mjs')],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        banner: { js: banner!.replace(/\\'/g, "'") },
        define: { 'import.meta.url': define! },
        outfile: join(dir, 'out.cjs'),
        logLevel: 'silent',
      })
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const out = require(join(dir, 'out.cjs')) as { ok: boolean; url: string }
      expect(out.url).toMatch(/^file:\/\//) // NOT undefined, NOT {}
      expect(out.ok).toBe(true) // createRequire accepted it
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

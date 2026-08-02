// THE `.mts` PROBES ARE TYPE-CHECKED, AND THE DEFAULT GATE HAS TO SAY SO.
//
// WHY THIS FILE EXISTS. `spawnSdkSession` now demands proof that the ESM SDK was
// preloaded, as an ARGUMENT, so that forgetting it is a compile error instead of
// a session that dies silently and degrades to a PTY. That argument is only worth
// anything where a compiler looks — and it did not look at the one file that had
// the bug: `scripts/probe-sdk-manager-launch.mts` (the canonical "boot a real
// commander" verifier) called the spawn with no preload, and
//
//   • tsconfig.json's `include` lists `scripts/**/*.ts` — not `.mts`, so all 14
//     scripts/*.mts sat outside `tsc --noEmit` entirely; and
//   • `npm run lint` was `--ext .ts,.tsx`, so it did not read them either.
//
// Measured on review: deleting the proof from that probe left `npx tsc --noEmit`
// at exit 0 with zero errors. The type gate was real for src/ and server/ and
// completely absent for the directory the defect came from.
//
// So `tsconfig.scripts.json` now covers them, and THIS TEST RUNS IT. Adding a
// second tsconfig is not enough on its own: the completion gate everyone actually
// types is `npx tsc --noEmit`, which loads the ROOT project only, so a config
// nobody invokes is a guard nobody has. Running it from the suite means the gate
// that already exists (`npm test`) carries it — the same reasoning that put
// esbuild inside sdkGuardBundleShape.test.ts rather than trusting the config to
// be spelled right. (`npm run typecheck` runs both projects for a human.)
//
// Cost: ~1.8s. That is the price of the directory being checked at all.

import { describe, expect, it } from 'vitest'
import { spawnSync } from 'child_process'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { join, sep } from 'path'
import { REPO_ROOT } from '../../test/repoRootFence'

const scriptsProject = join(REPO_ROOT, 'tsconfig.scripts.json')

describe('scripts/*.mts are inside a type-checked project', () => {
  it('the root project still does NOT cover them — this is why the second one exists', () => {
    // Pin the premise. If the root ever grows `.mts` coverage, this file can go
    // away — but until then, "tsc --noEmit passed" must not be read as "the
    // probes compile", and the next reader deserves to see that stated.
    const root = JSON.parse(
      readFileSync(join(REPO_ROOT, 'tsconfig.json'), 'utf8').replace(/^\s*\/\/.*$/gm, ''),
    ) as { include: string[] }
    expect(
      root.include.some((p) => p.includes('.mts')),
      'tsconfig.json now covers .mts itself — that is an IMPROVEMENT, not a regression. ' +
        'If `npx tsc --noEmit` alone checks the probes, tsconfig.scripts.json and this ' +
        'whole test file can be deleted; just keep some gate running over scripts/*.mts.',
    ).toBe(false)
  })

  it('every scripts/*.mts type-checks', () => {
    expect(existsSync(scriptsProject), 'tsconfig.scripts.json is missing').toBe(true)
    const r = spawnSync(
      process.execPath,
      [join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '-p', scriptsProject],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    )
    expect(
      r.status,
      `scripts/*.mts do not type-check:\n${(r.stdout ?? '').trim() || (r.stderr ?? '').trim()}`,
    ).toBe(0)
  })

  it('EVERY scripts/*.mts is in that project — not just the config file', () => {
    // The config could `include` a glob that matches nothing (a rename, a moved
    // directory) and this suite would keep passing on an empty program. Ask the
    // compiler which files it loaded instead of trusting the glob.
    //
    // And count them against the directory, not just spot-check the one file that
    // had the bug: an `include` narrowed to a single probe would satisfy a
    // spot-check while quietly dropping the other thirteen back out of coverage —
    // which is the exact shape of the hole this file exists to close.
    const r = spawnSync(
      process.execPath,
      [
        join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
        '--noEmit',
        '-p',
        scriptsProject,
        '--listFiles',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    )
    const onDisk = readdirSync(join(REPO_ROOT, 'scripts')).filter((f) => f.endsWith('.mts'))
    const loaded = (r.stdout ?? '')
      .split('\n')
      .map((f) => f.trim())
      .filter((f) => f.endsWith('.mts') && f.includes(`${sep}scripts${sep}`))

    expect(
      loaded.some((f) => f.endsWith('probe-sdk-manager-launch.mts')),
      'the probe that carried the defect is not in the type-checked project',
    ).toBe(true)
    expect(onDisk.length, 'no scripts/*.mts found at all — did the directory move?').toBeGreaterThan(0)
    expect(
      loaded.length,
      `tsconfig.scripts.json covers ${loaded.length} of the ${onDisk.length} scripts/*.mts on disk. ` +
        `Uncovered: ${onDisk.filter((f) => !loaded.some((l) => l.endsWith(f))).join(', ')}`,
    ).toBe(onDisk.length)
  })
})

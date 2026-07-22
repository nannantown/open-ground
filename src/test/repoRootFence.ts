// The repo working tree is not scratch space. This fence watches the RESULT.
//
// A test that leaves something at the repo root makes `git status` dirty unless
// .gitignore matches it, and here a dirty tree is not cosmetic: swarm
// integration refuses it (a worker must commit before handing over), and on
// 2026-07-19 a `git add -A` swept a concurrent subagent's temp edit into HEAD
// and left a safety net disarmed for about a minute.
//
// WHY THIS IS NOT A SOURCE SCAN. The first two attempts at these teeth read the
// source. The first pinned a const's VALUE (`REPO_PROBE_PREFIX`), so a probe
// arriving with its own literal was invisible. The second pinned the ACT, but
// only as SPELLED — it needed a literal `join(` within 8 characters of a verb
// drawn from a list of six. Adversarial review planted four rewrites of one
// forbidden write and measured all four GREEN (2026-07-20):
//
//   const rootAlias = REPO_ROOT; mkdirSync(join(rootAlias, 'x'))  → alias unseen
//   const p = join(REPO_ROOT, 'x'); mkdirSync(p)                  → join too far
//   writeFileSync(`${REPO_ROOT}/x`, 'y')                          → no join at all
//   appendFileSync(join(REPO_ROOT, 'x'), 'y')                     → verb not listed
//
// Every one of those is the same act. A checker that reads source is arguing
// with an infinite supply of spellings and quietly loses, which is worse than
// having no checker: it reports "no violations" and is believed.
//
// So this looks at the directory instead. One `readdirSync` of the repo root
// after every test, diffed against what was there when the file started. It
// cannot be out-spelled, it does not care which verb ran, it covers writes made
// by CHILD PROCESSES (git, tsx, a nested vitest) that no in-process hook can
// see, and it names the test that was running when the entry appeared.
//
// WHAT IT CANNOT SEE, stated because the previous two versions of these teeth
// were believed to cover more than they did: an entry that is created AND
// removed inside a single `it()` never survives to be observed. That window is
// real — a concurrent `git status` can still catch it — and it is the shape the
// original bug had in its happy path. It is covered separately, and only
// best-effort, by the source sweep in src/testHomeEnvGuard.test.ts, whose own
// limits are stated there. Neither layer is universal; between them the four
// rewrites above are all red, which is the property that was missing.

import { existsSync, readdirSync } from 'fs'
import { join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { afterEach, expect } from 'vitest'

/**
 * Preferred from THIS FILE rather than process.cwd(), because siblings call
 * chdir() — but `import.meta.url` is NOT always a file: URL here. setup-home.ts
 * imports this module for EVERY test file, and the ones running under
 * `@vitest-environment jsdom` are served over http:, where `fileURLToPath`
 * throws "The URL must be of scheme file". Measured 2026-07-20: the first
 * version of this line took out all 51 jsdom files at collection time (55 files
 * failed, 5253 of 5711 tests even collected) — a fence that breaks the suite it
 * is meant to protect.
 *
 * So: file URL when there is one, cwd otherwise, and VALIDATE either way. The
 * validation is the point — a fence pointed at the wrong directory watches
 * nothing and stays green forever, so an unrecognisable answer throws instead.
 */
const resolveRepoRoot = (): string => {
  const looksLikeRepo = (dir: string): boolean =>
    existsSync(join(dir, 'package.json')) &&
    existsSync(join(dir, '.gitignore')) &&
    existsSync(join(dir, 'src'))

  const tried: string[] = []
  try {
    const url = new URL('../..', import.meta.url)
    if (url.protocol === 'file:') tried.push(resolve(fileURLToPath(url)))
  } catch {
    // Not a usable URL at all — fall through to cwd.
  }
  tried.push(resolve(process.cwd()))
  for (const dir of tried) if (looksLikeRepo(dir)) return dir
  throw new Error(
    `[repoRootFence] cannot locate the repo root (tried: ${tried.join(', ')}).\n` +
      `Refusing to install a working-tree fence pointed at an unknown directory — it ` +
      `would report "no residue" forever. If the tree was reorganised, update ` +
      `looksLikeRepo() here.`,
  )
}

export const REPO_ROOT = resolveRepoRoot()

/**
 * The one name a test may create at the repo root, matched by
 * `/.og-fence-probe-*` in .gitignore. There IS a legitimate reason to write
 * here — proving a home is "not a temp path" needs a path that is not temp, and
 * every OS temp location is trusted by construction — but it has to be a name
 * git already ignores, so a killed run cannot dirty the tree.
 *
 * Declared HERE, and imported by the tests that build such probes, so the name
 * and the rule cannot drift apart. They already did once: the .gitignore line
 * covered the probe its author had just written and not the one that had been
 * dirtying the repo root for eleven hours.
 */
export const REPO_PROBE_PREFIX = '.og-fence-probe-'

/** Array rather than Set at the seam: this tsconfig has no downlevelIteration. */
const readRepoRoot = (): string[] => {
  try {
    return readdirSync(REPO_ROOT)
  } catch (err) {
    // Never report "no residue" for a scan that did not happen — the failure
    // this whole chapter keeps re-learning.
    throw new Error(
      `[repoRootFence] cannot list the repo root (${REPO_ROOT}): ${String(err)}\n` +
        `Refusing to pass a residue check that never ran.`,
    )
  }
}

/** Entries present when the current test file started. Mutated as we report. */
let known = new Set<string>()

/** Names that appeared since the baseline and are not the sanctioned probe. */
export const unsanctionedResidue = (baseline: Set<string> = known): string[] =>
  readRepoRoot()
    .filter((name) => !baseline.has(name))
    .filter((name) => !name.startsWith(REPO_PROBE_PREFIX))

const describeTest = (): string => {
  try {
    const s = expect.getState()
    return `${s?.testPath ?? '(unknown file)'} — ${s?.currentTestName ?? '(unknown test)'}`
  } catch {
    return '(unknown test)'
  }
}

/**
 * Registers the per-test residue check. Called once from setup-home.ts, so it
 * wraps every test file in the run.
 *
 * Per-test rather than at the end of the suite ON PURPOSE: vitest runs files in
 * parallel, so a single check at the end is a race — it would see residue only
 * if the offending file happened to finish first. Per-test, the file that
 * created the entry reaches its own next hook and reports it.
 */
export const installRepoRootFence = (): void => {
  known = new Set(readRepoRoot())
  afterEach(() => {
    const found = unsanctionedResidue()
    if (!found.length) return
    // Absorb before throwing, so one stray entry produces ONE red instead of
    // failing every remaining test in the file. Nothing is deleted: this
    // process did not necessarily create it, and removing a file we cannot
    // prove is ours is a worse failure than reporting it.
    for (const name of found) known.add(name)
    throw new Error(
      [
        `[repoRootFence] a test left something at the REPO ROOT that .gitignore does not cover.`,
        `  appeared:    ${found.join(', ')}`,
        `  after:       ${describeTest()}`,
        `  repo root:   ${REPO_ROOT}`,
        ``,
        `  An untracked entry here makes \`git status\` dirty, which BLOCKS swarm`,
        `  integration (a worker must hand over a clean tree) and can be swept into a`,
        `  commit by \`git add -A\` — that happened on 2026-07-19 and disarmed a safety`,
        `  net for about a minute.`,
        ``,
        `  FIX: build it under tmpdir(). If it genuinely cannot be a temp path — the`,
        `  only real case is proving a home is NOT temp, since every OS temp location`,
        `  is trusted by construction — name it with REPO_PROBE_PREFIX`,
        `  ("${REPO_PROBE_PREFIX}", from src/test/repoRootFence.ts) so .gitignore covers it,`,
        `  and still remove it in a finally.`,
        ``,
        `  Tests run in parallel: the file named above is where the check fired, which`,
        `  is not always the file that wrote the entry. If YOU created it by hand while`,
        `  the suite was running, that is what this is.`,
      ].join('\n'),
    )
  })
}

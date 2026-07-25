// Repo guard: NO test may unset OPENGROUND_HOME or HOME.
//
// `openGroundHome()` (src/lib/server/paths.ts) falls back to the user's real
// `~/.openground` when OPENGROUND_HOME is empty. vitest reuses worker processes
// across test files, so a single `delete process.env.OPENGROUND_HOME` in one
// file's afterEach aims every later write in that process at the user's
// irreplaceable data — the project registry among it.
//
// This is not hypothetical. On 2026-07-19 a plain `npm test` rewrote the real
// settings.json with storeSettingsRace.test.ts's literals (`archiveDirName:
// '_arc'`, `projectsMigratedAt: '2026-01-02T03:04:05.000Z'`); the file was
// verified clean 12 minutes earlier. The same class of leak is the leading
// explanation for the 2026-07-18 loss of the project registry (45 → 3 entries),
// because registry.test.ts and collabLink.test.ts write
// `setSettings({ projects: [] })`, which on the real home empties it.
//
// paths.ts now ALSO throws when the var is unset under vitest (fail-closed), so
// a leak fails loudly rather than silently. This test is the second layer: it
// stops the pattern being reintroduced, and it names the safe alternative.
//
// THE RULE: never `delete` these vars. Restore them to an isolated directory, or
// simply leave them pointing at the (possibly removed) temp dir — that is inert,
// while unset is not. Every other env var is fine to unset.

import { describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { REPO_PROBE_PREFIX, REPO_ROOT, unsanctionedResidue } from './test/repoRootFence'

const repoRoot = join(__dirname, '..')

// Every directory that can end up executing in a process that also runs app
// code. `src` and `server` are what vitest currently collects, but a guard
// scoped to today's include list stops guarding the moment that list grows —
// so sweep the whole tree instead (nit, review 2026-07-19).
const SWEPT_DIRS = ['src', 'server', 'scripts', 'electron', 'perf', 'e2e', 'worker']

/** A swept file and its source, read once and shared by every scan below.
 *
 *  `--others` (untracked, minus gitignored) is deliberate: a file planted to
 *  prove a guard has teeth must be seen BEFORE `git add`, and so must a real
 *  offender written five minutes ago.
 *
 *  `.js/.cjs/.mjs` too — SWEPT_DIRS names `electron` and `scripts`, whose code
 *  is JavaScript, so a `*.ts`-only pathspec swept two directories it could not
 *  see into while a reader took them as covered (review 2026-07-20).
 *
 *  Reading in JS rather than shelling out to grep is also load-bearing, and not
 *  just for convenience: `scripts/openground-guard.js` carries three literal NUL
 *  bytes, so grep calls it binary and reports NOTHING for it without `-a`
 *  (measured 2026-07-20: `grep -c homedir` → exit 1, `grep -ac homedir` → 1;
 *  identical under LC_ALL=C and en_US.UTF-8, so it is the NULs, not a non-ASCII
 *  false alarm). A grep-based scan would skip a 108KB file in silence — and
 *  silence is indistinguishable from "clean" in exactly the way this suite keeps
 *  being bitten by. */
type SweptFile = { rel: string; src: string }

/** Source extensions, decided HERE rather than by a git pathspec.
 *
 *  A pathspec of `*.ts *.tsx *.js *.cjs *.mjs` reads like "all source", and an
 *  adversarial pass on 2026-07-20 showed it is not: `.mts`, `.cts` and `.jsx`
 *  fall straight through it, and a probe planted as `__probe.mts` was invisible
 *  while the identical `.ts` went red. Moving the decision into JS makes it a
 *  value a test can assert on — which the teeth below do. */
const SOURCE_EXT = /\.(?:m|c)?[jt]sx?$/

let repoCache: SweptFile[] | null = null
/** EVERY source file git knows about, repo-wide — no directory filter.
 *
 *  `--others` (untracked, minus gitignored) is deliberate: a file planted to
 *  prove a guard has teeth must be seen BEFORE `git add`, and so must a real
 *  offender written five minutes ago.
 *
 *  Reading in JS rather than shelling out to grep is load-bearing, and not just
 *  for convenience: `scripts/openground-guard.js` carries three literal NUL
 *  bytes, so grep calls it binary and reports NOTHING for it without `-a`
 *  (measured 2026-07-20: `grep -c homedir` → exit 1, `grep -ac homedir` → 1;
 *  identical under LC_ALL=C and en_US.UTF-8, so it is the NULs, not a non-ASCII
 *  false alarm). A grep-based scan would skip a 108KB file in silence — and
 *  silence is indistinguishable from "clean" in exactly the way this suite keeps
 *  being bitten by. */
const repoSourceFiles = (): SweptFile[] => {
  if (repoCache) return repoCache
  const rels = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
    .split('\0')
    .filter((rel) => rel.length > 0 && SOURCE_EXT.test(rel))
  repoCache = []
  for (const rel of rels) {
    let src: string
    try {
      src = readFileSync(join(repoRoot, rel), 'utf8')
    } catch (err) {
      // ENOENT is a NORMAL transient: `--cached` lists a tracked file the user
      // has deleted mid-refactor, and a dangling symlink reads the same way.
      // Neither has content, so neither can hide a violation — skipping is
      // honest here, where "skip quietly" would not be for, say, EACCES. Before
      // this, a plain `rm src/lib/x.ts` without `git rm` blew up three tests
      // with a bare ENOENT and no hint of why (adversarial review round 2).
      if ((err as { code?: string }).code === 'ENOENT') continue
      throw new Error(
        `[testHomeEnvGuard] cannot read ${rel} (${(err as { code?: string }).code ?? err}) — ` +
          `refusing to report "no violations" for a file the sweep could not open.`,
      )
    }
    repoCache.push({ rel, src })
  }
  return repoCache
}

/** The SWEPT_DIRS slice of the above, PLUS the repo root — ONE list, shared by
 *  the unset sweep and the resolver sweep below.
 *
 *  That sharing is the point. The two guards ask different questions of the SAME
 *  tree and must not disagree about which files that tree contains. They did:
 *  the resolver half enumerated `.ts/.tsx/.js/.cjs/.mjs` through git while the
 *  unset half shelled out to `grep --include=*.ts --include=*.tsx`. SWEPT_DIRS
 *  names `scripts`, `electron` and `worker` — three directories whose code is
 *  JavaScript — so the unset half swept them in NAME ONLY, and a reader
 *  comparing the two lists would take them as covered (review 2026-07-20).
 *
 *  Root level (`!rel.includes('/')`), not a recursive walk of the whole repo:
 *  `vitest.config.ts` wires `setupFiles` — the entire isolation bootstrap — and
 *  no directory in SWEPT_DIRS contains it, so both sweeps were blind to the one
 *  file that ARMS them. Delete that array entry, or add a `globalSetup` that
 *  clears a home var, and every guard here stays green. `vite.config.ts` already
 *  reads `process.env.OPENGROUND_*`, so this is not a theoretical class of file
 *  (adversarial review 2026-07-20). Measured cost of including the root
 *  (2026-07-21): +5 files — playwright/postcss/tailwind/vite/vitest configs —
 *  and 0 new offenders in either sweep.
 *
 *  The two "is this list real?" checks live HERE rather than in one caller, so
 *  both sweeps inherit them. They did not: the precheck sat inside the unset
 *  half, and a renamed `src` therefore threw from that half while the resolver
 *  half — whose sanctioned COUNTS are only checked for files the enumeration
 *  actually returned — reported a serene `[]` for a tree it never opened. Same
 *  asymmetry as the file lists themselves, one level up. */
let sweptCache: SweptFile[] | null = null
const sweptSourceFiles = (): SweptFile[] => {
  if (sweptCache) return sweptCache
  // EXISTENCE PRECHECK — do not let a stale SWEPT_DIRS entry silently NARROW the
  // sweep. The prefix filter below simply matches nothing for a directory that
  // was renamed away, and both guards then report "no violations" for a tree
  // they never looked at. Measured under the old grep implementation on
  // 2026-07-19 (adversarial review): renaming `src` away left the guard GREEN
  // with a real planted violation. The mechanism changed — the list is built in
  // JS now, so there is no grep exit code to misread and no BSD-vs-GNU
  // divergence to be bitten by — but the failure mode did not, so it stays.
  const missing = SWEPT_DIRS.filter((d) => !existsSync(join(repoRoot, d)))
  if (missing.length) {
    throw new Error(
      `[testHomeEnvGuard] cannot sweep ${missing.join(', ')} — the directory is missing. ` +
        `Refusing to report "no violations" for a scan that would silently skip it. ` +
        `If the tree was reorganised, update SWEPT_DIRS in this file.`,
    )
  }
  const swept = repoSourceFiles().filter(
    ({ rel }) =>
      !rel.includes('/') || SWEPT_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`)),
  )
  // A directory that exists but contributes NOTHING means the enumeration is
  // lying about covering it — a broken filter, a dir holding only extensions we
  // do not sweep, or a git that returned less than it should. Existence alone
  // does not prove reachability, and this is the cheap standing proof that it is
  // reachable. Every SWEPT_DIRS entry holds source today (smallest: perf, 4).
  const empty = SWEPT_DIRS.filter((d) => !swept.some(({ rel }) => rel.startsWith(`${d}/`)))
  if (empty.length) {
    throw new Error(
      `[testHomeEnvGuard] ${empty.join(', ')} exists but the file enumeration returned ` +
        `nothing under it — the sweep would cover it in name only. Refusing to report ` +
        `"no violations". Check SOURCE_EXT and the git ls-files call, or drop the ` +
        `directory from SWEPT_DIRS.`,
    )
  }
  sweptCache = swept
  return swept
}

// ─── Shared line helpers — declared once, used by every sweep in this file ───

/** The code on a line, with any leading block-comment fragment removed.
 *
 *  Returning '' means "no code here". The strip matters: writing the whole line
 *  off because it begins with an asterisk let a probe put a block-comment
 *  terminator in front of a real write and stay green (adversarial review,
 *  2026-07-20). (Spelling that terminator out here would end this comment —
 *  the self-reference trap, once more, with feeling.) */
const codeOf = (raw: string): string => {
  let t = raw.trim()
  const close = t.startsWith('*') || t.startsWith('/*') ? t.lastIndexOf('*/') : -1
  if (close >= 0) t = t.slice(close + 2).trim()
  if (!t || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return ''
  return t
}

/** Prose about a rule is not a violation of it — the judgement all three sweeps
 *  make, now made in ONE place.
 *
 *  Defined as "codeOf found no code", so an inline block-comment pragma followed
 *  by a real resolver on the same line is NOT prose. That shape was a
 *  20-character bypass while any line merely BEGINNING with a block-comment
 *  opener counted as a comment (adversarial review 2026-07-20). The `.claude`
 *  sweep learned it first; sharing the helper is what stops the other two
 *  re-learning it. */
const isProse = (line: string): boolean => codeOf(line) === ''

/** 1-based, computed only for actual hits — never once per line. */
const lineNumberAt = (src: string, index: number): number => {
  let n = 1
  for (let i = 0; i < index; i++) if (src.charCodeAt(i) === 10) n++
  return n
}

/** The line with any trailing `// …` removed, offsets before it PRESERVED (so a
 *  caller can still index into it). Distinct from `codeOf`, which trims. */
const beforeLineComment = (line: string): string => {
  const at = line.indexOf('//')
  return at === -1 ? line : line.slice(0, at)
}

// ─── Sweep 1: leaving a home var unset ───────────────────────────────────────

const UNSET_PATTERNS: RegExp[] = [
  /delete\s+process\.env\.OPENGROUND_HOME/g,
  /delete\s+process\.env\.HOME/g,
  /delete\s+process\.env\[/g,
  // vi.stubEnv(name, undefined) DELETES the var (vitest's own impl:
  // `else if (value === void 0) delete env[name]`), so it is the same act
  // spelled differently — and the three patterns above never saw it.
  // Found by adversarial review 2026-07-19. Matched against the WHOLE source
  // rather than line by line, so a prettier-wrapped call is not a way out; `\s`
  // spans newlines, and the line-scoped grep this replaced could not.
  /stubEnv\(\s*['"`](?:OPENGROUND_HOME|HOME)['"`]\s*,\s*undefined/g,
  // `const env = process.env; delete env.HOME` — aliasing the object is an
  // ordinary JS idiom (and `const { env } = process` even more so), while the
  // three patterns above hard-require the literal `process.env`. Restricted to
  // an identifier actually spelled `env`: a looser form would match
  // `delete arr[0]` in any file. Measured 0 hits repo-wide (2026-07-20).
  /delete\s+(?!process\s*\.)\benv\s*(?:\.\s*(?:OPENGROUND_HOME|HOME)\b|\[)/g,
  // Replacing the object wholesale drops BOTH home vars at once, and reads as
  // hygiene rather than as a delete.
  /process\.env\s*=\s*[{[]/g,
  // The BLANK spelling. paths.ts falls back with `||`, not `??`, so `''` is as
  // unset as `undefined` — this file's own opening line says the fallback fires
  // "when OPENGROUND_HOME is empty" and no pattern looked for it. The runtime
  // fence does catch it (reported as BLANK), so this layer's job here is to name
  // the file and the safe alternative instead of throwing from an unrelated
  // later test.
  /(?:process\.env\.(?:OPENGROUND_HOME|HOME)\s*=|stubEnv\(\s*['"`](?:OPENGROUND_HOME|HOME)['"`]\s*,)\s*(?:''|""|``)/g,
]

/** Pure matcher — takes source text, so it can be exercised on fixtures. */
const unsetOffendersIn = (rel: string, src: string): string[] => {
  const lines = src.split('\n')
  const seen = new Set<string>()
  const out: string[] = []
  for (const re of UNSET_PATTERNS) {
    re.lastIndex = 0
    for (;;) {
      const m = re.exec(src)
      if (!m) break
      const lineNo = lineNumberAt(src, m.index)
      const text = (lines[lineNo - 1] ?? '').trim()
      // The five files that quote the pattern are exempted by name below because
      // they quote it in STRING LITERALS too (error messages that tell the
      // offender what to stop doing); this only drops comments, which no runtime
      // can execute.
      if (isProse(text)) continue
      const key = `${rel}:${lineNo}:${re.source}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(`${rel}:${lineNo}:${text}`)
    }
  }
  return out
}

/** Every line that could leave a home var unset, minus the sanctioned ones. */
let unsetCache: string[] | null = null
const offendingLines = (): string[] => {
  if (unsetCache) return unsetCache
  const found: string[] = []
  for (const { rel, src } of sweptSourceFiles()) found.push(...unsetOffendersIn(rel, src))
  unsetCache = found.filter((line) => {
    const [file] = line.split(':', 1)
    // This file quotes the pattern in prose, in its own match patterns, and in
    // the fixtures that prove those patterns have teeth.
    if (file === 'src/testHomeEnvGuard.test.ts') return false
    // These three document/enforce the rule; none of them unsets. testHomeGuard.ts
    // is the fence itself — it quotes the forbidden pattern in its header and,
    // more importantly, prints it back in the FIX line of its own error message,
    // which is the whole point (telling the offender what to stop doing).
    if (
      file === 'src/lib/server/paths.ts' ||
      file === 'src/test/setup-home.ts' ||
      file === 'src/lib/server/testHomeGuard.ts'
    )
      return false
    // The fence's own teeth test. Proving "an unset var throws" requires
    // unsetting it, exactly as this file does at its own sanctioned site
    // above — so the same exemption applies, for the same reason. It is
    // CONTAINED, and that was verified rather than assumed: a file-level
    // beforeEach saves OPENGROUND_HOME and its afterEach restores it, and
    // vitest's reverse hook order runs that restore BEFORE setup-home.ts's
    // re-verification. A careless future delete there is still caught at
    // runtime — setup-home.ts's afterEach throws and names the file.
    if (file === 'src/lib/server/testHomeGuard.test.ts') return false
    // The sanctioned generic form, which explicitly skips the home vars.
    if (line.includes("['OPENGROUND_HOME', 'HOME'].includes(")) return false
    // The gate's env BUILDERS (`gateEnvFor` / `buildGateEnv`), found by the
    // aliased-`env` pattern the moment it was added — the old `delete
    // process.env[` never saw them. Sanctioned on SHAPE, not by filename, so it
    // survives a move and does not blind the rest of those files:
    //   * both delete from a FRESH COPY (`{ ...base, … }` / `Object.assign({},
    //     base, …)`), never from process.env — the doc comment on gateEnvFor
    //     says "no mutation of `base`". Nothing about the running process moves.
    //   * `isStrippedKey` cannot reach a home var anyway. Verified rather than
    //     assumed (2026-07-20): neither GATE_ENV_FORBIDDEN nor GATE_ENV_HERMETIC
    //     lists HOME / OPENGROUND_HOME, and SECRET_NAME_RE
    //     (SERVICE_ROLE|SECRET|PASSWORD|PASSWD|PRIVATE|TOKEN|KEY|CREDENTIAL)
    //     matches neither. The gate REDIRECTS the home instead — gateRedirects()
    //     sets OPENGROUND_HOME to the throwaway, and its own comment says
    //     "Redirect, don't unset: unset is the homedir fallback".
    if (line.includes('isStrippedKey(')) return false
    return true
  })
  return unsetCache
}

describe('repo guard — tests must never unset a home env var', () => {
  it('has no `delete process.env.OPENGROUND_HOME` / `.HOME` anywhere', () => {
    const bad = offendingLines().filter(
      (l) => l.includes('delete process.env.OPENGROUND_HOME') || l.includes('delete process.env.HOME'),
    )
    expect(
      bad,
      `Unsetting a home var points every later write in this worker process at the user's REAL ~/.openground.\n` +
        `Restore it to an isolated temp dir instead (or just leave it set).\n\n${bad.join('\n')}`,
    ).toEqual([])
  })

  it('has no computed `delete process.env[k]` that could reach a home var', () => {
    const bad = offendingLines().filter((l) => l.includes('delete process.env['))
    expect(
      bad,
      `A computed delete can reach OPENGROUND_HOME / HOME. Guard it:\n` +
        `  else if (!['OPENGROUND_HOME', 'HOME'].includes(k)) delete process.env[k]\n\n${bad.join('\n')}`,
    ).toEqual([])
  })

  it('has no `vi.stubEnv(<home var>, undefined)` — the other spelling of unset', () => {
    // vitest's stubEnv DELETES when the value is undefined
    // (`else if (value === void 0) delete env[name]`), and it writes through to
    // process.env — proven inside this repo by testHomeGuard.test.ts, which
    // stubs OPENGROUND_HOME and has paths.openGroundHome() observe it. A guard
    // that bans one spelling of an act and not the other is a guard with a
    // documented name and an undocumented hole. Found by review 2026-07-19.
    const bad = offendingLines().filter((l) => l.includes('stubEnv'))
    expect(
      bad,
      `vi.stubEnv('OPENGROUND_HOME', undefined) unsets it just as surely as delete.\n` +
        `Stub an isolated temp dir instead.\n\n${bad.join('\n')}`,
    ).toEqual([])
  })

  // THE AUTHORITATIVE ONE. The three assertions above are diagnostics: each
  // re-filters the reported line TEXT by an exact substring with a single space
  // in it, while the patterns match `\s+`. So `delete  process.env.HOME` (two
  // spaces), a tab, or a call wrapped across lines was FOUND by the sweep and
  // then routed to none of the three buckets — three green tests over a real
  // hit, with no residual bucket and nothing asserting the partition was total
  // (adversarial review 2026-07-20; measured with all three spellings). Every
  // pattern added later inherits the same gap by default, so the set is asserted
  // whole here and the buckets exist only to give a better message.
  it('reports NOTHING at all — the buckets above are a filter, not a partition', () => {
    const bad = offendingLines()
    expect(
      bad,
      `The sweep found something no other assertion in this file claims.\n` +
        `Either it is a real unset (fix it: restore the saved value instead), or a\n` +
        `new sanctioned form (add it to the filter in offendingLines, with a reason).\n\n${bad.join('\n')}`,
    ).toEqual([])
  })
})

// ─── Sweep 2: exactly ONE home resolver ──────────────────────────────────────
//
// The fence is a choke-point argument: it works because `paths.openGroundHome()`
// is the only thing that turns "where is the OPEN GROUND home?" into a path. A
// second, inline home-derived expression anywhere else routes around it
// completely — no throw, no trace.
//
// That is not hypothetical. `swarmTokenAudit.mainRepoForWorktreeCwd` carried
// exactly such a copy, and inside an armed vitest process it READ the user's real
// ~/.openground/settings.json and returned a genuinely registered project path.
// It was fixed by hand — and reverting the fix and running all 276 files still
// passed, because nothing checked. "I re-scanned and found none" is a one-time
// assurance; this is the standing one (review nit, 2026-07-19).

// Every spelling of "the user's home" this repo can produce.
//
// Anchoring on the single string `homedir()` made the check a SPELL-CHECKER for
// one function rather than a guard on the ACT (review 2026-07-20) — and this
// file already knew better two blocks down, where `BROAD_HOME` lists six
// spellings for the `~/.claude` inventory. Two sweeps in one file disagreeing
// about what "home" looks like is the same asymmetry as the file lists above,
// one layer in.
//
// `\bhomedir\b` rather than `homedir()`: `userInfo().homedir` is the form
// testHomeGuard.ts uses for the passwd home — chosen deliberately, because
// `homedir()` follows `$HOME` and the fence's baseline must not — so the next
// copy is likelier to be spelled the newer way than the old one, and it would
// have been invisible. The word form covers it, `os.homedir`, and `homedir ()`
// with a space, which is why `userInfo\s*\(` is NOT listed separately (it would
// add false-positive surface and no detection — the same finding the `.claude`
// sweep recorded when it dropped its own `userInfo(` entry).
//
// REGEX sources rather than fixed strings, for two measured reasons:
// `process.env[ `HOME` ]` with backticks or padding walked past the string form,
// and a bare `env.HOME` substring also matched `process.env.HOMEBREW_PREFIX` (a
// false anchor). Escaped sources additionally cannot match themselves, which is
// what the old `'homedir' + '()'` assembly was there for — the self-reference
// trap this suite keeps re-learning.
const HOME_ANCHOR_SOURCES = [
  '\\bhomedir\\b', //                         os.homedir() / userInfo().homedir / homedir ()
  'env\\s*\\.\\s*HOME\\b', //                 process.env.HOME (\b so OPENGROUND_HOME is not one)
  'env\\s*\\[\\s*[\'"`]HOME[\'"`]\\s*\\]', // process.env['HOME'] / ["HOME"] / [`HOME`]
  '\\bUSERPROFILE\\b', //                     win32
  '\\bHOMEPATH\\b', //                        win32's sibling spelling
  'getPath\\s*\\(\\s*[\'"`]home', //          Electron app.getPath('home'); electron/ is only now swept
]

// Assembled, never spelled out: written literally this would make the file its
// own top offender (the self-reference trap this suite keeps re-learning).
const OG_DIR = '.' + 'openground'
// Trailing (?![\w-]) so `.openground-fence-probe-*` and friends do not count.
const ogDirRe = new RegExp(`\\${OG_DIR}(?![\\w-])`)
// An ASSIGNMENT to a home var is the SANCTIONED act: pinning it at a throwaway
// dir is what every isolated test does. READING one to build a path is the
// offence.
const ASSIGNED_TO = /^\s*=[^=]/

// Each precision rule can be switched off — not a feature, a MEASUREMENT seam.
// Ablated over all swept files, re-measured on this tree 2026-07-21: both on →
// 8 sites; assignment off alone → 8; prose off alone → 8; BOTH off → 9, the
// extra being swarmSafety.test.ts. So the two are MUTUALLY REDUNDANT here for
// the single real site, and an earlier draft of this comment claimed otherwise
// from inference rather than ablation — exactly the "green proves nothing"
// mistake §4.9 was written about. Each still covers a shape the other cannot;
// the teeth below remove one rule at a time and require the guard to go red,
// which is the only form of that claim worth writing down.
//
// (The 8 are exactly the six SANCTIONED_SITES files, 1+1+2+1+1+2 — so the
// ablation doubles as a statement that nothing unsanctioned is being suppressed
// by either rule.)
type Rules = { assignment?: boolean; prose?: boolean }

/** Pure matcher — takes source text, so it can be exercised on fixtures. */
const resolverOffendersIn = (rel: string, src: string, rules: Rules = {}): string[] => {
  const skipAssigned = rules.assignment !== false
  const skipProseHit = rules.prose !== false
  const lines = src.split('\n')
  // Plain array + Set, never a Map iterator: spreading one needs
  // downlevelIteration under this tsconfig target (the TS2802 this guard has now
  // hit twice — once on a Set spread, once here).
  const seenLines = new Set<number>()
  const sites: { line: number; text: string }[] = []
  // One entry per SITE: several anchors can name the same home on one line
  // (`process.env.HOME ?? homedir()`), and reporting it twice reads as two holes.
  const add = (line: number, note: string) => {
    if (seenLines.has(line)) return
    seenLines.add(line)
    sites.push({ line, text: `${rel}:${line} — ${note}${(lines[line - 1] ?? '').trim()}` })
  }
  const isAnchored = (text: string): boolean =>
    HOME_ANCHOR_SOURCES.some((s) => new RegExp(s).test(text))

  for (const source of HOME_ANCHOR_SOURCES) {
    const anchor = new RegExp(source, 'g')
    for (;;) {
      const m = anchor.exec(src)
      if (!m) break
      const at = m.index
      const end = at + m[0].length
      // Prose about the rule is not a violation of it — and that holds for BOTH
      // ends. Judged on the line each end starts on, which is where a comment
      // marker would sit. Checking only the anchor's line was enough while the
      // anchor was always a call; once `process.env.HOME` became one, a correct
      // pin followed by an explanatory comment matched through the comment.
      const anchorLine = lineNumberAt(src, at)
      const lineText = lines[anchorLine - 1] ?? ''
      if (isProse(lineText)) continue

      // 24 chars, not 8: a column-aligned `process.env.HOME        = tmp` is
      // still a pin, and the narrow window reported it (review nit 2026-07-20).
      if (skipAssigned && ASSIGNED_TO.test(src.slice(end, end + 24))) {
        // Assigning to a home var is the sanctioned PIN — UNLESS the value comes
        // from another home expression. `process.env.HOME = userInfo().homedir`
        // re-points $HOME at the REAL home for every later file in the worker:
        // strictly worse than the reads this sweep hunts, and invisible to both
        // rules until now (adversarial review 2026-07-20).
        //
        // The RHS is read to end-of-line with any trailing `//` stripped,
        // because a legitimate pin is often annotated — measured on
        // swarmSessions.test.ts:86, `process.env.HOME = claudeHome //
        // os.homedir() honours $HOME on POSIX`, which would otherwise report
        // itself for the text of its own explanation.
        const lineStart = src.lastIndexOf('\n', at - 1) + 1
        const code = beforeLineComment(lineText)
        const eq = code.indexOf('=', end - lineStart)
        const rhs = eq === -1 ? '' : code.slice(eq + 1)
        if (rhs && isAnchored(rhs)) {
          add(anchorLine, 'pins a home var FROM another home expression — ')
        }
        continue
      }

      // WHOLE-FILE scan with a bounded window, not line-by-line. Prettier splits
      // a long call, and `join(\n  homedir(),\n  '.openground',\n)` is the same
      // resolver. 120 chars is comfortably more than any wrapped form and far
      // short of matching an unrelated `.openground` later in the file. It is
      // also the documented LIMIT: bind the home to a variable first and the
      // literal falls outside the window (§3 of the contract).
      const window = src.slice(at, at + 120)
      const hit = ogDirRe.exec(window)
      if (!hit) continue
      const hitLine = lineNumberAt(src, at + hit.index)
      if (skipProseHit && isProse(lines[hitLine - 1] ?? '')) continue
      add(anchorLine, '')
    }
  }
  return sites.sort((a, b) => a.line - b.line).map((s) => s.text)
}

describe('repo guard — exactly one OPEN GROUND home resolver', () => {
  it('has no second home-derived resolver outside the choke point', () => {
    // Sanctioned, and each for a stated reason — not "these were noisy":
    //   paths.ts          the choke point itself; this IS the one resolver.
    //   hooksInstall.ts   builds it to COMPARE (volatileHomes), never to resolve a
    //                     home it then writes through; it is itself a fenced anchor.
    //   gateEnvTamper   invariant F's negative control: it EMBEDS the expression
    //                   as fixture source text (the tampered setup-home.ts it
    //                   writes into a throwaway worktree) and asserts a canary is
    //                   absent from the real home. Both are "name the real path in
    //                   order to prove nothing reached it" — the same category as
    //                   testHomeGuard.ts, one layer out.
    //
    // The plain-JS copies below are sanctioned for a DIFFERENT reason, and it is
    // a limit rather than an exemption: each runs outside the TypeScript module
    // graph — Electron main loads `lockdown.js` as CommonJS, `swarm-lock.js` is a
    // bare `node` script, and `openground-hook.js` is installed into
    // ~/.openground/hooks/ and executed by Claude Code — so none of them CAN
    // import paths.ts at its own runtime. They are structurally unreachable by
    // the choke point, not overlooked by it. The fence is likewise inert there
    // (it only arms inside a test process). Listed in
    // docs/commander/07-test-isolation-contract.md §3 as known second resolvers.
    // Keeping *.js in the sweep is still the point: a NEW copy gets caught.
    //
    // COUNTS, not a skip list. A per-FILE exemption made the pin weaker than the
    // contract claimed: the file was skipped before it was even read, so a NEW
    // resolver added inside lockdown.js was invisible — adversarial review
    // planted exactly that on 2026-07-20 and the guard still reported []. With a
    // count, a new copy inside a sanctioned file changes the number and so does
    // a removed one, which also stops a dead entry rotting here unnoticed.
    const SANCTIONED_SITES: Record<string, number> = {
      'src/lib/server/paths.ts': 1,
      'src/lib/server/hooksInstall.ts': 1,
      'src/lib/server/gateEnvTamper.test.ts': 2,
      'electron/lockdown.js': 1,
      'scripts/swarm-lock.js': 1,
      'scripts/openground-hook.js': 2,
    }
    // NOT read at all, and pinned at no number — the two files where a hit is
    // meaningless rather than allowed:
    //   testHomeEnvGuard.test.ts  its fixtures and anchor sources ARE the
    //                             patterns; pinning it at a count would arm the
    //                             self-reference trap on every future edit.
    //   testHomeGuard.ts          the fence's baseline legitimately builds the
    //                             REAL home, and does it through a local helper
    //                             (`passwdHome()`), which this matcher cannot see
    //                             anyway — pinning 0 would assert a coverage that
    //                             does not exist (§3's stated limit).
    const NOT_SCANNED = ['src/testHomeEnvGuard.test.ts', 'src/lib/server/testHomeGuard.ts']

    const offenders: string[] = []
    for (const { rel, src } of sweptSourceFiles()) {
      if (NOT_SCANNED.includes(rel)) continue
      const hits = resolverOffendersIn(rel, src)
      const allowed = SANCTIONED_SITES[rel]
      if (allowed === undefined) {
        offenders.push(...hits)
      } else if (hits.length !== allowed) {
        offenders.push(
          `${rel} — sanctioned for ${allowed} site(s), found ${hits.length}. ` +
            `Update SANCTIONED_SITES only with a reason:\n${hits.map((h) => `    ${h}`).join('\n')}`,
        )
      }
    }

    expect(
      offenders,
      `A second home resolver bypasses the fence entirely — it is not covered by\n` +
        `anything, because the fence lives at the resolution seam it skipped.\n` +
        `Call paths.openGroundHome() instead.\n\n${offenders.join('\n')}`,
    ).toEqual([])
  })
})

// ─── The two sweeps' own teeth ───────────────────────────────────────────────
//
// A sweep is worth exactly the source text it can see, and both halves above
// report "[]" — the same answer for "nothing is wrong" and for "I looked at
// nothing". The repo assertions cannot tell those apart; these can. They feed
// the two pure matchers synthetic sources, so the coverage claims are STANDING
// assertions rather than a one-time re-scan (which is the very thing the
// resolver sweep was added to replace).
//
// Fixtures are assembled from pieces for the same reason the anchors are: a
// verbatim copy here would be a genuine hit in the one file that must not
// produce them. They are also why this file is on both exemption lists.
describe('repo guard — the sweeps themselves have teeth', () => {
  const DEL = 'delete ' + 'process.env'
  const HOMEDIR = 'homedir' + '()'

  describe('unset sweep', () => {
    it('sees a plain-JS file — scripts/ and electron/ are JavaScript', () => {
      // The hole this replaced: a `grep --include=*.ts --include=*.tsx` over
      // SWEPT_DIRS, which names three JavaScript directories (review 2026-07-20).
      // The enumeration half of that claim is pinned separately, by the
      // extension test the `.claude` sweep already carries.
      expect(unsetOffendersIn('scripts/leak.js', `  ${DEL}.HOME\n`)).toEqual([
        `scripts/leak.js:1:${DEL}.HOME`,
      ])
      expect(unsetOffendersIn('electron/leak.cjs', `${DEL}.OPENGROUND_HOME\n`)).toHaveLength(1)
      expect(unsetOffendersIn('worker/leak.mjs', `${DEL}[k]\n`)).toHaveLength(1)
    })

    it('sees a stubEnv call prettier wrapped across lines', () => {
      const wrapped = ['vi.stubEnv(', "  'OPENGROUND_HOME',", '  undefined,', ')'].join('\n')
      expect(unsetOffendersIn('src/x.test.ts', wrapped)).toHaveLength(1)
    })

    it('sees the spellings that do not say `process.env`', () => {
      // Aliasing the object is ordinary JS, and all three original patterns
      // hard-required the literal `process.env` (adversarial review 2026-07-20).
      expect(
        unsetOffendersIn('scripts/a.js', 'const env = process.env\ndelete env.OPENGROUND_HOME\n'),
      ).toHaveLength(1)
      expect(unsetOffendersIn('scripts/b.js', 'const { env } = process\ndelete env[k]\n')).toHaveLength(
        1,
      )
      // Replacing the object drops both home vars at once.
      expect(unsetOffendersIn('scripts/c.js', 'process.env = { PATH: savedPath }\n')).toHaveLength(1)
    })

    it('sees the BLANK spelling — paths.ts falls back on `||`, so `` is unset', () => {
      expect(unsetOffendersIn('src/x.test.ts', "process.env.OPENGROUND_HOME = ''\n")).toHaveLength(1)
      expect(unsetOffendersIn('src/x.test.ts', "vi.stubEnv('HOME', '')\n")).toHaveLength(1)
    })

    it('does not fire on an unrelated env var, nor on a real pin', () => {
      expect(unsetOffendersIn('src/x.test.ts', `${DEL}.TMPDIR\n`)).toEqual([])
      expect(unsetOffendersIn('src/x.test.ts', "vi.stubEnv('TMPDIR', undefined)\n")).toEqual([])
      expect(unsetOffendersIn('src/x.test.ts', 'process.env.HOME = tmpHome\n')).toEqual([])
      expect(unsetOffendersIn('scripts/d.js', 'delete counts[k]\n')).toEqual([])
    })
  })

  describe('resolver sweep', () => {
    const ogPath = (expr: string) => `const home = join(${expr}, '${OG_DIR}')\n`

    it('catches a resolver spelled without homedir()', () => {
      // The whole point of widening the anchor set: each of these resolves the
      // real home just as surely, and every one was invisible while the key was
      // the single string `homedir()`.
      expect(resolverOffendersIn('src/a.ts', ogPath('userInfo().homedir'))).toHaveLength(1)
      expect(resolverOffendersIn('src/b.ts', ogPath('process.env.HOME'))).toHaveLength(1)
      expect(resolverOffendersIn('src/c.ts', ogPath("process.env['HOME']"))).toHaveLength(1)
      expect(resolverOffendersIn('src/d.ts', ogPath('process.env["HOME"]'))).toHaveLength(1)
      expect(resolverOffendersIn('src/e.ts', ogPath('process.env.USERPROFILE'))).toHaveLength(1)
      expect(resolverOffendersIn('src/e2.ts', ogPath('process.env.HOMEPATH'))).toHaveLength(1)
      // …and the original spelling still is caught.
      expect(resolverOffendersIn('src/f.ts', ogPath(HOMEDIR))).toHaveLength(1)
    })

    it('reports one entry per site even when two anchors name the same home', () => {
      expect(resolverOffendersIn('src/g.ts', ogPath(`process.env.HOME ?? ${HOMEDIR}`))).toHaveLength(
        1,
      )
    })

    it('does not fire on a correct pin followed by prose naming the dir', () => {
      // The measured false positive that the assignment + prose rules exist for
      // (swarmSafety.test.ts:1223).
      const pin = [
        'process.env.HOME = tmpHome',
        `// paths.ts routes ~/${OG_DIR} through OPENGROUND_HOME`,
      ].join('\n')
      expect(resolverOffendersIn('src/h.test.ts', pin)).toEqual([])
    })

    it('does not fire on prose, nor on the fence probe dir', () => {
      expect(resolverOffendersIn('src/i.ts', `// ${ogPath(HOMEDIR)}`)).toEqual([])
      expect(
        resolverOffendersIn('src/j.ts', `const p = join(${HOMEDIR}, '${OG_DIR}-fence-probe-1')\n`),
      ).toEqual([])
    })

    // ── each precision rule, ablated ──────────────────────────────────────────
    // On this tree the two rules are mutually redundant (both on → 8 sites;
    // either one alone → 8; both off → 9). That measurement is WHY these exist: "delete the rule and see if it goes red" is the
    // discipline §4.9 mandates, and on the repo sweep alone it would have said
    // "not load-bearing" for both. Each rule is load-bearing for a shape the
    // other cannot reach, so the proof is done here, per rule, against that shape.
    it('the assignment rule is load-bearing — pin, then a real path on the next line', () => {
      const shape = [
        'process.env.HOME = tmpHome',
        `process.env.OPENGROUND_HOME = join(tmpHome, '${OG_DIR}')`,
      ].join('\n')
      expect(resolverOffendersIn('src/k.test.ts', shape)).toEqual([])
      // No comment anywhere, so the prose rule cannot save it: remove the
      // assignment rule and this correct pin reports itself.
      expect(resolverOffendersIn('src/k.test.ts', shape, { assignment: false })).toHaveLength(1)
    })

    it('the prose rule is load-bearing — a read, then prose naming the dir', () => {
      const shape = [`const dir = resolveDir(${HOMEDIR})`, `// returns ~/${OG_DIR} when unset`].join(
        '\n',
      )
      expect(resolverOffendersIn('src/l.ts', shape)).toEqual([])
      // Nothing is assigned here, so the assignment rule cannot save it.
      expect(resolverOffendersIn('src/l.ts', shape, { prose: false })).toHaveLength(1)
    })

    it('an inline block-comment pragma does not buy an exemption', () => {
      // A pragma in front of a real resolver was a 20-character bypass while any
      // line merely BEGINNING with a block-comment opener counted as prose
      // (adversarial review 2026-07-20).
      const PRAGMA = '/*' + ' eslint-disable ' + '*/'
      expect(resolverOffendersIn('src/m.ts', `${PRAGMA} ${ogPath(HOMEDIR)}`)).toHaveLength(1)
      // …while a genuine block comment still is prose.
      expect(resolverOffendersIn('src/n.ts', `/* ${ogPath(HOMEDIR)} */\n`)).toEqual([])
    })

    it('catches pinning a home var FROM another home expression', () => {
      // The worst shape there is: it re-points $HOME at the REAL home for every
      // later file in the worker, and both precision rules used to swallow it —
      // the assignment rule skipped the target, and the source anchor had no
      // `.openground` in its window.
      expect(
        resolverOffendersIn('src/o.test.ts', 'process.env.HOME = userInfo().homedir\n'),
      ).toHaveLength(1)
      // An ordinary pin from a temp dir stays silent, including when its
      // explanation names a home function (swarmSessions.test.ts:86).
      expect(
        resolverOffendersIn(
          'src/p.test.ts',
          `process.env.HOME = claudeHome // os.${HOMEDIR} honours $HOME\n`,
        ),
      ).toEqual([])
    })

    it('catches the Electron spelling, and the padded/backtick bracket keys', () => {
      expect(resolverOffendersIn('electron/q.js', ogPath("app.getPath('home')"))).toHaveLength(1)
      expect(resolverOffendersIn('src/r.ts', ogPath('process.env[`HOME`]'))).toHaveLength(1)
      expect(resolverOffendersIn('src/s.ts', ogPath("process.env[ 'HOME' ]"))).toHaveLength(1)
      expect(resolverOffendersIn('src/t.ts', ogPath('homedir ()'))).toHaveLength(1)
      // `process.env.HOMEBREW_PREFIX` is not a home anchor, and neither is
      // `app.getPath('userData')` — both were false anchors in earlier drafts.
      expect(resolverOffendersIn('src/u.ts', ogPath('process.env.HOMEBREW_PREFIX'))).toEqual([])
      expect(resolverOffendersIn('src/v.ts', ogPath("app.getPath('userData')"))).toEqual([])
    })
  })
})

// ── repo-tree writes: the SOURCE half, and only the source half ──────────────
//
// A test that creates something in the git working tree makes `git status`
// dirty unless .gitignore matches it, and in this repo a dirty tree is not
// cosmetic: swarm integration refuses it (a worker must commit before handing
// over) and `git add -A` sweeps it into a commit — on 2026-07-19 exactly that
// swept a concurrent subagent's temp edit into HEAD and left a safety net
// disarmed for about a minute.
//
// READ THE SCOPE OF THIS SWEEP BEFORE TRUSTING IT. An earlier version of this
// comment claimed "a new file, a new probe, a new literal — all red". That was
// measured FALSE (adversarial review, 2026-07-20): four rewrites of one
// forbidden write were planted and all four stayed GREEN, two of them on their
// own. Reading source means arguing with an unbounded supply of spellings, and
// a checker that loses that argument reports "no violations" and is believed —
// which is strictly worse than not having it.
//
// So the load-bearing guard is NOT here. It is src/test/repoRootFence.ts, which
// ignores the source entirely and diffs the repo root's directory listing after
// every test: no verb list, no spelling, and it sees child processes too. All
// four rewrites are red there.
//
// THIS sweep is the complement, and its value is precisely one thing the
// listing cannot do: it sees a write that is created and DELETED inside a
// single test, which never survives to be observed but is still long enough for
// a concurrent `git status` to trip over. That was the original bug's happy
// path. Its scope is exactly:
//
//   *.ts / *.tsx, inside SWEPT_DIRS, calling one of CREATE_FNS / CREATE_FNS_2ND
//   below, where the created argument's TEXT mentions a repo-root anchor —
//   either one of ANCHOR_SEEDS or a local const assigned from one.
//
// Outside that: .js/.mjs/.cjs, files outside SWEPT_DIRS, verbs not listed, a
// path handed in as a parameter or returned by a helper in another module.
// Those are the listing fence's job, not this one's.
describe('repo guard — source sweep for repo-root writes (best-effort; see scope note)', () => {
  // Verbs whose FIRST path argument is the thing being created.
  const CREATE_FNS = [
    'mkdtempSync',
    'mkdtemp',
    'mkdirSync',
    'mkdir',
    'writeFileSync',
    'writeFile',
    // Added 2026-07-20: `appendFileSync(join(REPO_ROOT, 'x'), 'y')` was one of
    // the four planted rewrites that stayed green. The old comment called the
    // list's limits "scope"; a verb that creates a file with its first argument
    // was never out of scope, it was simply missed.
    'appendFileSync',
    'appendFile',
    'openSync',
    'createWriteStream',
    'truncateSync',
    'truncate',
  ]
  // Verbs whose SECOND argument is the thing being created. Kept separate on
  // purpose: symlink/link take the TARGET first, and gateEnvTamper.test.ts
  // legitimately symlinks the repo's own node_modules INTO a tmp dir — reading
  // both arguments would cry wolf on it, and a guard that cries wolf gets
  // switched off.
  const CREATE_FNS_2ND = [
    'renameSync',
    'rename',
    'copyFileSync',
    'copyFile',
    'cpSync',
    'symlinkSync',
    'symlink',
    'linkSync',
  ]
  // Every spelling of "the repository working tree" this tree actually uses.
  // Seeds only — locals assigned from one of these are resolved per file below,
  // because `const rootAlias = REPO_ROOT` was another of the four that stayed
  // green.
  const ANCHOR_SEEDS = /REPO_ROOT|repoRoot|process\.cwd\(\)|import\.meta\.url|__dirname/

  it('the probe prefix itself is covered by .gitignore', () => {
    // The rule below ("route through REPO_PROBE_PREFIX") is only worth enforcing
    // while that prefix is actually ignored — otherwise it standardises the leak.
    // Imported rather than scraped now that the prefix lives in a real module: a
    // rename is a compile error instead of a guard that silently loses its subject.
    const sample = `${REPO_PROBE_PREFIX}deadbeef`
    const { status } = spawnSync('git', ['check-ignore', '-q', '--', sample], { cwd: repoRoot })
    // status 1 = "git ran, nothing matched" — the real failure. Anything else
    // (128 = not a git tree / safe.directory, null = no git binary) is an
    // environment problem, and telling that reader to "add it to .gitignore"
    // would send them to edit a file that is already correct.
    if (status === 1) {
      throw new Error(
        `.gitignore does not cover "${sample}".\n` +
          `A killed or failing run leaves that dir untracked at the repo root, which makes\n` +
          `git status dirty — swarm integration then refuses the tree and git add -A would\n` +
          `commit it. Add the prefix to .gitignore, or keep it as .og-fence-probe-*.`,
      )
    }
    expect(
      status,
      `git check-ignore could not be consulted (exit ${status ?? '(no git binary)'}). ` +
        `This is an ENVIRONMENT problem, not a .gitignore problem — do not "fix" .gitignore. ` +
        `Run the suite inside the repo, with git on PATH.`,
    ).toBe(0)
  })

  /** Text of a call's argument list, given the index just past its `(`. */
  const balanced = (s: string, from: number): string | null => {
    let depth = 0
    for (let i = from; i < s.length; i++) {
      const c = s[i]
      if (c === '(') depth++
      else if (c === ')') {
        if (depth === 0) return s.slice(from, i)
        depth--
      }
    }
    return null
  }

  /**
   * Split an argument list on top-level commas. Paren- and bracket-aware,
   * because the repo root can be spelled as a CALL that contains its own comma
   * — `fileURLToPath(new URL('../../..', import.meta.url))`. Splitting on the
   * first comma would cut that in half and hide the anchor from the test.
   */
  const splitArgs = (args: string): string[] => {
    const out: string[] = []
    let depth = 0
    let start = 0
    for (let i = 0; i < args.length; i++) {
      const c = args[i]
      if (c === '(' || c === '[' || c === '{') depth++
      else if (c === ')' || c === ']' || c === '}') depth--
      else if (c === ',' && depth === 0) {
        out.push(args.slice(start, i))
        start = i + 1
      }
    }
    out.push(args.slice(start))
    return out
  }

  /**
   * A same-length copy of the source with comments and string-literal CONTENT
   * blanked out, so identifiers can be matched without matching prose or data.
   * Offsets and line numbers are preserved exactly (blanked chars become
   * spaces, newlines survive), so everything downstream can still report a real
   * line number and read the real line back out of the original text.
   *
   * Both false positives this sweep produced on its first run came from not
   * doing this, and they are worth naming because they are the "cries wolf"
   * failure the whole design is trying to avoid:
   *
   *   hooksInstall.test.ts:83  `mkdir(join(wt, 'src', 'lib', 'server'))` — an
   *     unrelated `const src = ...join(repoRoot...)` elsewhere in the file made
   *     `src` an alias, and `\bsrc\b` then matched inside the STRING 'src'.
   *   gateEnvTamper.test.ts:90 — a generated probe script held as an array of
   *     string literals was read as if it were code.
   *
   * `${...}` inside a template literal is deliberately KEPT: that is how
   * `writeFileSync(`${REPO_ROOT}/x`, 'y')` — one of the four planted rewrites —
   * stays visible. A regex literal containing an odd quote could still fool
   * this; that is a heuristic's lot, and it is why this sweep is the
   * best-effort layer rather than the load-bearing one.
   */
  const maskLiterals = (s: string): string => {
    const out = s.split('')
    const blank = (from: number, to: number) => {
      for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' '
    }
    let i = 0
    while (i < s.length) {
      const c = s[i]
      if (c === '/' && s[i + 1] === '/') {
        let j = i
        while (j < s.length && s[j] !== '\n') j++
        blank(i, j)
        i = j
      } else if (c === '/' && s[i + 1] === '*') {
        let j = i + 2
        while (j < s.length && !(s[j] === '*' && s[j + 1] === '/')) j++
        j = Math.min(j + 2, s.length)
        blank(i, j)
        i = j
      } else if (c === "'" || c === '"') {
        let j = i + 1
        while (j < s.length && s[j] !== c && s[j] !== '\n') {
          if (s[j] === '\\') j++
          j++
        }
        blank(i + 1, j)
        i = Math.min(j + 1, s.length)
      } else if (c === '`') {
        let j = i + 1
        while (j < s.length && s[j] !== '`') {
          if (s[j] === '\\') {
            j += 2
          } else if (s[j] === '$' && s[j + 1] === '{') {
            let depth = 1
            let k = j + 2
            while (k < s.length && depth > 0) {
              if (s[k] === '{') depth++
              else if (s[k] === '}') depth--
              k++
            }
            j = k // keep the interpolation verbatim
          } else {
            blank(j, j + 1)
            j++
          }
        }
        i = Math.min(j + 1, s.length)
      } else {
        i++
      }
    }
    return out.join('')
  }

  /**
   * Names in this file that stand for a repo-root path: the seeds, plus every
   * local const/let assigned an expression that mentions one. Iterated to a
   * fixpoint so an alias of an alias still resolves.
   *
   * This is what closes two of the four planted rewrites — `const rootAlias =
   * REPO_ROOT` and `const p = join(REPO_ROOT, 'x')`. It is deliberately textual
   * and deliberately per-file: a path that arrives as a function parameter, or
   * from a helper in another module, is not resolvable this way and is left to
   * the listing fence.
   */
  const anchorPattern = (src: string): RegExp => {
    // Array, not Set: this tsconfig has no downlevelIteration, and the list is
    // a handful of names per file.
    const names: string[] = []
    const decl = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^\n]+)/g
    for (let pass = 0; pass < 5; pass++) {
      const before = names.length
      decl.lastIndex = 0
      for (let m = decl.exec(src); m; m = decl.exec(src)) {
        const [, name, rhs] = m
        if (names.indexOf(name) !== -1) continue
        const mentionsAlias = names.some((n) => new RegExp(`\\b${n}\\b`).test(rhs))
        if (ANCHOR_SEEDS.test(rhs) || mentionsAlias) names.push(name)
      }
      if (names.length === before) break
    }
    const alt = names.map((n) => `\\b${n}\\b`).join('|')
    return new RegExp(alt ? `${ANCHOR_SEEDS.source}|${alt}` : ANCHOR_SEEDS.source)
  }

  it('no repo-tree write bypasses REPO_PROBE_PREFIX', () => {
    const files = execFileSync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '*.ts', '*.tsx'],
      { cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    )
      .split('\0')
      .filter(Boolean)
      .filter((rel) => SWEPT_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`)))

    const offenders: string[] = []
    let sanctionedSites = 0
    for (const rel of files) {
      const original = readFileSync(join(repoRoot, rel), 'utf8')
      const lines = original.split('\n')
      // Everything below reads the MASKED text — same offsets, no prose, no
      // string data — and reports out of `lines`, the real thing.
      const src = maskLiterals(original)
      const anchored = anchorPattern(src)
      const scan = (fn: string, argIndex: 0 | 1) => {
        let from = 0
        for (;;) {
          const at = src.indexOf(`${fn}(`, from)
          if (at === -1) break
          from = at + fn.length
          // Word boundary: `writeFile(` must not also match `safeWriteFile(`.
          if (at > 0 && /[\w$.]/.test(src[at - 1])) continue
          const args = balanced(src, at + fn.length + 1)
          if (args === null) continue
          // ONLY the argument that names the created path is examined — never a
          // window around the call. Window-containment was tried first and was
          // measurably wrong: `mkdir(join(dir, 'src', 'test'))` in
          // gateEnvTamper.test.ts and `mkdir(join(wt, 'src', 'lib', 'server'))`
          // in hooksInstall.test.ts both went red because an unrelated
          // `repoRoot` sat inside the window on a LATER statement. Those write
          // under tmpdir-derived locals and are perfectly fine — a guard that
          // cries wolf on them would be turned off within a week.
          //
          // What is NOT required any more: that the argument be a literal
          // `join(...)` starting within 8 characters of the verb. That rule
          // disarmed the sweep for anyone who put the path in a local first, or
          // used a template literal. The whole argument expression is read now.
          const target = splitArgs(args)[argIndex]
          if (target === undefined || !anchored.test(target)) continue
          const lineNo = src.slice(0, at).split('\n').length
          const t = (lines[lineNo - 1] ?? '').trim()
          // Prose about the rule is not a violation of it. This is also what
          // lets the sweep read its OWN file: the blanket self-exemption that
          // used to sit here meant anything written in this file was permanently
          // unpoliced, which is a strange place to put a hole.
          if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue
          if (target.includes('REPO_PROBE_PREFIX')) {
            sanctionedSites++
            continue
          }
          offenders.push(`${rel}:${lineNo} — ${t}`)
        }
      }
      for (const fn of CREATE_FNS) scan(fn, 0)
      for (const fn of CREATE_FNS_2ND) scan(fn, 1)
    }

    expect(
      offenders,
      `A test creates something in the git working tree without going through\n` +
        `REPO_PROBE_PREFIX. Untracked output at the repo root makes git status dirty,\n` +
        `which blocks swarm integration and risks being swept into a commit by\n` +
        `git add -A (2026-07-19). Build it under tmpdir() if it does not have to be\n` +
        `outside temp; if it does (proving "not a temp path" needs a non-temp path),\n` +
        `use join(REPO_ROOT, REPO_PROBE_PREFIX) so .gitignore covers it.\n\n` +
        offenders.join('\n'),
    ).toEqual([])

    // SELF-CHECK — the sweep must still be able to see its own subject. One
    // sanctioned probe remains (testHomeGuard.test.ts, the "exists but is not
    // temp" case); the other stopped creating anything at all once it was moved
    // off the repo root. If the detector stops matching even that one (a
    // refactor to a helper, a renamed anchor), it would report "no violations"
    // while policing nothing. Same reasoning as the SWEPT_DIRS existence
    // precheck above: never report a clean scan that did not happen.
    expect(
      sanctionedSites,
      `the repo-tree write sweep matched NO known probe site — the detector has ` +
        `drifted (CREATE_FNS / ANCHOR_SEEDS / the argument parse). It would now ` +
        `pass no matter what any test writes into the repo. Fix the detector, not this number.`,
    ).toBeGreaterThanOrEqual(1)
  })
})

// ── the listing fence: teeth for the thing that actually has reach ───────────
//
// src/test/repoRootFence.ts is installed by setup-home.ts and runs after every
// test in the suite. These cases pin its diff, without which it would forgive
// everything and say so quietly.
describe('repo guard — the repo-root listing fence', () => {
  it('forgives the sanctioned prefix and flags anything else that appears', () => {
    const baselineNames = readdirSync(REPO_ROOT)
    const baseline = new Set(baselineNames)
    // A real probe, created exactly the way the sanctioned site creates one.
    const probe = mkdtempSync(join(REPO_ROOT, REPO_PROBE_PREFIX))
    try {
      // It IS new relative to the baseline, so the prefix filter is the only
      // thing that can be forgiving it.
      expect(
        unsanctionedResidue(baseline),
        'a probe under the sanctioned prefix must not trip the fence',
      ).toEqual([])
      // ...and the diff is genuinely live rather than always-empty: hide a file
      // that really is there and it must come back named. Nothing is created to
      // prove this — an entry the fence would legitimately reject is exactly
      // what must never be written here.
      const blinkered = new Set(baselineNames.filter((n) => n !== 'package.json'))
      expect(
        unsanctionedResidue(blinkered),
        'the fence reported no residue while an unsanctioned entry was visible to it',
      ).toContain('package.json')
    } finally {
      rmSync(probe, { recursive: true, force: true })
    }
  })

  it('the fence and the sanctioned probe site agree on one repo root', () => {
    // Two different resolutions of "the repo" (this file's __dirname/.., and the
    // fence's own import.meta.url) must land on the same directory, or the fence
    // would be watching a place nothing writes to.
    expect(REPO_ROOT).toBe(repoRoot)
  })
})

// ─── Every ~/.claude anchor is DECLARED ──────────────────────────────────────
//
// The sweep above guards ONE home, and it can be a "there must be exactly one"
// rule because `paths.openGroundHome()` is a choke point — any second resolver
// is a bypass, full stop.
//
// The user's OTHER irreplaceable home has no such choke point and never will:
// Claude Code's own `~/.claude` (session transcripts, hooks, skills, the swarm
// ops scripts, and `~/.claude.json` with the OAuth tokens) is read by a dozen
// modules for unrelated reasons. Twenty-five source files name it. "Exactly
// one" is the wrong shape here.
//
// What must be stopped is narrower and worse: a module that WRITES the real
// ~/.claude from inside a test process. Five sites already resolve it through
// `assertTestHomeIsolated`, and that fence works — but nothing NOTICED when a
// sixth appeared. The sweep above matches the literal `.openground` only, so
// `join(homedir(), '.claude', 'settings.json')` was invisible to it, and the
// fence is silent unless a human remembers to call it. The whole standing
// assurance was five anchors kept wired BY HAND, re-checked by a person running
// a grep out of docs/commander/07-test-isolation-contract.md §5 — precisely the
// «"I re-scanned and found none" is a one-time assurance» shape this file warns
// about a hundred lines up. It also came up short: that hand-kept list named
// five readers; the machine finds nineteen unfenced files touching the real
// ~/.claude (twenty-five anchors, minus the five fenced, minus this scanner).
//
// So: an INVENTORY, re-derived every run. Every swept file that anchors at a
// home AND names `.claude` must appear in the table below with a tier and a
// reason — and each tier's CLAIM is re-verified from the source rather than
// taken on trust:
//
//   fenced            resolves through assertTestHomeIsolated.
//                     VERIFIED: the call is present in the file.
//   read-only         reads ~/.claude and never writes anything, anywhere.
//                     VERIFIED: the file contains ZERO fs-mutation calls. This
//                     is the tier the five hand-listed readers land in, and the
//                     check is what turns "they were read-only when I looked"
//                     into a property that cannot quietly stop holding.
//   writes-elsewhere  it does mutate, but never the REAL ~/.claude — a throwaway
//                     $HOME, the OPEN GROUND home behind the choke point, or the
//                     repo working tree under the sanctioned probe prefix.
//                     (Weaker than the read-only check, deliberately: the stated
//                     reason carries the rest.)
//
// And across EVERY tier, fenced included: no line may both mutate and build its
// path from the real home on the spot (`writeFileSync(join(homedir(), …))`).
// That is the exact shape the review named, and tiering it would have left the
// fenced files — the ones that write for a living — as the way in.
//
// Set equality BOTH ways, so the table cannot rot. A new anchor is UNDECLARED
// (red, and a human must classify it); an entry whose file stopped anchoring is
// STALE (red). The stale half doubles as the discovery canary — if file
// discovery ever returned nothing, all twenty-five entries would go stale rather
// than the scan cheerfully reporting "no violations".
//
// TWO GUARANTEES, and they are not equally strong. Saying so is the point:
//
//   A (the real one).  Every file that plausibly touches the user's Claude home
//     is DECLARED, with a tier and a stated reason. Detection is deliberately
//     promiscuous — any home-ish token, any spelling of the directory, every
//     source extension, the whole repo — so a new file evades only by hiding
//     BOTH signals. A human classifies; the machine insists that they do.
//   B (a tripwire, not a proof).  A declared file cannot grow an OBVIOUS raw
//     write to the real home. Windowed matching over names, so it catches the
//     shapes people actually write and not the ones they could contrive.
//
// THREAT MODEL, so nobody reads more into a green run than is there: the
// adversary is a COLLEAGUE IN A HURRY, not someone hiding from this file. The
// 2026-07-18 loss was written by people doing their jobs, and every evasion
// listed below is a thing a person might reasonably type — not a disguise.
// Anyone who WANTS to slip past has only to build the string (`'.' + 'claude'`,
// three lines up in this very file) and nothing here will see it. That is not
// worth defending against and pretending otherwise would be the real hole.
//
// KNOWN LIMITS, stated instead of papered over — every one of these was DEMOED
// against an earlier draft of this file rather than imagined:
//   - B is defeated by a helper: `const claudeHome = () => join(homedir(),
//     '.claude')` in one place and `writeFileSync(join(claudeHome(), …))` in
//     another puts no directory literal near the write. The file is still
//     DECLARED (A holds); the write itself is unseen.
//   - B is defeated by a mutation this file cannot name: a FileHandle's
//     `.write()`, or anything shelled out through `execFileSync('sh', …)`.
//     Again A holds and B does not.
//   - B can be silenced on purpose by parking an `assertTestHomeIsolated` call
//     near a raw write. That clears it because that IS the sanctioned spelling;
//     a guard cannot tell a fence from a decoy. Reviewers can.
//   - The `.openground` sweep above still scans SWEPT_DIRS only, while this one
//     scans the repo. Widening it is a separate change with its own sanctioning.
//   - This file assembles both literals ('.' + 'claude') so its MACHINERY never
//     matches itself — the self-reference trap this suite keeps re-learning, and
//     which duly caught the first draft of this very block. Its declarations and
//     prose still quote real paths, so it appears in the table below like any
//     other anchor, and being declared rather than exempted is the whole point.
//     It sat at 'read-only' until 2026-07-21, when the repo-root listing fence's
//     teeth landed here and brought a real `mkdtempSync` with them; the claim
//     broke on the merge and the check reported it, which is the property
//     working rather than a reason to relax it. It is now 'writes-elsewhere',
//     and the remaining CHECKED guarantee is narrower and worth stating plainly:
//     the raw-write rule below runs on every tier, so this file still cannot
//     grow a write aimed at the real Claude home — it simply no longer claims to
//     write nothing at all.
type ClaudeAnchorTier = 'fenced' | 'read-only' | 'writes-elsewhere'

const CLAUDE_ANCHORS: Record<string, { tier: ClaudeAnchorTier; why: string }> = {
  // ── fenced ──
  'src/lib/server/claudeTrust.ts': {
    tier: 'fenced',
    why: 'read-modify-writes ~/.claude.json (OAuth tokens + folder trust) — fenced at the resolve',
  },
  'src/lib/server/hooksInstall.ts': {
    tier: 'fenced',
    why: 'writes ~/.claude/settings.json (hook wiring) + its .bak — the 2026-07 near-miss; fenced via guardedHomedir()',
  },
  'src/lib/server/generateSkill.ts': {
    tier: 'fenced',
    why: 'writes into ~/.claude/skills — fenced before it builds the dir',
  },
  'src/lib/server/ogManageSkill.ts': {
    tier: 'fenced',
    why: 'installs ~/.claude/skills/og-manage/SKILL.md — fenced before it builds the path',
  },
  'src/lib/server/swarmToolingInstall.ts': {
    tier: 'fenced',
    why: 'installs ~/.claude/skills/order+supply SKILL.md and ~/.claude/swarm-beat.sh+openground-swarm-lib.sh — fenced (assertTestHomeIsolated) before it builds any target path, same pattern as ogManageSkill.ts',
  },
  'src/lib/server/compactInstructionsInstall.ts': {
    tier: 'fenced',
    why: 'installs the native "# Compact Instructions" section into ~/.claude/CLAUDE.md — fenced (assertTestHomeIsolated) before it builds the target path, same pattern as swarmToolingInstall.ts. It edits a file the USER writes in, so an unfenced test run would rewrite real personal instructions',
  },
  'src/lib/server/__fixtures__/tempRootPoisonProbe.ts': {
    tier: 'fenced',
    why: "the fence's own probe fixture: asks assertTestHomeIsolated for a verdict on each anchor, writes nothing",
  },

  // ── read-only (VERIFIED: zero fs-mutation calls in the file) ──
  'src/lib/server/autoCompactGuard.ts': {
    tier: 'read-only',
    why: "reads ~/.claude/settings.json to report whether native auto-compact was turned off — deliberately never writes it back (the knob is undocumented and the file is the user's), so the tier is the design, not an accident. Fenced at the resolve anyway, since an unpinned test would read the developer's real config",
  },
  'src/lib/server/transcript.ts': {
    tier: 'read-only',
    why: "reads claude's session JSONLs under ~/.claude/projects for generateDescription's marker poll",
  },
  'src/lib/server/claudeUsage.ts': {
    tier: 'read-only',
    why: 'tallies token usage from the same JSONLs (UsageHud)',
  },
  'src/lib/server/claudeUsageCli.ts': {
    tier: 'read-only',
    why: 'the /usage CLI-scrape counterpart — same JSONLs, same read-only tally',
  },
  'src/lib/server/swarmTokenAudit.ts': {
    tier: 'read-only',
    why: 'walks worker-worktree session dirs under ~/.claude/projects to attribute swarm token spend',
  },
  'src/lib/server/projectSkills.ts': {
    tier: 'read-only',
    why: "lists the user's own ~/.claude/skills (home injectable for tests); scan + stat only",
  },
  'src/lib/server/claudeConnection.ts': {
    tier: 'read-only',
    why: 'probes the well-known install target ~/.claude/local/claude to locate the binary',
  },
  'scripts/openground-guard.js': {
    tier: 'read-only',
    why: 'the PreToolUse guard: COMPARES paths against ~/.claude containers to allow/deny. Plain JS run by Claude Code out of ~/.openground/guard/, structurally unable to import the fence — same limit as electron/lockdown.js in the sweep above',
  },

  // ── writes-elsewhere ──
  'src/testHomeEnvGuard.test.ts': {
    tier: 'writes-elsewhere',
    why: "this scanner: quotes ~/.claude paths in the table above and in its own prose, and reads sources to check them. Its ONLY mutations are the repo-root listing fence's teeth — a mkdtemp under REPO_PROBE_PREFIX at the repo root, removed in a finally — so nothing it writes is under any home. Declared rather than exempted: the raw-write rule runs on this tier too, so it still cannot grow a write aimed at the real Claude home",
  },
  'src/lib/server/youCorpus.ts': {
    tier: 'writes-elsewhere',
    why: 'autoMemoryDirFor() is pure path computation, read at every call site; its one mutation (the .corrupt rename) is on the corpus file under openGroundHome(), i.e. behind the choke point',
  },
  'scripts/sandbox-probe.ts': {
    tier: 'writes-elsewhere',
    why: 'seeds do-not-clobber fixtures into a THROWAWAY $HOME so the sandbox deny-probes land on fakes; the real ~/.claude is never a write target (see its header)',
  },
  'src/lib/server/testHomeGuard.test.ts': {
    tier: 'writes-elsewhere',
    why: "the fence's own teeth: asserts ~/.claude was NEVER created under the unsafe home; writes only into throwaway worktrees",
  },
  'src/lib/server/hooksInstall.test.ts': {
    tier: 'writes-elsewhere',
    why: 'drives installHooks against a tmpHome — the ~/.claude paths it builds are all under it',
  },
  'src/lib/server/swarmSafety.test.ts': {
    tier: 'writes-elsewhere',
    why: 'feeds ~/.claude paths to the guard as POLICY STRINGS (allow/deny rows) and pins CLAUDE_CONFIG_PATH into an isolated home; no write goes near the real one',
  },
  'src/lib/server/swarmSessions.test.ts': {
    tier: 'writes-elsewhere',
    why: 'fabricates transcripts under a temp $HOME (claudeHome) to test resume-ability',
  },
  'src/lib/server/swarmSessions.integration.test.ts': {
    tier: 'writes-elsewhere',
    why: 'same, via a shell fixture that writes $HOME/.claude/projects with $HOME pinned to a temp dir',
  },
  'src/lib/server/swarmTranscriptProof.test.ts': {
    tier: 'writes-elsewhere',
    why: 'fabricates $HOME/.claude/projects/<cwd>/<id>.jsonl transcripts with $HOME pinned to a mkdtemp claudeHome, to prove a resumed worker really owns its session — every write lands in that temp, never the real ~/.claude',
  },
  'src/lib/server/swarmOrchestrator.ts': {
    tier: 'writes-elsewhere',
    why: "READS ~/.claude only as mtimes — the manager/worker liveness 3rd channel stats the session transcript and subagents/agent-*.jsonl (sessionAgentActivityAt / managerSubagentActivityAt) to tell 'busy in a sub-agent' from 'dead'; it never opens or writes them. Every mutation this file performs lands under ~/.openground (roster, heartbeats, engine.json), never the real ~/.claude",
  },
  'src/lib/server/swarmOrchestrator.integration.test.ts': {
    tier: 'writes-elsewhere',
    why: 'pins $HOME (og-claude-home temp) + CLAUDE_CONFIG_PATH (<og-orch-home>/.claude.json temp) to test the manager subagent-activity mtime signal (card 7517e4b1); every write lands under a mkdtemp temp, never the real ~/.claude',
  },
  'src/lib/server/youCorpus.test.ts': {
    tier: 'writes-elsewhere',
    why: 'builds auto-memory fixtures under a fakeHome',
  },
  'server/routes/__tests__/projectSkills.test.ts': {
    tier: 'writes-elsewhere',
    why: 'seeds SKILL.md fixtures under a fakeHome for the global-skills route',
  },
  'src/lib/server/swarmLensReview.test.ts': {
    tier: 'writes-elsewhere',
    why: 'pins CLAUDE_CONFIG_PATH at <tmp>/.claude.json so the lens panel cannot reach the real OAuth file — one of the four files the 2026-07-19 claudeTrust fence caught red-handed (§3)',
  },
  'playwright.config.ts': {
    tier: 'writes-elsewhere',
    why: 'the e2e boot script mkdir -p\'s $H/.claude under a mktemp -d and exports HOME=$H, so the browser run gets a throwaway Claude home',
  },
  'perf/perf.config.ts': {
    tier: 'writes-elsewhere',
    why: 'same throwaway-home shell preamble for the perf harness',
  },

  // ── pulled in by the `~/` anchor (see BROAD_HOME). These NAME the Claude home
  //    in text — labels, manual prose, sandbox rules, prompt strings — rather
  //    than resolving it. Kept in the table anyway: "names it" is the signal the
  //    shell-out evasion needed, and a row costs one line.
  'src/lib/server/sandbox.ts': {
    tier: 'read-only',
    why: "builds the sandbox-exec profile TEXT: ~/.claude is named in DENY rules, so the kernel refuses writes to it. Names the path in order to protect it — and touches no file itself",
  },
  'src/lib/server/sandbox.test.ts': {
    tier: 'read-only',
    why: 'pins that profile text in CI, where there is no kernel to enforce it',
  },
  'src/components/canvas/Toolbar.tsx': {
    tier: 'read-only',
    why: 'JSX comment naming ~/.claude/skills next to the button that opens the global-skills panel',
  },
  'src/components/canvas/ProjectPanel.tsx': {
    tier: 'read-only',
    why: 'JSX comment naming the project-local .claude/skills/ next to the same button',
  },
  'src/components/canvas/manual/manualContent.tsx': {
    tier: 'read-only',
    why: "the in-app manual's bilingual prose: 'Claude Code keeps state under ~/.claude, never inside your repo'",
  },
  'src/i18n/messages/projectPanel.ts': {
    tier: 'read-only',
    why: 'the skills-button hint string, which names .claude/skills to the user',
  },
  'src/components/canvas/GlobalSkillsPanel.test.tsx': {
    tier: 'read-only',
    why: 'asserts the ~/.claude/skills/<id>/SKILL.md label the panel renders; pure DOM assertions',
  },
  'src/lib/server/swarmWorker.ts': {
    tier: 'writes-elsewhere',
    why: "the worker prompt text tells the worker to run `bash ~/.claude/swarm-beat.sh`; the file's own writes are worktree node_modules links",
  },
  'src/lib/server/swarmTokenAudit.test.ts': {
    tier: 'writes-elsewhere',
    why: 'feeds `bash ~/.claude/swarm-beat.sh …` to classifyBashCommand as a STRING; fixtures under a tmpdir',
  },
  'src/lib/server/generateSkill.test.ts': {
    tier: 'writes-elsewhere',
    why: 'drives generateSkill against an injected tmp home',
  },
  'src/lib/server/ogManageSkill.test.ts': {
    tier: 'writes-elsewhere',
    why: 'installs the skill into <tmp>/home/.claude/skills to test the marker/upgrade logic',
  },
  'src/lib/server/swarmToolingInstall.test.ts': {
    tier: 'writes-elsewhere',
    why: 'installs order/supply skills + swarm-beat.sh/openground-swarm-lib.sh into <tmp>/home/.claude to test the marker/upgrade logic — same pattern as ogManageSkill.test.ts',
  },
  'src/lib/server/compactInstructionsInstall.test.ts': {
    tier: 'writes-elsewhere',
    why: 'installs the Compact Instructions block into <tmp>/home/.claude/CLAUDE.md (homeDir is injected) to test the block-ownership contract — same pattern as swarmToolingInstall.test.ts',
  },
  'src/lib/server/autoCompactGuard.test.ts': {
    tier: 'writes-elsewhere',
    why: 'seeds <tmp>/home/.claude/settings.json (HOME pinned to a tmpdir) to test the auto-compact disable detection — the module under test only reads',
  },
  'src/lib/server/projectSkills.test.ts': {
    tier: 'writes-elsewhere',
    why: 'seeds project-local .claude/skills and a fake home under tmpdir',
  },
  'src/lib/server/swarmWorktreeTrust.test.ts': {
    tier: 'writes-elsewhere',
    why: 'pins CLAUDE_CONFIG_PATH at <tmp>/.claude.json for the folder-trust prune',
  },
}

// Assembled, never spelled out — see the last KNOWN LIMIT above. WRITE_* is
// assembled for the same reason one layer down: the planted fixtures in the
// teeth below have to CONTAIN a write call, and spelling it out made this file
// fail its own read-only claim on the first run (measured 2026-07-20 — the
// check works, which is the only way anyone found out).
const HOMEDIR_FN = 'homedir'
const HOMEDIR_CALL = HOMEDIR_FN + '()'
const CLAUDE_DIR = '.' + 'claude'
const WRITE_SYNC = 'write' + 'FileSync'
const WRITE_ASYNC = 'write' + 'File'
const MKDIR_FN = 'mk' + 'dir'
const MKDTEMP_FN = 'mk' + 'dtemp'
// Trailing (?![\w-]) so `.claudeSomething` does not count, while `.claude.json`
// — the OAuth file, a home-anchored asset in its own right — still does.
//
// CASE-INSENSITIVE, and that is not tidiness. macOS ships a case-INsensitive
// filesystem, so `join(homedir(), '.Claude', 'settings.json')` opens the very
// same inode as `.claude`. Demonstrated on 2026-07-20 by writing through the
// capital-C spelling and reading the clobbered value back out of the lowercase
// path, with `ls -a` showing one directory. A case-sensitive guard would have
// called that green while the OAuth tokens were being overwritten.
//
// The leading lookbehind separates a PATH SEGMENT from a PROPERTY: `.claude` in
// `payload.claude.length` is a field on an API response and has nothing to do
// with anyone's home. There are 18 such reads across 10 files (`res.claude`,
// `map.claude`, `active.claude`, …), every one of them a home-token away from a
// bogus red — and a guard that cries wolf on `src/App.tsx` is a guard people
// learn to switch off. A real segment is always preceded by a quote, a slash, a
// backtick or a tilde, never by an identifier character; all nine pinned
// evasion spellings survive it (verified).
const CLAUDE_DIR_RE = new RegExp(`(?<![A-Za-z0-9_$)\\]])\\${CLAUDE_DIR}(?![\\w-])`, 'i')

// TWO anchor tests, for two different jobs — the distinction is the whole
// reason the pair survives contact with real code.
//
// BROAD decides "must this file be declared?", and is deliberately promiscuous:
// any home-ish token at all. It has to be, because the evasions found on
// 2026-07-20 were not exotic — `process.env['HOME']`, `const { HOME } =
// process.env`, `import { homedir as userHome }`, `USERPROFILE`, and a shell
// string carrying `$HOME` all reached the real home while the narrow spelling
// was the only one being watched. `\bHOME\b` catches every one of those and
// does NOT catch `OPENGROUND_HOME` / `claudeHome` / `tmpHome` (no word boundary
// before `HOME`), which is exactly the split we want. Over-matching here costs
// one more declared row; under-matching costs the user's OAuth tokens.
// `~/` is in here because a tilde path IS a home path — `execFileSync('sh',
// ['-c', 'echo {} > ~/.claude/settings.json'])` reached the real home while the
// `$HOME` spelling of the same line was already pinned as caught. It costs 13
// extra rows in the table (UI labels, sandbox profile text, worker script
// paths); the alternative was a KNOWN LIMIT that said "A holds" where it did
// not. `getPath('home')` is Electron's own accessor — the repo already calls
// `app.getPath('userData')`, and hook wiring is exactly the kind of work that
// migrates into main.js. HOMEDRIVE/HOMEPATH are win32's sibling spellings of
// USERPROFILE. The last two cost NOTHING: measured +0 files.
//
// `userInfo(` was here and is gone: every real spelling is `userInfo().homedir`,
// which `\bhomedir\b` already catches, so it added no detection and only
// false-positive surface (its removal breaks no test — which is how it was found
// to be decoration).
const BROAD_HOME =
  /\bhomedir\b|\bHOME\b|\bHOMEDRIVE\b|\bHOMEPATH\b|\bUSERPROFILE\b|getPath\s*\(\s*['"`]home|~\//

// NARROW decides "is this line actually RESOLVING the real home?", and is used
// only by the raw-write rule, where a false positive is a red build for correct
// code — the kind that teaches people to silence guards.
//
// The two `process.env.HOME` forms below are neutralised before matching,
// because both MOVE the variable rather than resolve it, and both are conduct
// this suite explicitly REQUIRES:
//    process.env.HOME = tmp      pinning a throwaway home
//    savedHome = process.env.HOME   saving it to restore later (never delete)
// Counting the save form meant that adding one honest line —
// `mkdir(join(fakeHome, '.claude', 'skills'))` — to an already-declared test
// turned its three-lines-up `realHome = process.env.HOME` into "evidence" and
// reported a temp-dir mkdir as a write to the real home. Worse, the advice
// attached to that verdict was "hand it to assertTestHomeIsolated" — i.e. the
// guard talking a developer into planting the exact decoy its own KNOWN LIMITS
// warn about (adversarial review round 2, 2026-07-20).
const HOME_VAR_MOVES = [
  /=\s*process\.env\.HOME\b/g, // saved = process.env.HOME
  /process\.env\.HOME\s*=(?!=)/g, // process.env.HOME = tmp
]
// `\bhomedir\b`, NOT `homedir\s*\(\s*\)`. The parenthesised form made this a
// spell-checker for one call shape: `userInfo().homedir` resolves the real home
// just as surely, BROAD_HOME already catches it (so the file is declared), and
// the raw-write rule — the only consumer of NARROW_HOME — reported NOTHING for
// it while reporting the identical `homedir()` write. Measured 2026-07-21 with
// the two spellings side by side; the teeth for both are below. Dropping the
// parens costs nothing: every case in this file, false-positive pins included,
// stayed green.
const NARROW_HOME =
  /\bhomedir\b|process\.env\.HOME\b|process\.env\[\s*['"`]HOME['"`]\s*\]|process\.env\.USERPROFILE\b/
const resolvesRealHome = (window: string): boolean => {
  let w = window
  for (const move of HOME_VAR_MOVES) w = w.replace(move, ' ')
  return NARROW_HOME.test(w)
}

// fs mutation, by name. Deliberately broad and fail-closed: a bare `rm(`/`cp(`
// could in principle match a method on an unrelated object, and across the whole
// repo on 2026-07-20 it matched nothing of the sort. A false positive is a loud,
// self-describing test failure; a false negative is a write to the user's real
// home that nobody sees. Not exhaustive — `fh.write()` on a FileHandle and a
// mutation shelled out through `execFileSync('sh', …)` both stay invisible, and
// no name list will fix that (see KNOWN LIMITS).
const MUTATION_NAMES =
  'writeFile|writeFileSync|writeSync|writev|writevSync|appendFile|appendFileSync|mkdir|mkdirSync|mkdtemp|mkdtempSync|rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|rename|renameSync|copyFile|copyFileSync|cp|cpSync|createWriteStream|symlink|symlinkSync|link|linkSync|chmod|chmodSync|chown|chownSync|utimes|utimesSync|truncateSync|openSync'
// `truncate` / `ftruncate` are in the IMPORT list below but NOT here: bare
// `truncate(` is a perfectly ordinary local helper — `transcript.ts` has one for
// shortening strings — and matching it turned a pure reader into a false
// "CLAIM BROKEN". Coming in from fs still gets caught, by the import clause.
const MUTATION_IMPORT_NAMES = `${MUTATION_NAMES}|truncate|ftruncate`
// No whitespace before the paren. English prose puts one there — "the invite
// deep link (Track C)" matched `\blink\s*\(`, and because the raw-write window
// was cut from the source WITH comments in it, a plain `readFileSync` two lines
// below got reported as an UNFENCED WRITE. A guard that calls a read a write is
// a guard nobody believes twice. (The window is now cut from comment-stripped
// source as well; this is the second of the two fixes.)
const MUTATES = new RegExp(`\\b(?:${MUTATION_NAMES})(?:\\?\\.)?\\(`)
/** The same names as IMPORTED BINDINGS, which is how an alias gives itself away:
 *  `import { writeFile as persist } from 'fs/promises'` calls `persist(…)` and
 *  matches nothing above, but the import clause still says `writeFile`. Without
 *  this, the read-only tier's "contains no fs mutation" claim was defeated by
 *  renaming (adversarial review, 2026-07-20). Matched across newlines because
 *  prettier splits long import clauses. */
// `[^}]` — NOT a lazy `[\s\S]*?`, which happily spans from an unrelated
// `import { join } from 'path'` all the way to the next `} … from 'fs'` many
// lines later and reports the whole slab as one import clause. It did exactly
// that here on the first run.
const FS_IMPORT_CLAUSE = /import\s*\{([^}]*)\}\s*from\s*['"]fs(?:\/promises)?['"]/g
const importsMutation = (src: string): string | null => {
  const names = new RegExp(`\\b(?:${MUTATION_IMPORT_NAMES})\\b`)
  for (const m of src.match(FS_IMPORT_CLAUSE) ?? []) if (names.test(m)) return m.replace(/\s+/g, ' ')
  return null
}

/** Pure over (file, source) so the teeth below can plant a violation without
 *  writing one to disk — and so both they and the real scan run the SAME code.
 *  Returns one line per problem; empty means the inventory holds. */
const claudeAnchorProblems = (files: SweptFile[]): string[] => {
  const problems: string[] = []
  const anchored: string[] = []
  for (const { rel, src } of files) {
    const lines = src.split('\n')
    // Comment-stripped, but LINE-ALIGNED: every comment becomes an empty line
    // rather than disappearing, so an offset into this still maps to the right
    // line number in the original — and no window can be built out of prose.
    const codeLines = lines.map(codeOf)
    const codeSrc = codeLines.join('\n')
    const code = codeLines.filter(Boolean)
    const claudeLines = code.filter((t) => CLAUDE_DIR_RE.test(t))
    if (!claudeLines.length || !code.some((t) => BROAD_HOME.test(t))) continue
    anchored.push(rel)

    // Raw write, checked on EVERY tier — fenced included. A fenced file is
    // fenced at the seam it already had; nothing stops a SECOND write appearing
    // beside it, and "the file still contains an assertTestHomeIsolated call"
    // would wave that through.
    //
    // WINDOWED, not line-scoped. The first cut asked for mutation and home on
    // ONE line, so merely letting prettier wrap the call — the repo's own
    // dominant style, 42 occurrences — walked past it (adversarial review,
    // 2026-07-20). The `.openground` sweep above learned this on the same day;
    // leaving the pair asymmetric inside one file was indefensible.
    //
    // A fence call anywhere in the window clears it, because that IS the
    // sanctioned spelling: build the path, hand it to assertTestHomeIsolated,
    // write through the checked variable.
    const raw: string[] = []
    const scan = new RegExp(CLAUDE_DIR_RE.source, 'gi')
    for (let m = scan.exec(codeSrc); m; m = scan.exec(codeSrc)) {
      const lineNo = codeSrc.slice(0, m.index).split('\n').length
      const w = codeSrc.slice(Math.max(0, m.index - 200), m.index + 120)
      if (MUTATES.test(w) && resolvesRealHome(w) && !w.includes('assertTestHomeIsolated'))
        raw.push(`${rel}:${lineNo}  ${(lines[lineNo - 1] ?? '').trim().slice(0, 90)}`)
    }

    const entry = CLAUDE_ANCHORS[rel]
    if (!entry) {
      problems.push(`UNDECLARED  ${rel}  —  ${claudeLines[0].slice(0, 100)}`)
      continue
    }
    if (entry.tier === 'fenced' && !src.includes('assertTestHomeIsolated')) {
      problems.push(`CLAIM BROKEN (fenced)  ${rel}  —  no assertTestHomeIsolated call left in the file`)
    }
    if (entry.tier === 'read-only') {
      const called = code.filter((t) => MUTATES.test(t))
      // Over the CODE lines, not the raw source — this very file explains the
      // aliased-import trick in a comment, and reading the raw text made it its
      // own first offender (the self-reference trap, third sighting today).
      const imported = importsMutation(code.join('\n'))
      if (called.length)
        problems.push(`CLAIM BROKEN (read-only)  ${rel}  —  now mutates: ${called[0].slice(0, 100)}`)
      else if (imported)
        problems.push(
          `CLAIM BROKEN (read-only)  ${rel}  —  imports an fs mutation (aliased?): ` +
            `${imported.slice(0, 100)}`,
        )
    }
    if (raw.length) problems.push(`UNFENCED WRITE  ${rel}  —  ${raw[0]}`)
  }
  for (const rel of Object.keys(CLAUDE_ANCHORS)) {
    if (!anchored.includes(rel))
      problems.push(`STALE  ${rel}  —  declared, but no longer anchors at the user's Claude home`)
  }
  return problems
}

describe("repo guard — every ~/.claude anchor is declared and its claim still holds", () => {
  it('matches the declared inventory exactly', () => {
    expect(
      claudeAnchorProblems(repoSourceFiles()),
      `The inventory of files that anchor at the user's REAL Claude home no longer matches.\n\n` +
        `UNDECLARED — you added a new one. Decide which it is and add it to CLAUDE_ANCHORS\n` +
        `  with a reason:\n` +
        `    it WRITES there            → call assertTestHomeIsolated(path, '<who>') at the\n` +
        `                                 resolve, then declare it 'fenced'. Do not skip this:\n` +
        `                                 an unfenced write is the 2026-07-18 data loss, aimed\n` +
        `                                 at the home that holds the OAuth tokens.\n` +
        `    it only READS, ever        → declare it 'read-only' (the file must contain no\n` +
        `                                 fs-mutation call at all — that is what makes the\n` +
        `                                 claim checkable rather than a promise).\n` +
        `    it writes a TEMP/OG home   → declare it 'writes-elsewhere' and say where.\n\n` +
        `UNFENCED WRITE — a line both mutates and builds its path from the real home on the\n` +
        `  spot. No tier excuses this, fenced included. Split it: build the path, hand it to\n` +
        `  assertTestHomeIsolated, then write through the checked variable.\n\n` +
        `CLAIM BROKEN — the file is declared, but the property it was declared on stopped\n` +
        `  being true. Re-fence it or move it to the honest tier; do not relabel to silence.\n\n` +
        `STALE — declared but no longer anchoring. Drop the entry (or, if EVERY entry is\n` +
        `  stale, file discovery broke and the scan is reporting on nothing).\n\n` +
        `Contract: docs/commander/07-test-isolation-contract.md §3.\n`,
    ).toEqual([])
  })

  // ── teeth ──────────────────────────────────────────────────────────────────
  // A guard is worth what its failure case is worth, and every check above was
  // written by the same person who is sure it works. These plant each violation
  // through the SAME function the real scan calls, so "it would go red" is a
  // measurement rather than a belief.
  const planted = (body: string[]): SweptFile => ({
    rel: 'src/lib/server/__planted_probe.ts',
    src: body.join('\n'),
  })

  it('goes red when a NEW file writes the real ~/.claude (the whole point)', () => {
    const p = claudeAnchorProblems([
      planted([
        `import { ${WRITE_SYNC} } from 'fs'`,
        `import { ${HOMEDIR_FN} } from 'os'`,
        `import { join } from 'path'`,
        `export const persist = (json: string) =>`,
        `  ${WRITE_SYNC}(join(${HOMEDIR_CALL}, '${CLAUDE_DIR}', 'settings.json'), json)`,
      ]),
    ])
    expect(p.filter((l) => l.startsWith('UNDECLARED'))).toHaveLength(1)
  })

  it('goes red when a file merely READS a new ~/.claude path — classification is not optional', () => {
    const p = claudeAnchorProblems([
      planted([
        `import { readFileSync } from 'fs'`,
        `import { ${HOMEDIR_FN} } from 'os'`,
        `import { join } from 'path'`,
        `export const peek = () => readFileSync(join(${HOMEDIR_CALL}, '${CLAUDE_DIR}', 'x'), 'utf8')`,
      ]),
    ])
    expect(p.filter((l) => l.startsWith('UNDECLARED'))).toHaveLength(1)
  })

  it("goes red when a declared read-only anchor grows a write (the five readers' standing check)", () => {
    const rel = 'src/lib/server/transcript.ts'
    expect(CLAUDE_ANCHORS[rel].tier).toBe('read-only')
    const p = claudeAnchorProblems([
      {
        rel,
        src: [
          `import { readFile, ${WRITE_ASYNC} } from 'fs/promises'`,
          `import { ${HOMEDIR_FN} } from 'os'`,
          `import { join } from 'path'`,
          `const root = () => join(${HOMEDIR_CALL}, '${CLAUDE_DIR}', 'projects')`,
          `export const cache = (b: string) => ${WRITE_ASYNC}(join(root(), 'c'), b)`,
        ].join('\n'),
      },
    ])
    expect(p.filter((l) => l.startsWith('CLAIM BROKEN (read-only)'))).toHaveLength(1)
  })

  it('goes red when a declared fenced anchor loses its fence call', () => {
    const rel = 'src/lib/server/claudeTrust.ts'
    expect(CLAUDE_ANCHORS[rel].tier).toBe('fenced')
    const p = claudeAnchorProblems([
      {
        rel,
        src: [
          `import { ${HOMEDIR_FN} } from 'os'`,
          `import { join } from 'path'`,
          `const p = () => join(${HOMEDIR_CALL}, '${CLAUDE_DIR}.json')`,
        ].join('\n'),
      },
    ])
    expect(p.filter((l) => l.startsWith('CLAIM BROKEN (fenced)'))).toHaveLength(1)
  })

  // The raw-write rule runs on every tier, so prove it at both ends: the tier
  // whose entire claim is "not the real home", and the tier that is ALLOWED to
  // write and could therefore smuggle one in beside its fenced seam.
  const rawWriteSource = [
    `import { ${WRITE_SYNC} } from 'fs'`,
    `import { ${HOMEDIR_FN} } from 'os'`,
    `import { join } from 'path'`,
    `export const boom = () =>`,
    `  ${WRITE_SYNC}(join(${HOMEDIR_CALL}, '${CLAUDE_DIR}', 'settings.json'), '{}')`,
  ].join('\n')

  it('goes red when a writes-elsewhere anchor starts writing the REAL home', () => {
    const rel = 'scripts/sandbox-probe.ts'
    expect(CLAUDE_ANCHORS[rel].tier).toBe('writes-elsewhere')
    const p = claudeAnchorProblems([{ rel, src: rawWriteSource }])
    expect(p.filter((l) => l.startsWith('UNFENCED WRITE'))).toHaveLength(1)
  })

  it('goes red on the SAME write spelled `userInfo().homedir`', () => {
    // Found while widening the `.openground` resolver anchors two blocks up
    // (docs/commander/07 §4.14), by asking this sweep the same question: is the
    // detection key the ACT, or one spelling of it?
    //
    // It was one spelling. BROAD_HOME decides "must this file be declared?" and
    // catches `userInfo().homedir` through `\bhomedir\b` — but NARROW_HOME, which
    // decides "is this line RESOLVING the real home?" and is the only thing the
    // raw-write rule consults, required the parentheses. So a DECLARED file
    // growing this exact write reported NOTHING, while the identical write one
    // test up (`homedir()`) reported UNFENCED WRITE. Measured 2026-07-21, then
    // fixed by dropping the parens from NARROW_HOME's first alternative — which
    // costs nothing: every other case in this file, including all the
    // false-positive pins below, stayed green.
    const rel = 'scripts/sandbox-probe.ts'
    const viaUserInfo = [
      `import { ${WRITE_SYNC} } from 'fs'`,
      `import { userInfo } from 'os'`,
      `import { join } from 'path'`,
      `export const boom = () =>`,
      `  ${WRITE_SYNC}(join(userInfo().homedir, '${CLAUDE_DIR}', 'settings.json'), '{}')`,
    ].join('\n')
    const p = claudeAnchorProblems([{ rel, src: viaUserInfo }])
    expect(p.filter((l) => l.startsWith('UNFENCED WRITE'))).toHaveLength(1)
  })

  it('goes red when a FENCED anchor grows a second, raw write far from its fence', () => {
    const rel = 'src/lib/server/hooksInstall.ts'
    expect(CLAUDE_ANCHORS[rel].tier).toBe('fenced')
    // The realistic shape: the file's ORIGINAL seam is still fenced (so the
    // tier's own check passes), and a second write has appeared elsewhere in it
    // with no fence in reach. Padding pushes the fence outside the window —
    // inside it, a fence is the sanctioned spelling and correctly clears.
    // Real code, not comments: the window is cut from comment-STRIPPED source,
    // so a wall of `//` lines collapses to newlines and pads nothing.
    const elsewhere = Array(20).fill(`const filler = 'x'.repeat(40)`).join('\n')
    const p = claudeAnchorProblems([
      { rel, src: `${rawWriteSource}\n${elsewhere}\nassertTestHomeIsolated(p, 'hooksInstall')` },
    ])
    expect(p.filter((l) => l.startsWith('CLAIM BROKEN (fenced)'))).toEqual([])
    expect(p.filter((l) => l.startsWith('UNFENCED WRITE'))).toHaveLength(1)
  })

  it('does NOT fire on the correctly fenced spelling', () => {
    // What the guard wants people to write: build, check, then write through the
    // checked variable. The write line carries no `.claude` of its own, so the
    // rule has nothing to match — by design, not by luck.
    const p = claudeAnchorProblems([
      {
        rel: 'src/lib/server/hooksInstall.ts',
        src: [
          `import { ${WRITE_SYNC} } from 'fs'`,
          `import { ${HOMEDIR_FN} } from 'os'`,
          `import { join } from 'path'`,
          `const p = join(${HOMEDIR_CALL}, '${CLAUDE_DIR}', 'settings.json')`,
          `assertTestHomeIsolated(p, 'hooksInstall')`,
          `${WRITE_SYNC}(p, '{}')`,
        ].join('\n'),
      },
    ])
    expect(p.filter((l) => !l.startsWith('STALE'))).toEqual([])
  })

  it('goes red — not green — when file discovery returns nothing', () => {
    // The failure mode every "no violations found" guard dies of. An empty sweep
    // must look like a full set of missing anchors, never like a clean bill.
    const p = claudeAnchorProblems([])
    expect(p.filter((l) => l.startsWith('STALE'))).toHaveLength(Object.keys(CLAUDE_ANCHORS).length)
  })

  // ── the evasions an adversarial pass actually landed, 2026-07-20 ───────────
  //
  // Every one of these was GREEN when it was reported, each with a working write
  // to the real ~/.claude behind it — one of them demonstrated by clobbering a
  // settings.json through the capital-C spelling and reading the damage back out
  // of the lowercase path. They are pinned individually, and by the SPELLING
  // rather than by the mechanism, so that a later "simplification" of the
  // matchers has to break a named test instead of quietly reopening a door.
  const CLAUDE_DIR_CAPS = '.' + 'Claude'
  const BLOCK_END = '*' + '/' // spelling it out would close whatever comment it lands in
  const EVASIONS = [
    {
      name: 'bracketed env read — process.env[…] instead of the dotted form',
      body: [`export const p = process.env['HOME'] + '/${CLAUDE_DIR}/settings.json'`],
    },
    {
      name: 'destructured HOME, used bare thereafter',
      body: [`const { HOME } = process.env`, `export const p = HOME + '/${CLAUDE_DIR}/x'`],
    },
    {
      name: 'aliased homedir import',
      body: [
        `import { ${HOMEDIR_FN} as userHome } from 'os'`,
        `import { join } from 'path'`,
        `export const p = join(userHome(), '${CLAUDE_DIR}', 'settings.json')`,
      ],
    },
    {
      name: 'shell-out carrying $HOME',
      body: [
        `import { execFileSync } from 'child_process'`,
        `export const boom = () =>`,
        `  execFileSync('sh', ['-c', 'echo x > "$HOME/${CLAUDE_DIR}/settings.json"'])`,
      ],
    },
    {
      name: 'USERPROFILE — the win32 spelling of the same home',
      body: [
        `import { join } from 'path'`,
        `const home = process.env.USERPROFILE || ''`,
        `export const p = join(home, '${CLAUDE_DIR}', 'settings.json')`,
      ],
    },
    {
      name: 'real code hiding behind a block-comment terminator',
      body: [
        `/*`,
        `${BLOCK_END} export const p = join(${HOMEDIR_CALL}, '${CLAUDE_DIR}', 'settings.json')`,
      ],
    },
    {
      name: 'capital-C .Claude — the same inode on a case-insensitive volume',
      body: [
        `import { join } from 'path'`,
        `export const p = join(${HOMEDIR_CALL}, '${CLAUDE_DIR_CAPS}', 'settings.json')`,
      ],
    },
    // ── round 2 ──
    {
      name: "Electron's own app.getPath('home')",
      body: [
        `const { app } = require('electron')`,
        `import { join } from 'path'`,
        `export const p = join(app.getPath('home'), '${CLAUDE_DIR}', 'settings.json')`,
      ],
    },
    {
      name: 'tilde path in a shell-out — the ~ spelling of $HOME',
      body: [
        `import { execFileSync } from 'child_process'`,
        `export const boom = () =>`,
        `  execFileSync('sh', ['-c', 'echo "{}" > ~/${CLAUDE_DIR}/settings.json'])`,
      ],
    },
  ]
  for (const ev of EVASIONS) {
    it(`catches: ${ev.name}`, () => {
      const p = claudeAnchorProblems([planted(ev.body)])
      expect(p.filter((l) => l.startsWith('UNDECLARED')), ev.name).toHaveLength(1)
    })
  }

  it('goes red on a prettier-WRAPPED write inside a declared file', () => {
    // The one that mattered most: the first cut demanded mutation and home on a
    // single line, and this repo wraps long calls 42 times over. Merely letting
    // the formatter do its job walked straight past the guard.
    const rel = 'src/lib/server/youCorpus.ts'
    const p = claudeAnchorProblems([
      {
        rel,
        src: [
          `import { ${WRITE_SYNC} } from 'fs'`,
          `import { ${HOMEDIR_FN} } from 'os'`,
          `import { join } from 'path'`,
          `export const persist = (json: string) =>`,
          `  ${WRITE_SYNC}(`,
          `    join(${HOMEDIR_CALL}, '${CLAUDE_DIR}', 'settings.json'),`,
          `    json,`,
          `  )`,
        ].join('\n'),
      },
    ])
    expect(p.filter((l) => l.startsWith('UNFENCED WRITE'))).toHaveLength(1)
  })

  it('goes red when a read-only anchor imports a mutation under an ALIAS', () => {
    // `writeFile as persist` calls `persist(…)`, which matches no mutation name
    // anywhere in the file. The import clause is where it gives itself away.
    const rel = 'src/lib/server/transcript.ts'
    expect(CLAUDE_ANCHORS[rel].tier).toBe('read-only')
    const p = claudeAnchorProblems([
      {
        rel,
        src: [
          `import { readFile, ${WRITE_ASYNC} as persist } from 'fs/promises'`,
          `import { ${HOMEDIR_FN} } from 'os'`,
          `import { join } from 'path'`,
          `const root = () => join(${HOMEDIR_CALL}, '${CLAUDE_DIR}', 'projects')`,
          `export const cache = (n: string, b: string) => persist(join(root(), n), b)`,
        ].join('\n'),
      },
    ])
    expect(p.filter((l) => l.startsWith('CLAIM BROKEN (read-only)'))).toHaveLength(1)
  })

  it('scans every source extension, and reaches outside SWEPT_DIRS', () => {
    // Discovery used to be a git pathspec that read like "all source" and was
    // not: `.mts` / `.cts` / `.jsx` fell through it, and ten tracked files sat
    // outside SWEPT_DIRS entirely — `vitest.config.ts`, the file that wires
    // setupFiles into every test process, among them. Nothing else in this suite
    // can notice a hole in its own discovery, so assert it directly.
    for (const ext of ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.cjs', '.mjs'])
      expect(SOURCE_EXT.test(`x${ext}`), ext).toBe(true)
    for (const ext of ['.md', '.json', '.snap', '.css', '.sh'])
      expect(SOURCE_EXT.test(`x${ext}`), ext).toBe(false)
    const rels = repoSourceFiles().map((f) => f.rel)
    for (const known of [
      'vitest.config.ts',
      'playwright.config.ts',
      'src/lib/server/transcript.ts',
      'electron/lockdown.js',
    ])
      expect(rels, known).toContain(known)
  })

  // ── FALSE POSITIVES, pinned as hard as the evasions ────────────────────────
  //
  // Round 1 of adversarial review hunted holes; round 2 hunted these, and they
  // turned out to matter more. A guard that reddens correct code does not just
  // waste time — it teaches people to make it stop, and the cheapest way to make
  // THIS one stop was to park an `assertTestHomeIsolated` next to the write,
  // which is precisely the decoy its own limits warn about. The guard was
  // recruiting for the attack it documents.
  //
  // So these are not "nice to have" tests. Each is a shape that was RED on a
  // real draft and must stay green.

  it('does NOT fire when a declared test saves HOME and writes under a fake one', () => {
    // The exact regression: `realHome = process.env.HOME` is the save-and-
    // restore this suite REQUIRES (never delete), and counting it as "resolves
    // the real home" made an honest `mkdir` under a mkdtemp'd fakeHome look like
    // a write to the user's actual Claude directory.
    const rel = 'server/routes/__tests__/projectSkills.test.ts'
    const p = claudeAnchorProblems([
      {
        rel,
        src: [
          `import { ${MKDIR_FN}, ${MKDTEMP_FN} } from 'fs/promises'`,
          `import { join } from 'path'`,
          `let fakeHome: string`,
          `let realHome: string | undefined`,
          `beforeEach(async () => {`,
          `  fakeHome = await ${MKDTEMP_FN}(join(tmpdir(), 'og-skills-home-'))`,
          `  realHome = process.env.HOME`,
          `  process.env.HOME = fakeHome`,
          `  await ${MKDIR_FN}(join(fakeHome, '${CLAUDE_DIR}', 'skills'), { recursive: true })`,
          `})`,
        ].join('\n'),
      },
    ])
    expect(p.filter((l) => l.startsWith('UNFENCED WRITE'))).toEqual([])
  })

  it('does NOT fire on a `.claude` PROPERTY of an API payload', () => {
    // `payload.claude` is a field on the active-terminals response. Eighteen
    // reads like it live across ten files, `src/App.tsx` among them.
    const p = claudeAnchorProblems([
      planted([
        `export const beacons = (payload: { claude: string[] }): number => payload.claude.length`,
        `export const label = (): string => \`HOME=\${process.env.HOME ?? '(unset)'}\``,
      ]),
    ])
    expect(p.filter((l) => !l.startsWith('STALE'))).toEqual([])
  })

  it('does NOT call a READ a write because English prose sat above it', () => {
    // `\blink\s*\(` matched "the invite deep link (Track C)" in a comment, and
    // the window was cut from source WITH comments — so a plain readFileSync got
    // reported as an UNFENCED WRITE. Both halves are fixed; hold both.
    const rel = 'scripts/sandbox-probe.ts'
    const p = claudeAnchorProblems([
      {
        rel,
        src: [
          `import { readFileSync } from 'fs'`,
          `import { join } from 'path'`,
          `// Sanity check before the deny-probes run: the invite deep link (Track C)`,
          `// fixture must not have leaked into the throwaway home we just seeded.`,
          `const seeded = readFileSync(join(process.env.HOME ?? '', '${CLAUDE_DIR}', 'settings.json'), 'utf8')`,
        ].join('\n'),
      },
    ])
    expect(p.filter((l) => l.startsWith('UNFENCED WRITE'))).toEqual([])
  })

  it('does NOT fire on prose, or on a home-less mention of the dir', () => {
    // Two false-positive shapes that would train people to silence the guard:
    // a comment about the rule, and a project-local `<repo>/.claude/` path.
    const p = claudeAnchorProblems([
      planted([
        `// never write join(${HOMEDIR_CALL}, '${CLAUDE_DIR}', 'settings.json') from a test`,
        `import { join } from 'path'`,
        `export const local = (repo: string) => join(repo, '${CLAUDE_DIR}', 'skills')`,
      ]),
    ])
    expect(p.filter((l) => !l.startsWith('STALE'))).toEqual([])
  })
})

// Both failure modes, because this guard originally covered only the first and
// the merge briefly covered only the second.
//
// The fence checks TWO independent things: "is OPENGROUND_HOME actually pinned?"
// (this guard's original half, M2) and "where does the value resolve?" (added by
// the merge). The merge assumed the second SUBSUMED the first — an unset var
// falls back to ~/.openground, which is outside tmp, so it throws anyway. That
// is FALSE whenever a test re-pins process.env.HOME to a throwaway dir, because
// then the fallback lands under tmp and passes every destination condition
// (refuted with a reproduction, 2026-07-19; teeth in
// src/lib/server/testHomeGuard.test.ts, "unset is NOT implied by the
// destination check"). Assert both here so neither half can be dropped silently.
describe('paths.openGroundHome — fail-closed under vitest', () => {
  const FENCE = /REFUSING to resolve an OPEN GROUND home/

  it('throws instead of falling back to the real home when unset', async () => {
    const { openGroundHome } = await import('./lib/server/paths')
    const saved = process.env.OPENGROUND_HOME
    try {
      delete process.env.OPENGROUND_HOME
      // The whole point: this must NOT quietly return ~/.openground.
      expect(() => openGroundHome()).toThrow(FENCE)
    } finally {
      // Restore immediately — this is the one place the var is legitimately
      // cleared, and leaving it cleared is exactly the bug under test.
      if (saved !== undefined) process.env.OPENGROUND_HOME = saved
    }
  })

  it('throws when the var is SET but points at the real home', async () => {
    const { openGroundHome } = await import('./lib/server/paths')
    const { productionHome } = await import('./lib/server/testHomeGuard')
    const saved = process.env.OPENGROUND_HOME
    try {
      // A non-empty value satisfies an unset-only check while resolving exactly
      // where the 2026-07-18 damage landed. Nothing is written: the fence throws
      // during resolution, before any caller can build a path from it.
      process.env.OPENGROUND_HOME = productionHome()
      expect(() => openGroundHome()).toThrow(FENCE)
    } finally {
      if (saved !== undefined) process.env.OPENGROUND_HOME = saved
    }
  })

  it('returns the explicit value when set', async () => {
    const { openGroundHome } = await import('./lib/server/paths')
    expect(openGroundHome()).toBe(process.env.OPENGROUND_HOME)
  })
})

// Repo guard: an INVENTORY of every production place that addresses a worker or
// a desk, each declared with a tier and a reason.
//
// ─── why an inventory, and not another bug fix ───────────────────────────────
// Eight review rounds in 2026-07/08 produced fifteen-plus defects from ONE
// shape, and every one of them was silent:
//
//     a question about a worker, answered by ONE pool.
//
// `pty ⇔ terminalId`, `sdk ⇔ sdkSessionId`, and an SDK worker's `terminalId` is
// the EMPTY STRING (workerRuntime.ts, the identity invariant). So a call site
// that reaches for `w.terminalId` does not throw and does not warn — it does
// NOTHING, or it hits a DIFFERENT worker. The recorded harms: a cleaner
// `git worktree remove`d a live worker's tree; a teardown deleted a tree while
// claude was still writing to it; "stop" matched `x.terminalId === id` and `''`
// dropped EVERY SDK worker from the roster while their processes kept running;
// a healthy SDK worker rendered as an EXITED terminal; the Ground beacon and
// the fuel accounting went dark for an all-SDK project.
//
// Each was found by a reviewer, one at a time, and each fix was correct. The
// pattern still recurred every round, in a NEW call site. That is the signature
// of a problem no amount of reviewing fixes: the surface grows faster than
// anyone re-reads it.
//
// docs/MAP.md §5 says this in the sharpest possible way, and it is worth
// quoting because it is the reason this file exists rather than a longer
// checklist. The 5th-round commit (80d567f6) declared "the seams are six" and
// listed them; the SAME tree still held two `status`-based liveness seams,
// visible on the same screen as the grep that was supposed to have found them.
// The miscount was not a grep failure. It was a UNIT failure — the six were
// "defects I found this round", so seams that were already correct fell out of
// the count and seams not yet written could not be in it. MAP.md's conclusion:
// **"数える代わりに、数え方を置く"** — put the counting METHOD in the tree
// instead of a number. This file is that method, executable.
//
// ─── the model, borrowed from src/testHomeEnvGuard.test.ts ───────────────────
// That guard works because it does not try to be clever about intent. It
// enumerates the files that can touch the real home, makes each one DECLARE a
// tier and a reason, and goes red on anything undeclared. It caught a brand-new
// offender the day this was written. Same construction here, over a different
// act.
//
// ─── what is scanned, and what that CANNOT see ───────────────────────────────
// Read this before trusting a green run.
//
// COVERED (production files only — `*.test.*`, `__tests__/`, `__fixtures__/`
// are excluded, since a test naming these symbols is normal):
//   src/lib/server/ · server/routes/ · src/components/canvas/modules/
//
//   A. the PTY pool's own API surface, DERIVED from terminal.ts's exports and
//      classified here as `pool` (reaches the node-pty pool) or `pure`. A new
//      export lands undeclared and goes red — the list can never quietly rot.
//   B. every file that names `terminalId`, calls a `pool` export, or names an
//      SDK-liveness symbol. Declared with a tier, a reason, and the SET of pool
//      functions it uses.
//   C. every `poolFn(<expr mentioning terminalId>)` — the defect shape itself.
//   D. SDK liveness: `isSdkSessionAlive` is BANNED outside its own definition,
//      every `reaped`/`isSdkSessionLive`/`isSdkSessionReaped` file is declared,
//      and every comparison of a status against a terminal-looking literal in
//      an SDK-aware file is declared.
//
// NOT COVERED, and each of these is a real way to slip past:
//   • DI ALIASES at the CALL. `endTerminal(opts.terminalId)` and
//     `write(terminalId, …)` in swarmOrchestrator are `killTerminal` and
//     `writeInput` arriving under a local parameter name; scan C is blind to
//     them by construction. They are caught one level up instead — the DEFAULT
//     (`deps.endTerminal ?? killTerminal`) names the pool export, so the file's
//     `ptyFns` set in scan B carries them. This is MAP.md's third counting
//     recipe ("DI 既定値を目で追う") and it is why scan B is set-based rather
//     than a spot check.
//   • a worker reached through a helper in a file OUTSIDE the three swept
//     directories.
//   • `w.terminalId` written into free prose or a log message. Scan D (below)
//     judges the ones that become an IDENTITY — a key, a lookup, an equality —
//     because those are the uses that silently collapse every SDK worker onto
//     one another. A terminalId that only ever gets printed cannot do that.
//
// ─── how to respond when this goes red ───────────────────────────────────────
// It is SUPPOSED to go red when the surface changes; that is the whole product.
// The failure messages name the tier to pick and what each one promises. Adding
// a declaration is the normal, expected edit — writing the one-line reason IS
// the review. Deleting an entry to get green is the only wrong answer.

import { describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const repoRoot = join(__dirname, '..', '..', '..')

/** The three directories that hold worker/desk-addressing production code. */
const SWEPT_DIRS = ['src/lib/server', 'server/routes', 'src/components/canvas/modules']

/** The pool module, and the file whose exports DEFINE what "a PTY pool call" is. */
const TERMINAL_MODULE = 'src/lib/server/terminal.ts'
/** Where the SDK liveness predicates are defined. */
const SDK_MODULE = 'src/lib/server/sdkSession.ts'

// ─── source enumeration ──────────────────────────────────────────────────────

type SweptFile = { rel: string; code: string; codeWithStrings: string }

/** ⚠ TypeScript ONLY, and that is a correctness rule, not tidiness. These three
 *  directories hold `.ts`/`.tsx` sources and nothing else — so every `.js` under
 *  them is a BUILD ARTIFACT, and the sweep lists untracked files on purpose (a
 *  violation written five minutes ago must be caught before `git add`).
 *  Measured 2026-08-01: one `npx tsc` without `--noEmit` dropped ~180 compiled
 *  `.js` twins into these dirs, and this guard went red with a wall of phantom
 *  violations naming `sdkSession.js`, `liveDesks.js`, `swarmOrchestrator.js`.
 *  None of them are gitignored. A guard that goes red for reasons unrelated to
 *  its subject is a guard somebody deletes — which is the outcome this whole
 *  file exists to avoid, so the artifact can never be a source here. */
const SOURCE_EXT = /\.tsx?$/
const isTestPath = (rel: string): boolean =>
  /\.test\.(?:m|c)?[jt]sx?$/.test(rel) ||
  rel.includes('/__tests__/') ||
  rel.includes('/__fixtures__/')

/**
 * A same-length copy of the source with comments blanked, and — when
 * `keepStrings` is false — string-literal CONTENT blanked too. Offsets and line
 * numbers survive exactly (blanked chars become spaces, newlines are kept), so
 * a hit can still be reported against the real line of the real file.
 *
 * ⚠ STRIPPING COMMENTS IS LOAD-BEARING, and this suite has the scar. A previous
 * round's guard was satisfied by PROSE: the files that discuss this rule discuss
 * it at length (workerRuntime.ts's `workerKey` header alone spells
 * `w.terminalId` four times, and MAP.md's warnings are quoted into three
 * modules), so a scan over raw text reports a file as "touching the pool"
 * because it EXPLAINS why not to. That inflates every count and, far worse,
 * makes deleting an explanation look like fixing a defect.
 *
 * `${…}` inside a template literal is deliberately KEPT even when strings are
 * blanked: `writeInput(id, `${line}\r`)` must stay visible as code.
 */
const maskSource = (s: string, keepStrings: boolean): string => {
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
      if (!keepStrings) blank(i + 1, j)
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
          j = k // keep the interpolation verbatim — it is code
        } else {
          if (!keepStrings) blank(j, j + 1)
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

let filesCache: SweptFile[] | null = null
/**
 * Every PRODUCTION source file in the three swept directories.
 *
 * `--others` (untracked, minus gitignored) is deliberate and is exercised by
 * this file's own teeth: a probe planted to prove the guard bites must be seen
 * BEFORE `git add`, and so must a real offender written five minutes ago.
 */
const sweptFiles = (): SweptFile[] => {
  if (filesCache) return filesCache
  const missing = SWEPT_DIRS.filter((d) => !existsSync(join(repoRoot, d)))
  if (missing.length) {
    throw new Error(
      `[workerAddressingInventory] cannot sweep ${missing.join(', ')} — the directory is ` +
        `missing. Refusing to report "no violations" for a scan that would silently skip ` +
        `it. If the tree was reorganised, update SWEPT_DIRS in this file.`,
    )
  }
  const rels = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
    .split('\0')
    .filter(
      (rel) =>
        rel.length > 0 &&
        SOURCE_EXT.test(rel) &&
        !isTestPath(rel) &&
        SWEPT_DIRS.some((d) => rel.startsWith(`${d}/`)),
    )

  const out: SweptFile[] = []
  for (const rel of rels) {
    let raw: string
    try {
      raw = readFileSync(join(repoRoot, rel), 'utf8')
    } catch (err) {
      // ENOENT is a NORMAL transient: `--cached` lists a tracked file the user
      // deleted mid-refactor, and a dangling symlink reads the same way. Neither
      // has content, so neither can hide a violation. Anything else is a scan
      // that failed, and reporting "clean" for it would be the exact lie this
      // file exists to stop.
      if ((err as { code?: string }).code === 'ENOENT') continue
      throw new Error(
        `[workerAddressingInventory] cannot read ${rel} ` +
          `(${(err as { code?: string }).code ?? err}) — refusing to report "no violations" ` +
          `for a file the sweep could not open.`,
      )
    }
    out.push({
      rel,
      code: maskSource(raw, false),
      codeWithStrings: maskSource(raw, true),
    })
  }

  // A directory that exists but contributes NOTHING means the enumeration is
  // lying about covering it. Existence is not reachability, and this is the
  // cheap standing proof.
  const empty = SWEPT_DIRS.filter((d) => !out.some(({ rel }) => rel.startsWith(`${d}/`)))
  if (empty.length) {
    throw new Error(
      `[workerAddressingInventory] ${empty.join(', ')} exists but the file enumeration ` +
        `returned nothing under it — the sweep would cover it in name only. Check ` +
        `SOURCE_EXT / isTestPath / the git ls-files call.`,
    )
  }
  filesCache = out
  return out
}

const fileNamed = (rel: string): SweptFile => {
  const f = sweptFiles().find((x) => x.rel === rel)
  if (!f) {
    throw new Error(
      `[workerAddressingInventory] ${rel} is not in the sweep. This file is a named ` +
        `anchor of the scan (the pool API surface / the SDK predicates are read out of ` +
        `it). If it moved, update the constant that names it — do NOT delete the anchor.`,
    )
  }
  return f
}

const has = (code: string, word: string): boolean => new RegExp(`\\b${word}\\b`).test(code)
const lineAt = (code: string, index: number): number => {
  let n = 1
  for (let i = 0; i < index; i++) if (code.charCodeAt(i) === 10) n++
  return n
}

// ─── tiers ───────────────────────────────────────────────────────────────────

/**
 * What a declaration CLAIMS. Three of the six are checked structurally below,
 * which is the difference between a tier and a label.
 */
type Tier =
  /** The operation only means anything for a PTY, and the file knows nothing
   *  about SDK sessions. CHECKED: the file must not be SDK-aware. */
  | 'pty-only-by-design'
  /** Reaches a worker through `workerKey` / `runtimeOf` / `deliverAnswerToWorker`
   *  or an explicit `sdkId ? … : …` branch. CHECKED: the file must be SDK-aware;
   *  for a SITE, an SDK counterpart must appear in the site's own window. */
  | 'runtime-dispatched'
  /** Asks BOTH pools in one call (liveDesks.ts and friends). CHECKED: the file
   *  must be SDK-aware. */
  | 'both-pools'
  /** Answers SDK liveness from `reaped` — `isSdkSessionLive` / `isSdkSessionReaped`,
   *  never `status`. CHECKED: the file must be SDK-aware. */
  | 'sdk-live-predicate'
  /** A status read used only to DRAW something. No action is authorised by it.
   *  CHECKED: must be a client component under src/components/. */
  | 'display-only'
  /** Still PTY-only, knowingly. A declared hole — costs a slot in OPEN_BUDGET
   *  and must state what breaks with the SDK dial on. */
  | 'OPEN'

interface Decl {
  tier: Tier
  /** Why this tier is the honest answer. Prose, not a label. */
  why: string
  /** Required for 'OPEN': what actually breaks today, with the dial on. */
  impact?: string
  /** The SDK-side functions this file CALLS. Declaring it makes a deleted
   *  dispatch arm visible; omitting it opts the file out of that check. */
  sdkCalls?: string[]
  /** Lowest acceptable number of `sdkSessionId` mentions.
   *
   *  ⚠ A FLOOR, NOT AN EQUALITY, and the asymmetry is the point. The harm is
   *  DELETION — `target.terminalId || target.sdkSessionId` shrinking back to
   *  `target.terminalId`, which is the literal regression swarmQuestions' own
   *  comment quotes. Additions are harmless and an exact count would churn on
   *  every ordinary edit, which is how a guard earns its way into being
   *  deleted. Same ratchet shape as OPEN_BUDGET. */
  sdkHandleFloor?: number
}

/** Enough of a sentence that "ok" / "legacy" cannot pass for a reason. */
const MIN_WHY = 40

/**
 * Tokens that prove a file (or a window of one) knows the SDK runtime exists.
 *
 * Deliberately a LIST of concrete symbols rather than `/sdk/i`: the loose form
 * matches the word "sdk" inside any comment, and comments are exactly what this
 * scan already strips for being unable to keep a promise.
 */
const SDK_WITNESS = [
  'sdkSessionId',
  'sdkId',
  'getSdkSession',
  'listSdkSessions',
  'listSdkSessionsIn',
  'listActiveSdkCwds',
  'spawnSdkSession',
  'terminateSdkSession',
  'terminateSdkSessionsInDir',
  'waitForSdkSessionGone',
  'pushSdkInput',
  'isSdkSessionLive',
  'isSdkSessionReaped',
  'sdkWorkerRuntime',
  'SdkSessionInfo',
  'SdkSessionStatus',
  'runtimeOf',
  'workerKey',
]
const witnessIn = (code: string): string[] => SDK_WITNESS.filter((w) => has(code, w))
const isSdkAware = (f: SweptFile): boolean => witnessIn(f.code).length > 0

// ─── scan A: the PTY pool's API surface, derived from terminal.ts ────────────
//
// The set of "PTY pool functions" is READ OUT OF terminal.ts rather than
// remembered here. A hand-written list is a spell-checker for the day it was
// written: `listLiveDesksIn` and `claudeSessionActivity` both arrived after the
// SDK runtime did, and a remembered list would have covered neither while
// reading as if it covered everything.

const poolExportsOf = (terminalCode: string): string[] => {
  const re = /^export\s+(?:const|function|async\s+function)\s+([A-Za-z_$][\w$]*)/gm
  const out: string[] = []
  for (;;) {
    const m = re.exec(terminalCode)
    if (!m) break
    out.push(m[1])
  }
  return out
}

/**
 * Every export of terminal.ts, classified.
 *
 *   'pool' — the call reaches the node-pty session map: it looks a session up by
 *            id, enumerates the pool, or writes to / kills a live process. THESE
 *            are the calls that mean "I am talking to a PTY and only a PTY".
 *   'pure' — a constant, or a helper that operates on a value handed to it and
 *            never consults the pool. Excluding these is not tidiness: three of
 *            them (`readScreen`, `pickShell`, `claudeStatus`) are ordinary words
 *            that appear as LOCAL names elsewhere — swarmEscalations declares
 *            `const readScreen = deps?.readScreen ?? getTerminalScreen` — so
 *            counting them would report a file for its dependency-injection
 *            seam while the real pool call (`getTerminalScreen`) sat right there
 *            being counted once. A guard that cries wolf gets switched off.
 */
const POOL_API: Record<string, 'pool' | 'pure'> = {
  // ── pool ──
  createTerminal: 'pool',
  getTerminal: 'pool',
  getTerminalScreen: 'pool',
  getTerminalScreenLogical: 'pool',
  listActiveTerminalCwds: 'pool',
  listActiveTerminals: 'pool',
  listOwnerDeskTerminals: 'pool',
  // Enumerates every live session for the auto-update restart-safety verdict
  // (liveDesks.updateRestartSafety) — a pool read like the two list* above.
  listPtySafetyViews: 'pool',
  listLiveDesksIn: 'pool',
  listPanesForTask: 'pool',
  isClaudeSessionLive: 'pool',
  claudeSessionActivity: 'pool',
  setTerminalTaskId: 'pool',
  writeInput: 'pool',
  resizeTerminal: 'pool',
  killTerminal: 'pool',
  killTerminalsByCwd: 'pool',
  killTerminalsByCwdAndWait: 'pool',
  isTerminalProcessAlive: 'pool',
  waitForTerminalGone: 'pool',
  sweepTerminalPool: 'pool',
  startTerminalSweepLoop: 'pool',
  stopTerminalSweepLoop: 'pool',
  onTerminalExit: 'pool',
  subscribeTerminal: 'pool',
  registerFlowStream: 'pool',
  trackFlowSent: 'pool',
  ackFlowStream: 'pool',
  unregisterFlowStream: 'pool',
  // ── pure ──
  WORKING_SILENCE_MS: 'pure',
  JUST_HANDED_BACK_MS: 'pure',
  TERMINAL_LINGER_SWEEP_MS: 'pure',
  TERMINAL_SWEEP_INTERVAL_MS: 'pure',
  FLOW_HIGH_WATERMARK: 'pure',
  FLOW_LOW_WATERMARK: 'pure',
  FLOW_PAUSE_CAP_MS: 'pure',
  readScreen: 'pure', //          renders a HeadlessTerminal handed to it
  scheduleMenuDetect: 'pure', //  operates on the PtySession passed in
  pickShell: 'pure', //           picks a shell path from env; no pool
  claudeStatus: 'pure', //        derives a beacon status from (info, now)
}

const poolFns = (): string[] =>
  poolExportsOf(fileNamed(TERMINAL_MODULE).code).filter((e) => POOL_API[e] === 'pool')

// ─── scan A′: the SDK side, inventoried the SAME WAY ────────────────────────
//
// ⚠ THE ASYMMETRY THAT MADE THIS WHOLE FILE UNFALSIFIABLE. Until this existed,
// the PTY side was inventoried by CALL SET (`ptyFns`) while the SDK side was a
// single presence bit: `isSdkAware()` = "the file names ≥1 of the 18 witness
// tokens ANYWHERE". Deleting one dispatch arm never removes the last token, so
// the tiers that make the strongest promise — 'runtime-dispatched',
// 'both-pools', 'sdk-live-predicate' — could not be falsified at all.
//
// Measured 2026-08-01, four production mutations, each restored, 33/33 green
// before and after every one of them:
//   1. swarmOrchestrator — delete `if (sdkId) await waitForSdkSessionGone(…)`,
//      leaving only `waitForTerminalGone(opts.terminalId)`. That is the recorded
//      "worktree removed under a live claude" harm, verbatim.
//   2. liveDesks — drop `...listActiveSdkCwds()` from `listAllLiveDeskCwds`.
//      That is the recorded "Ground beacon dark for an all-SDK project".
//   3. swarmEscalations — delete the ENTIRE sdk arm of `deliverAnswerToWorker`.
//   4. swarmQuestions — `target.terminalId || target.sdkSessionId` →
//      `target.terminalId`, which is the literal regression that file's own
//      comment quotes as the reason it was written.
//
// So the SDK side is now a call set too, derived from the two modules that
// DEFINE it rather than remembered here — same rule, same reason as POOL_API.
// It is stricter than `ptyFns` in one way on purpose: membership requires a
// CALL (`fn(`), not a mention. A deleted arm usually leaves its import behind
// for a moment, and "the import is still there" is not "the arm still runs".

/** Where the both-pools seam is defined. Its exports ARE "asking both pools". */
const LIVEDESKS_MODULE = 'src/lib/server/liveDesks.ts'

/** Exports of sdkSession.ts + liveDesks.ts that REACH a desk (vs. pure helpers
 *  and types). Derived from the files, filtered by this table — the same shape
 *  POOL_API has, for the same reason. */
const SDK_API_SKIP = new Set([
  'SDK_SESSION_LINGER_MS',
  'isWorkEvidence',
  'statusAfter',
  'distillSdkMessage',
  'matchesQuotaRefusal',
  // Pure predicate on a role string it is handed (is this session a commander /
  // supply desk?) — classifies, never reaches a desk or enumerates a pool.
  'isSdkDeskRole',
  '__resetSdkSessionsForTests',
  '__setQuotaPrefixesForTests',
])

const sdkFnsAll = (): string[] => {
  const a = poolExportsOf(fileNamed(SDK_MODULE).code)
  const b = poolExportsOf(fileNamed(LIVEDESKS_MODULE).code)
  return Array.from(new Set([...a, ...b]))
    .filter((e) => !SDK_API_SKIP.has(e))
    .sort()
}

/** Locally-defined SDK helpers that are the arm itself rather than a call into
 *  the pool. `waitForSdkSessionGone` lives in swarmOrchestrator, so no export
 *  scan can see it — and deleting its ONE call site is mutation (1) above. */
const SDK_LOCAL_FNS = ['waitForSdkSessionGone', 'stopAllDesksInDirAndWait', 'deliverAnswerToWorker']

/** Does `code` CALL `fn`? Not "mention" — an orphaned import must not count.
 *
 *  A DEPENDENCY-INJECTION DEFAULT counts as a call, because in this repo that is
 *  how a seam is written: `(deps?.push ?? pushSdkInput)(id, text)` and
 *  `const reaped = opts.sdkReaped ?? isSdkSessionReaped`. Requiring a literal
 *  `fn(` would have missed the SDK arm of `deliverAnswerToWorker` entirely —
 *  i.e. the exact arm whose deletion this check exists to notice. */
const callsFn = (code: string, fn: string): boolean =>
  new RegExp(`\\b${fn}\\s*\\(`).test(code) || new RegExp(`\\?\\?\\s*${fn}\\b`).test(code)

describe('worker addressing — the PTY pool API surface is declared, not remembered', () => {
  it('classifies every terminal.ts export as pool or pure', () => {
    const exported = poolExportsOf(fileNamed(TERMINAL_MODULE).code)
    expect(
      exported.length,
      `terminal.ts yielded NO exports. The scan below derives "what is a PTY pool call" ` +
        `from this list, so an empty one would make every later assertion pass for the ` +
        `wrong reason. Check poolExportsOf against terminal.ts's export style.`,
    ).toBeGreaterThan(10)

    const undeclared = exported.filter((e) => !(e in POOL_API))
    expect(
      undeclared,
      `terminal.ts exports something POOL_API does not classify.\n` +
        `Decide, and say which in one word:\n` +
        `  'pool' — it looks a session up by id, enumerates the pool, or writes to /\n` +
        `           kills a live PTY. Callers of it are inventoried below.\n` +
        `  'pure' — a constant, or a helper acting on a value it is handed.\n` +
        `Guessing 'pure' to stay green removes the new function from every scan in\n` +
        `this file at once.\n\n  ${undeclared.join('\n  ')}`,
    ).toEqual([])

    const stale = Object.keys(POOL_API).filter((e) => !exported.includes(e))
    expect(
      stale,
      `POOL_API classifies exports terminal.ts no longer has. A dead entry is not\n` +
        `harmless: it makes the table look more complete than it is, and it is how a\n` +
        `renamed function ends up classified under its old name and scanned under\n` +
        `neither. Remove them.\n\n  ${stale.join('\n  ')}`,
    ).toEqual([])

    expect(poolFns().length, 'no terminal.ts export is classified as `pool`').toBeGreaterThan(10)
  })
})

// ─── scan B: which files address a worker or a desk at all ──────────────────

interface FileFacts {
  rel: string
  /** Names the `terminalId` identifier anywhere in code. */
  namesTerminalId: boolean
  /** The `pool` exports of terminal.ts this file names, sorted. */
  ptyFns: string[]
  /** SDK liveness symbols this file names, sorted. */
  sdkLiveness: string[]
  sdkAware: boolean
  /** The SDK-side functions this file CALLS, sorted. The counterpart of
   *  `ptyFns`, and the thing that makes a dispatch arm's deletion visible. */
  sdkCalls: string[]
  /** How many times the SDK HANDLE is named. A field, not a call: mutation (4)
   *  above deleted `|| target.sdkSessionId` and no call set could see it. */
  sdkHandleUses: number
}

const SDK_LIVENESS_SYMBOLS = [
  'isSdkSessionAlive',
  'isSdkSessionLive',
  'isSdkSessionReaped',
  // The FIELD, read directly. MAP.md's first counting recipe exists because the
  // four reads inside sdkSession.ts go through no symbol at all, and neither do
  // the DI locals (`const reaped = opts.sdkReaped ?? isSdkSessionReaped`) that
  // every waiter is built on.
  'reaped',
]

/** The SDK-side functions `f` CALLS. sdkSession.ts and liveDesks.ts DEFINE this
 *  surface, so they are not counted as callers of it. */
const sdkCallsOf = (f: SweptFile, sdkApi: readonly string[]): string[] =>
  // Only sdkSession.ts is excluded: it IS the pool. liveDesks.ts *defines* the
  // both-pools seam but is itself an ordinary CALLER of sdkSession — and the
  // measured mutation "drop `...listActiveSdkCwds()` from listAllLiveDeskCwds"
  // (the recorded 'Ground beacon dark for an all-SDK project') is only visible
  // if it is inventoried as one.
  f.rel === SDK_MODULE
    ? []
    : Array.from(new Set([...sdkApi, ...SDK_LOCAL_FNS]))
        .filter((fn) => callsFn(f.code, fn))
        .sort()

const factsOf = (
  f: SweptFile,
  pool: readonly string[],
  sdkApi: readonly string[],
): FileFacts => ({
  rel: f.rel,
  namesTerminalId: has(f.code, 'terminalId'),
  ptyFns: pool.filter((fn) => has(f.code, fn)).sort(),
  sdkLiveness: SDK_LIVENESS_SYMBOLS.filter((s) => has(f.code, s)).sort(),
  // ⚠ REACHING THE SDK RUNTIME THROUGH THE SEAM COUNTS. A file that asks
  // `listAllLiveDeskCwds` is doing the CORRECT thing and therefore names no SDK
  // symbol at all — which is exactly why worktreeCleanup, the most destructive
  // both-pools consumer in the tree, was invisible to this inventory. Awareness
  // is "does it reach the runtime", not "does it spell the word".
  sdkAware: isSdkAware(f) || sdkCallsOf(f, sdkApi).length > 0,
  sdkCalls: sdkCallsOf(f, sdkApi),
  sdkHandleUses: (f.code.match(/\bsdkSessionId\b/g) ?? []).length,
})

/** ⚠ A FILE THAT ASKS BOTH POOLS CORRECTLY USED TO BE INVISIBLE HERE. The old
 *  trigger was "names terminalId / calls a pool export / names an SDK liveness
 *  symbol" — and a file that does the right thing names none of those, because
 *  doing the right thing means calling `liveDesks` and letting it ask. So the
 *  repository's MOST destructive both-pools consumer — worktreeCleanup, which
 *  asks `listAllLiveDeskCwds` whether a worktree is still under a live desk and
 *  then runs `git worktree remove` — was absent from the inventory entirely, and
 *  a change reverting it to one pool would not have been noticed. That is the
 *  0731 defect, verbatim. Calling the SDK surface is now a trigger in its own
 *  right. */
const touchesSurface = (x: FileFacts): boolean =>
  x.namesTerminalId ||
  x.ptyFns.length > 0 ||
  x.sdkLiveness.length > 0 ||
  x.sdkCalls.length > 0 ||
  x.sdkHandleUses > 0

/** terminal.ts names its own exports; it is the pool, not a caller of it. */
const ptyFnsFor = (x: FileFacts): string[] => (x.rel === TERMINAL_MODULE ? [] : x.ptyFns)

/**
 * THE INVENTORY. Every production file that names `terminalId`, calls a `pool`
 * export, or names an SDK-liveness symbol.
 *
 * `ptyFns` is a SET, not a count, and that is a deliberate trade. Counts churn
 * with every ordinary edit (five groups were editing these files the day this
 * landed), and a guard that is red for reasons unrelated to its subject gets
 * deleted. A set still catches the change that matters — "this file started
 * calling a pool function it never called before" — which is the shape every
 * one of the fifteen defects had.
 */
const FILES: Record<string, Decl & { ptyFns: string[]; sdkCalls?: string[] }> = {
  // ── the two pools themselves ──
  [TERMINAL_MODULE]: {
    tier: 'pty-only-by-design',
    why: 'This IS the node-pty pool. Its terminalId is the PTY handle by definition; nothing here is supposed to know a second runtime exists.',
    ptyFns: [],
  },
  [SDK_MODULE]: {
    tier: 'sdk-live-predicate',
    why: 'Owns `reaped` and exports isSdkSessionLive / isSdkSessionReaped, the only two predicates any consumer may use. The deprecated status-based isSdkSessionAlive is defined here and, by the ban below, referenced by no other production file.',
    ptyFns: [],
  },

  // ── the runtime seam and the both-pools seams ──
  'src/lib/server/workerRuntime.ts': {
    tier: 'runtime-dispatched',
    why: 'The seam itself: workerKey / runtimeOf, plus the pty and sdk implementations side by side. Its pool calls are the pty arm and are reached only through runtimeOf(w).',
    ptyFns: ['getTerminal', 'getTerminalScreen', 'killTerminal', 'writeInput'],
    sdkCalls: ['attachSdkListener', 'getSdkSession', 'isSdkSessionLive', 'lastQuotaRefusalText', 'pushSdkInput', 'terminateSdkSession'],
    sdkHandleFloor: 3,
  },
  'src/lib/server/liveDesks.ts': {
    tier: 'both-pools',
    why: 'The one seam that answers "who is alive / where" by asking BOTH pools in a single call — listAllLiveDeskCwds, canonicalLiveDeskCwds/isDirOccupied/liveDeskOccupies (the occupancy question a spawn must ask), listAllActiveDesks, stopAllDesksInDirAndWait, and (0803) updateRestartSafety/computeRestartSafety — the "may the app restart itself to apply an update?" verdict for the Electron shell (GET /api/update/restart-safety).',
    ptyFns: ['killTerminalsByCwdAndWait', 'listActiveTerminalCwds', 'listActiveTerminals', 'listPtySafetyViews'],
    sdkCalls: ['canonicalLiveDeskCwds', 'computeRestartSafety', 'isDirOccupied', 'isSdkSessionLive', 'isSdkSessionReaped', 'listActiveSdkCwds', 'listAllLiveDeskCwds', 'listSdkSessions', 'terminateSdkSessionsInDir'],
  },
  'src/lib/server/groundLamps.ts': {
    tier: 'both-pools',
    why: 'GET /api/ground/lamps — whether a project is 作業中 or 途中でとまっている. A one-pool answer here is a LIE THE OWNER READS: swarm workers run on the SDK, so asking the PTY pool alone reports "nothing is moving" over a swarm working perfectly, and the card then says the project stalled. It goes through listAllActiveDesks (both pools) for the plain-pane arm, and through listSwarmWorkers — which itself reads both runtimes — for the worker arm.',
    ptyFns: [],
    sdkCalls: ['listAllActiveDesks'],
  },
  'server/routes/misc.ts': {
    tier: 'both-pools',
    why: 'GET /api/update/restart-safety — the Electron shell asks "may I restart the app RIGHT NOW to apply a downloaded update?" and the answer must come from the liveDesks seam (both pools in one call): a one-pool answer here authorises an unattended restart on top of a live SDK worker — the same authorises-destruction shape as worktreeCleanup 0731.',
    ptyFns: [],
    sdkCalls: ['updateRestartSafety'],
  },
  'server/routes/project.ts': {
    tier: 'both-pools',
    why: 'POST /api/project/delete trashes the repo and then rm -rf\'s ~/.openground/projects/<uuid>/ — which CONTAINS the swarm worktrees. It must stop and WAIT on both pools first: a worker\'s cwd is the central worktree, not the repo, so trashing the root leaves it running and the rm lands under a live claude.',
    ptyFns: [],
    sdkCalls: ['stopAllDesksInDirAndWait'],
  },
  'src/lib/server/worktreeCleanup.ts': {
    tier: 'both-pools',
    why: 'The most destructive consumer in the repository: it asks the liveDesks seam whether a worktree is still under a LIVE desk and then runs `git worktree remove`. Reverting it to one pool deleted a running SDK worker\'s tree in 0731 — and it was absent from this inventory until the trigger learned that calling the liveDesks seam counts. 0803: the canonicalize+prefix matching it used to spell out inline moved INTO the seam (canonicalLiveDeskCwds + isDirOccupied) so the delete side and the spawn side ask one rule.',
    ptyFns: [],
    sdkCalls: ['canonicalLiveDeskCwds', 'isDirOccupied'],
  },
  'src/lib/server/sdkDeskLimit.ts': {
    tier: 'sdk-live-predicate',
    why: 'Subscribes to an SDK desk\'s frame stream to notice a quota refusal. Pure SDK side by construction — there is no PTY handle here — but it must stay declared so a change that starts reaching for a terminalId is visible.',
    ptyFns: [],
    sdkCalls: ['attachSdkListener'],
    sdkHandleFloor: 2,
  },
  'src/lib/server/swarmManagerRuntime.ts': {
    tier: 'both-pools',
    why: 'The commander desk window: listManagerDesks concatenates the PTY and SDK desks so the singleton guard and the presence probe can never disagree, and isManagerDeskAlive branches per runtime.',
    ptyFns: [
      'claudeSessionActivity',
      'getTerminalScreen',
      'isTerminalProcessAlive',
      'listLiveDesksIn',
      'writeInput',
    ],
    sdkCalls: ['getSdkSession', 'isSdkSessionLive', 'listSdkSessionsIn', 'pushSdkInput'],
    sdkHandleFloor: 2,
  },
  'src/lib/server/swarmSessions.ts': {
    tier: 'both-pools',
    why: 'isAgentSessionLiveAnywhere asks both pools whether a claude conversation is still open; answering "free" for a desk that is still talking would hand its transcript to a new --resume.',
    ptyFns: ['isClaudeSessionLive'],
    sdkCalls: ['isSdkSessionLive', 'listSdkSessions'],
  },
  'src/lib/server/swarmWorkerRegistry.ts': {
    tier: 'both-pools',
    why: 'Builds the worker roster from live desks on both runtimes, so an SDK worker is not published as an exited terminal.',
    ptyFns: ['listActiveTerminals'],
    sdkCalls: ['isSdkSessionLive', 'listSdkSessions'],
    sdkHandleFloor: 9,
  },
  // (swarmWorkerRuntimeDial.ts — the pty/sdk worker dial + SDK slot cap — was
  // deleted 2026-08-13: workers are SDK-only and uncapped, so its roster entry
  // left with it.)

  // ── the engine ──
  'src/lib/server/swarmOrchestrator.ts': {
    tier: 'runtime-dispatched',
    why: 'The engine. Every worker-reaching path branches on the id it was given (sdkId ? endSdk : endTerminal) or goes through workerKey; the raw pool calls that remain are the pty arms and the one-off review-panel PTYs.',
    ptyFns: [
      'claudeSessionActivity',
      'getTerminal',
      'getTerminalScreen',
      // 0804: the published supplyDesk handle re-confirms the pool entry against
      // the PROCESS TABLE before offering it for adoption — `finishedAt` lands on
      // an async onExit, so for a moment after a kill the pool still lists the
      // desk and the pane re-adopts the one the owner just stopped. PTY-correct
      // by construction: the supply desk is a PTY desk (swarmSupply spawns it
      // through launchClaude), and listManagerDesks does the same re-confirmation
      // for the commander's PTY arm.
      'isTerminalProcessAlive',
      'killTerminal',
      'listLiveDesksIn',
      'subscribeTerminal',
      'waitForTerminalGone',
      'writeInput',
    ],
    sdkCalls: [
      // 0803: the external-rework observation now TELLS the worker through the
      // both-runtimes conduit (swarmEscalations.deliverAnswerToWorker) instead
      // of only re-arming its own monitoring.
      'deliverAnswerToWorker',
      'getSdkSession',
      'isSdkSessionReaped',
      'stopAllDesksInDirAndWait',
      'terminateSdkSession',
      'waitForSdkSessionGone',
    ],
    sdkHandleFloor: 32,
  },
  'src/lib/server/swarmEscalations.ts': {
    tier: 'runtime-dispatched',
    why: 'deliverAnswerToWorker is the runtime-agnostic answer conduit; defaultCanInjectInto / injectAnswerIntoWorker are its pty arm and defaultCanPushIntoSdkWorker its sdk arm.',
    ptyFns: ['getTerminal', 'getTerminalScreen', 'writeInput'],
    sdkCalls: ['deliverAnswerToWorker', 'getSdkSession', 'isSdkSessionLive', 'pushSdkInput'],
    sdkHandleFloor: 21,
  },
  'src/lib/server/swarmQuestions.ts': {
    tier: 'runtime-dispatched',
    why: 'Carries the WHOLE worker handle (runtime + the one id it names) and lets deliverAnswerToWorker branch. It used to test `if (input.terminalId)`, which was false for every SDK worker while reporting success.',
    ptyFns: [],
    sdkCalls: ['deliverAnswerToWorker'],
    sdkHandleFloor: 7,
  },
  'src/lib/server/swarmOverseer.ts': {
    tier: 'runtime-dispatched',
    why: 'The overseer addresses workers by handle and delivers through deliverAnswerToWorker; canInjectInto survives only as the injected pty arm.',
    ptyFns: [],
    sdkCalls: ['deliverAnswerToWorker'],
    sdkHandleFloor: 10,
  },
  'src/lib/server/swarmManager.ts': {
    tier: 'runtime-dispatched',
    why: 'Seats the commander on the SDK runtime when the dial says so and falls back to a PTY desk otherwise; watchSdkDeskForLimit is the SDK twin of the PTY quota watch.',
    ptyFns: ['getTerminalScreen', 'onTerminalExit'],
    sdkCalls: ['attachSdkListener', 'preloadSdk', 'spawnSdkSession'],
    sdkHandleFloor: 5,
  },
  'src/lib/server/swarmWorker.ts': {
    tier: 'runtime-dispatched',
    why: 'Builds the worker record, which carries `runtime` plus exactly one handle — the identity invariant this whole inventory is about. It also asks liveDeskOccupies before REUSING a worktree on the restart path: without that (0803) a card sent back to `doing` got a second claude beside its live SDK worker, and a PTY-shaped occupancy test would have missed it for exactly the reason this inventory exists.',
    ptyFns: [],
    sdkCalls: ['liveDeskOccupies', 'preloadSdk', 'spawnSdkSession', 'stopAllDesksInDirAndWait'],
    sdkHandleFloor: 1,
  },
  'src/lib/server/swarmOverseerBrain.ts': {
    tier: 'pty-only-by-design',
    why: 'Runs the overseer brain as its own short-lived one-off claude PTY that this module spawns, reads and kills. It is not a swarm worker and has no roster entry, so there is no second runtime to dispatch to.',
    ptyFns: ['killTerminal', 'subscribeTerminal'],
  },
  'src/lib/server/swarmSupply.ts': {
    tier: 'pty-only-by-design',
    why: 'The supply desk is deliberately kept on the PTY runtime (docs/commander/00-INDEX.md: it is the outside phone line that must survive the commander moving to SDK, where the remote control disappears). 0803: it also OWNS stopping its desks (stopSwarmSupplyDesks — kill by desk label), so the route layer never reaches the PTY pool directly.',
    ptyFns: ['killTerminal', 'listLiveDesksIn', 'isTerminalProcessAlive'],
  },

  // ── one-off utility PTYs: each spawns its own claude, reads it, kills it ──
  'src/lib/server/claudeTerminal.ts': {
    tier: 'pty-only-by-design',
    why: 'launchClaude — the PTY spawner itself. The terminalId it returns is the handle it just created; there is no worker record here to dispatch on.',
    ptyFns: ['createTerminal', 'killTerminal', 'writeInput'],
  },
  'src/lib/server/canvasAi.ts': {
    tier: 'pty-only-by-design',
    why: 'A one-off claude PTY this module spawns for a canvas generation job and tears down itself. Not a worker, not on the roster.',
    ptyFns: ['killTerminal', 'killTerminalsByCwdAndWait', 'subscribeTerminal'],
  },
  'src/lib/server/generateDescription.ts': {
    tier: 'pty-only-by-design',
    why: "A one-off claude PTY for the card's auto-description, spawned and killed in the same function. Not a worker.",
    ptyFns: ['killTerminal', 'subscribeTerminal'],
  },
  'src/lib/server/generateSkill.ts': {
    tier: 'pty-only-by-design',
    why: 'A one-off claude PTY for skill generation, spawned and killed in the same function. Not a worker.',
    ptyFns: ['killTerminal', 'subscribeTerminal'],
  },
  'src/lib/server/personaChat.ts': {
    tier: 'pty-only-by-design',
    why: 'One claude PTY per persona conversation turn (and per export distillation), spawned, marker-scraped and killed inside makePersonaTurn. It is the owner talking to their own stand-in — there is no worker record, no roster entry and no second runtime to dispatch to. The `--resume` continuity is carried by the SESSION id + the conversation scratch dir, never by a terminalId held across turns. NOTE for the next inventory: the two pool calls go through INJECTED ALIASES (`const kill = opts.kill ?? killTerminal`, the test seam), so the call-SITE scan below finds nothing here and this file-level entry is the only thing that records them.',
    ptyFns: ['killTerminal', 'subscribeTerminal'],
  },
  'src/lib/server/generateTaskTitle.ts': {
    tier: 'pty-only-by-design',
    why: 'A one-off claude PTY for task-title generation, spawned and killed in the same function. Not a worker.',
    ptyFns: ['killTerminal', 'subscribeTerminal'],
  },

  // ── the PTY REST/SSE surface ──
  'server/routes/terminal.ts': {
    tier: 'both-pools',
    why: 'Mostly the REST surface OF the PTY pool (/api/terminal), but GET /active is the Ground beacon\'s feed and goes through listAllActiveDesks — BOTH pools. Tiering the whole file pty-only was wrong the moment that one route landed: a project whose work is entirely on SDK desks would show a dark card, and the file that answers "is anything running here" must be the last place to forget the second pool.',
    ptyFns: [
      'ackFlowStream',
      'createTerminal',
      'getTerminal',
      'killTerminal',
      'resizeTerminal',
      'setTerminalTaskId',
      'writeInput',
    ],
    sdkCalls: ['listAllActiveDesks'],
  },
  'server/routes/sse.ts': {
    tier: 'pty-only-by-design',
    why: 'Streams PTY bytes with the flow-control handshake. An SDK session emits distilled events on its own SSE route instead; there is no byte stream to multiplex here.',
    ptyFns: [
      'registerFlowStream',
      'subscribeTerminal',
      'trackFlowSent',
      'unregisterFlowStream',
    ],
  },
  'server/routes/sdkSession.ts': {
    tier: 'sdk-live-predicate',
    why: 'The SDK SSE route. It ends the stream on isSdkSessionLive — the status-based test used to cut the last frame, the only one that says HOW a desk ended.',
    ptyFns: [],
    sdkCalls: ['attachSdkListener', 'getSdkSession', 'interruptSdkSession', 'isSdkSessionLive', 'pushSdkInput', 'terminateSdkSession'],
  },
  'server/routes/swarm.ts': {
    tier: 'runtime-dispatched',
    why: 'Takes terminalId from the body as one half of a worker address and hands the whole handle to the engine, which branches on runtime.',
    ptyFns: [],
  },

  // ── UI ──
  'src/components/canvas/modules/SwarmModule.tsx': {
    tier: 'runtime-dispatched',
    why: 'The Swarm tab. Stop/restart go through the worker handle: killing worker.terminalId silently hit the wrong worker (or none) for every SDK worker.',
    ptyFns: [],
  },
  'src/components/canvas/modules/useSwarmEngine.ts': {
    tier: 'runtime-dispatched',
    why: 'Carries its own keyOf(w) mirroring workerKey, so the client addresses a worker by whichever handle its runtime names.',
    ptyFns: [],
  },
  'src/components/canvas/modules/SwarmManagerPane.tsx': {
    tier: 'runtime-dispatched',
    why: 'The commander tile renders whichever desk the runtime dial seated; the terminalId it reads is present only on a PTY desk.',
    ptyFns: [],
  },
  'src/components/canvas/modules/BoardModule.tsx': {
    tier: 'runtime-dispatched',
    why: "The card drawer's 実行 launch records whichever handle came back, and pane matching compares handles rather than assuming a PTY.",
    ptyFns: [],
  },
  'src/components/canvas/modules/useSupplyDesk.ts': {
    tier: 'pty-only-by-design',
    why: "The ONE supply desk's state + launch/stop/restart, shared by the Swarm tab and the Board's front-desk seat (two surfaces, one desk, one stored record). The supply desk is deliberately PTY-only — it is the outside phone line that must survive the commander moving to SDK, where remote control disappears — so terminalId IS its whole address here. It reaches no worker at all.",
    ptyFns: [],
  },
  'src/components/canvas/modules/BoardSupplyDock.tsx': {
    tier: 'pty-only-by-design',
    why: "The Board's front-desk seat. The desk it attaches to is the SUPPLY desk, which is deliberately PTY-only (docs/commander/00-INDEX.md: it is the outside phone line that must survive the commander moving to SDK). Its WORKER monitor beside it never touches a handle directly — it addresses every worker through engineWorkerKey, which is total over both runtimes.",
    ptyFns: [],
  },
  'src/components/canvas/modules/SdkWorkerPane.tsx': {
    tier: 'sdk-live-predicate',
    why: "The SDK worker tile, and the CLIENT half of the reaped rule: blipVerdict closes only on the server's `reaped`, never on a terminal status, so a desk still unwinding is not drawn as gone while the Swarm list beside it still counts it live.",
    ptyFns: [],
  },
  'src/components/canvas/modules/SwarmWorkerPane.tsx': {
    tier: 'pty-only-by-design',
    why: 'The PTY worker tile — an xterm attached to a byte stream. SdkWorkerPane.tsx is its SDK twin and renders distilled events instead.',
    ptyFns: [],
  },
  'src/components/canvas/modules/SwarmSupplyPane.tsx': {
    tier: 'pty-only-by-design',
    why: 'The supply desk tile, and the supply desk is deliberately PTY-only (see swarmSupply.ts).',
    ptyFns: [],
  },
  'src/components/canvas/modules/CustomModuleView.tsx': {
    tier: 'pty-only-by-design',
    why: 'A user-installed custom tab may host a terminal pane; it is given a PTY id and nothing else. Custom tabs cannot spawn SDK sessions.',
    ptyFns: [],
  },

  // ── declared holes ──
  'src/lib/server/ownerDeskLimit.ts': {
    tier: 'OPEN',
    why: "Watches the owner's own desks for a quota stop by SCANNING THE PTY POOL and reading rendered screens; docs/MAP.md §5 states plainly that this desk cannot see SDK desks.",
    impact:
      'An SDK desk that stops on a spent limit produces no owner notification from this loop. The SDK equivalent (sdkDeskLimit.watchSdkDeskForLimit, event-sourced) exists but is wired only for the COMMANDER desk in swarmManager — an SDK desk seated anywhere else is unwatched.',
    ptyFns: ['getTerminalScreenLogical', 'listOwnerDeskTerminals'],
  },
  'src/lib/server/sessionContext.ts': {
    tier: 'OPEN',
    why: 'Resolves the context-window fill gauge from a PTY session plus its rendered screen; an SDK session has neither a pool entry nor a screen.',
    impact:
      'A desk on the SDK runtime reports no context-fill %, so the gauge and the task-boundary hint are dark for it. Read-only — nothing destructive is authorised by the miss.',
    ptyFns: ['getTerminal', 'getTerminalScreen'],
  },
  'src/lib/server/boundaryClear.ts': {
    tier: 'OPEN',
    why: 'Task-boundary /clear resolves a done card to the PTY panes BOUND to it (TerminalInfo.taskId) and types into them; SDK sessions carry no taskId binding and no input line.',
    impact:
      "An SDK desk's context is never cleared at a card boundary, so the next task inherits a finished one — the exact waste this module was built to end, on the runtime it cannot see. Never destructive: the failure mode is not clearing.",
    ptyFns: ['listPanesForTask', 'setTerminalTaskId', 'writeInput'],
  },
  'src/lib/server/claudeSlash.ts': {
    tier: 'OPEN',
    why: "The manual escape hatch types claude's own slash commands into a live PTY, gated on the rendered screen not being mid-generation. Both the typing and the gate are PTY-shaped.",
    impact:
      'If a slash / gauge control is ever offered for an SDK desk it will silently do nothing. The SDK conduit is pushSdkInput; nothing routes to it from here today.',
    ptyFns: ['getTerminalScreen', 'writeInput'],
  },
  'src/lib/server/swarmJanitor.ts': {
    tier: 'OPEN',
    why: 'The janitor sweeps dead entries from the PTY pool and reports them; it never asks the SDK pool anything.',
    impact:
      "The janitor's report says nothing about SDK sessions, so the operator surface that is supposed to show 'what stale state is left' is blind to half the desks. The SDK pool self-expires on SDK_SESSION_LINGER_MS, so nothing leaks — but nothing is reported either.",
    ptyFns: ['sweepTerminalPool'],
  },
  'server/routes/customModules.ts': {
    tier: 'OPEN',
    why: 'Kills PTYs in a custom-module directory before rm -rf-ing it, using killTerminalsByCwd — which neither asks the SDK pool nor WAITS for anything to actually exit.',
    impact:
      "Latent, not live: nothing spawns an SDK session in a custom-module dir today. If one ever is, the delete lands under a running claude — the 2026-07-28 wedged-git shape. The correct call is liveDesks.stopAllDesksInDirAndWait, which asks both pools and refuses the delete when something is still there.",
    ptyFns: ['killTerminalsByCwd'],
  },
}

// ─── scan C: the defect shape — a pool call handed a terminalId ─────────────

/** How many lines around a site count as "its own context" for the SDK witness. */
const SITE_WINDOW_LINES = 30

interface Site {
  rel: string
  fn: string
  line: number
  args: string
  /** The SDK witnesses found within SITE_WINDOW_LINES of the call. */
  witnesses: string[]
}

/** Text of a call's argument list, given the index just past its `(`. */
const balancedArgs = (s: string, from: number): string | null => {
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

/** Pure matcher — takes source text, so the teeth below can exercise it. */
const addressingSitesIn = (rel: string, code: string, pool: readonly string[]): Site[] => {
  const lines = code.split('\n')
  const out: Site[] = []
  for (const fn of pool) {
    const re = new RegExp(`\\b${fn}\\s*\\(`, 'g')
    for (;;) {
      const m = re.exec(code)
      if (!m) break
      const args = balancedArgs(code, m.index + m[0].length)
      if (args === null || !/\bterminalId\b/.test(args)) continue
      const line = lineAt(code, m.index)
      const from = Math.max(0, line - 1 - SITE_WINDOW_LINES)
      const window = lines.slice(from, line + SITE_WINDOW_LINES).join('\n')
      out.push({
        rel,
        fn,
        line,
        args: args.replace(/\s+/g, ' ').trim().slice(0, 70),
        witnesses: witnessIn(window),
      })
    }
  }
  return out.sort((a, b) => a.line - b.line)
}

/**
 * Every `poolFn(<something>.terminalId)` in production, declared per (file, fn)
 * with a COUNT.
 *
 * Counts are affordable here, unlike in FILES, because this set is small and
 * changes only when someone adds a new direct PTY call — which is precisely the
 * event worth interrupting for.
 */
const SITES: Record<string, Decl & { count: number }> = {
  // one-off utility PTYs — the module spawned this exact PTY moments earlier
  'src/lib/server/canvasAi.ts::killTerminal': {
    tier: 'pty-only-by-design',
    count: 2,
    why: 'Tears down the one-off canvas-AI PTY this module just spawned (abort path and finally path).',
  },
  'src/lib/server/canvasAi.ts::subscribeTerminal': {
    tier: 'pty-only-by-design',
    count: 1,
    why: 'Reads the output of the one-off canvas-AI PTY this module just spawned.',
  },
  'src/lib/server/generateDescription.ts::killTerminal': {
    tier: 'pty-only-by-design',
    count: 2,
    why: 'Tears down the one-off description PTY this module just spawned (timeout path and finally path).',
  },
  'src/lib/server/generateDescription.ts::subscribeTerminal': {
    tier: 'pty-only-by-design',
    count: 1,
    why: 'Reads the output of the one-off description PTY this module just spawned.',
  },
  'src/lib/server/generateSkill.ts::killTerminal': {
    tier: 'pty-only-by-design',
    count: 1,
    why: 'Tears down the one-off skill-generation PTY this module just spawned.',
  },
  'src/lib/server/generateSkill.ts::subscribeTerminal': {
    tier: 'pty-only-by-design',
    count: 1,
    why: 'Reads the output of the one-off skill-generation PTY this module just spawned.',
  },
  'src/lib/server/generateTaskTitle.ts::killTerminal': {
    tier: 'pty-only-by-design',
    count: 1,
    why: 'Tears down the one-off title-generation PTY this module just spawned.',
  },
  'src/lib/server/generateTaskTitle.ts::subscribeTerminal': {
    tier: 'pty-only-by-design',
    count: 1,
    why: 'Reads the output of the one-off title-generation PTY this module just spawned.',
  },
  'src/lib/server/swarmOverseerBrain.ts::killTerminal': {
    tier: 'pty-only-by-design',
    count: 2,
    why: 'Tears down the one-off overseer-brain PTY this module just spawned (abort path and finally path).',
  },
  'src/lib/server/swarmOverseerBrain.ts::subscribeTerminal': {
    tier: 'pty-only-by-design',
    count: 1,
    why: 'Reads the output of the one-off overseer-brain PTY this module just spawned.',
  },
  'src/lib/server/claudeTerminal.ts::writeInput': {
    tier: 'pty-only-by-design',
    count: 2,
    why: 'launchClaude writing the initial prompt / an interrupt into the PTY it just created. The handle cannot be anything else.',
  },
  'src/lib/server/claudeTerminal.ts::killTerminal': {
    tier: 'pty-only-by-design',
    count: 1,
    why: 'launchClaude tearing down the PTY it just created when the launch fails.',
  },

  // the engine
  'src/lib/server/swarmOrchestrator.ts::killTerminal': {
    tier: 'pty-only-by-design',
    count: 2,
    why: 'The adversarial review panel runs each lens as its own one-off PTY it spawns and kills (abort path and finally path). Reviewers are not roster workers and never run on the SDK runtime.',
  },
  'src/lib/server/swarmOrchestrator.ts::subscribeTerminal': {
    tier: 'pty-only-by-design',
    count: 1,
    why: 'Buffers the output of one adversarial-review-panel PTY the same function just spawned.',
  },
  'src/lib/server/swarmOrchestrator.ts::getTerminal': {
    tier: 'runtime-dispatched',
    count: 1,
    why: "The consumption read's pty arm: `opts.sdkSessionId ? getSdkSession(...) : getTerminal(opts.terminalId)`. Reading the PTY pool with an SDK worker's empty id used to return undefined, which read as 'no JSONL' and dropped every SDK worker out of the fuel journal.",
  },
  'src/lib/server/swarmOrchestrator.ts::waitForTerminalGone': {
    tier: 'runtime-dispatched',
    count: 1,
    why: "The teardown's pty arm: `if (sdkId) await waitForSdkSessionGone(...) else await waitForTerminalGone(...)`. Waiting on the wrong pool returns instantly and authorises removing the worktree under a live claude.",
  },
  // (swarmOrchestrator.ts::writeInput was declared OPEN here until 2026-08-01 —
  // defaultInstructRework typed a one-line 差し戻し straight into a worker PTY,
  // which for an SDK worker meant writing into ''. It was deleted rather than
  // dispatched, and instructRework is now deliberately unwired. The entry is
  // gone and OPEN_BUDGET went down by one, which is the only direction it may
  // move without a deliberate edit.)
}

// ─── scan D: SDK liveness ───────────────────────────────────────────────────

/**
 * A comparison of some `status` against a terminal-looking literal, in a file
 * that actually deals with SDK sessions.
 *
 * The SDK-awareness filter is not decoration — without it this fires on
 * swarmSelfSupply's `a.status !== 'failed'`, which is reading a VITEST assertion
 * result. A guard that reports a test-report parser as an SDK liveness bug
 * teaches its readers to skim past it.
 */
const statusLivenessIn = (rel: string, codeWithStrings: string, sdkAware: boolean): string[] => {
  if (!sdkAware) return []
  const re =
    /(?:[\w$]+(?:\s*[.?]\s*[\w$]+)*)\s*[!=]==\s*['"](?:exited|closed|failed)['"]|['"](?:exited|closed|failed)['"]\s*[!=]==/g
  const out: string[] = []
  for (;;) {
    const m = re.exec(codeWithStrings)
    if (!m) break
    out.push(`${rel}:${lineAt(codeWithStrings, m.index)} — ${m[0].replace(/\s+/g, ' ')}`)
  }
  return out
}

/** Per-file declarations for the status-literal comparisons above. */
const STATUS_SITES: Record<string, Decl & { count: number }> = {
  'src/components/canvas/modules/SdkWorkerPane.tsx': {
    tier: 'display-only',
    count: 4,
    why: "Two uses, neither a liveness question. (a) Picks WHICH terminal label to draw ('failed' vs 'exited'). (b) Feeds `accepting` — will the POOL still take input — which is a question about `closed`, not about whether claude has gone; a terminal status is simply that same fact arriving one frame earlier than a re-read. It authorises nothing: the pane closing costs a redraw, not a worktree, and the liveness question one line above it is answered by the server's reaped flag.",
  },
  'src/lib/server/swarmWorker.ts': {
    tier: 'runtime-dispatched',
    count: 1,
    why: "Not a liveness question: a session that died INSIDE spawnSdkSession reports 'failed' synchronously, and this IS the runtime-dispatch decision — degrade to a PTY worker on the same worktree rather than fail the dispatch. A seated worker's liveness goes through runtimeOf(w).isAlive, which reads reaped.",
  },
  [SDK_MODULE]: {
    tier: 'sdk-live-predicate',
    count: 2,
    why: "The body of the deprecated isSdkSessionAlive, kept only so two suites can pin the trap it represents ('the old signal already says gone, the real one does not'). The ban below holds it to this one definition site.",
  },
  'src/lib/server/swarmManagerRuntime.ts': {
    // 'runtime-dispatched', not 'display-only': the guard is right that a
    // SERVER-side status read authorises something. Here what it authorises is
    // narrow and deliberate — whether a PANE may adopt this desk — and the file
    // is SDK-aware (it branches on runtime throughout).
    tier: 'runtime-dispatched',
    count: 2,
    why: "NOT a liveness question — the opposite one. listManagerDesks deliberately selects on `reaped` so a desk that was ASKED to stop is still listed (the singleton guard must keep seeing it, or a twin spawns on top of an unwinding commander). These two literals only set `stopping`, which answers 'may a PANE adopt this desk?': a terminate flips status synchronously, and adopting a desk mid-teardown is how 停止 stopped sticking on a wedged session (2026-08-03 overnight review). Liveness for a seated desk is still isManagerDeskAlive → isSdkSessionLive → reaped, one function below.",
  },
  'src/lib/server/swarmManager.ts': {
    tier: 'runtime-dispatched',
    count: 3,
    why: "Two different non-liveness reads. (a) The spawn-time one: a session that died INSIDE spawnSdkSession reports 'failed' synchronously, and this is the runtime-dispatch decision itself — drop it and seat a PTY commander instead. (b) The death-on-arrival watch reads the pool's ANNOUNCED terminal status frame, which is the SDK counterpart of onTerminalExit — it is a death notice arriving, not a question about whether the desk is alive. Liveness for a seated desk is isManagerDeskAlive, which reads reaped.",
  },
}

// ─── the OPEN ratchet ───────────────────────────────────────────────────────
//
// OPEN is the escape hatch, so it needs a cost. Two rules, and they are honest
// about what a guard can and cannot do: nothing here can stop a determined
// edit. What it CAN do is make the edit impossible to make QUIETLY.
//
//   1. the ratchet — the number of OPEN declarations may not exceed the budget;
//   2. NO SLACK — the budget must EQUAL the number of OPEN declarations.
//
// Together those mean adding a hole requires editing this number on a line that
// says it may only go down, in the same diff, next to an `impact` sentence
// describing what breaks. Three deliberate acts instead of one silent one.
//
// THIS NUMBER MAY ONLY GO DOWN. (7 → 6 on 2026-08-01, when defaultInstructRework
// was deleted rather than given an SDK arm.)
const OPEN_BUDGET = 6

// ─── the assertions ─────────────────────────────────────────────────────────

const allFacts = (): FileFacts[] => {
  const pool = poolFns()
  const sdkApi = sdkFnsAll()
  return sweptFiles().map((f) => factsOf(f, pool, sdkApi))
}

/** Structural checks a tier makes about its FILE, beyond the prose. */
const tierComplaint = (d: Decl, sdkAware: boolean, rel: string): string | null => {
  if (d.why.trim().length < MIN_WHY) {
    return `the reason is ${d.why.trim().length} chars — say WHY the tier is honest, not just that it applies`
  }
  if (d.tier === 'OPEN' && (d.impact ?? '').trim().length < MIN_WHY) {
    return "tier 'OPEN' requires an 'impact' naming what breaks with the SDK dial on"
  }
  if (d.tier !== 'OPEN' && d.impact !== undefined) {
    return `only tier 'OPEN' carries an 'impact'; this one is ${d.tier}`
  }
  if ((d.tier === 'pty-only-by-design' || d.tier === 'OPEN') && sdkAware) {
    return (
      `declared '${d.tier}' — which promises the file does not know the SDK runtime — but it ` +
      `names ${witnessIn(sweptFiles().find((f) => f.rel === rel)!.code).join(', ')}. ` +
      `Either it now dispatches (re-tier it) or it half-does (that is the defect)`
    )
  }
  if (
    (d.tier === 'runtime-dispatched' || d.tier === 'both-pools' || d.tier === 'sdk-live-predicate') &&
    !sdkAware
  ) {
    return (
      `declared '${d.tier}' — which promises it reaches the SDK runtime — but it names NO SDK ` +
      `symbol at all. The dispatch was removed, or it was never there`
    )
  }
  if (d.tier === 'display-only' && !rel.startsWith('src/components/')) {
    return `tier 'display-only' is for client components; ${rel} is server code, where a status read authorises actions`
  }
  return null
}

describe('worker addressing — every file that reaches a worker or a desk is declared', () => {
  it('finds a non-empty surface at all', () => {
    const touching = allFacts().filter(touchesSurface)
    // A scan that returns nothing is indistinguishable from a clean tree, and
    // "clean" is the answer this whole suite exists because it was believed
    // once too often. The real number is around forty; ten is a floor that
    // catches a broken masker or a broken enumeration without pinning a count
    // that five concurrent editors would churn.
    expect(
      touching.length,
      `the scan found ${touching.length} files touching the worker-addressing surface. ` +
        `That is far too few to be true — every swarm module names terminalId. Something ` +
        `in the enumeration or in maskSource is broken; do NOT read this as "nothing to ` +
        `declare".`,
    ).toBeGreaterThan(10)
  })

  it('has no undeclared file, and no stale declaration', () => {
    const facts = allFacts()
    const touching = facts.filter(touchesSurface)

    const undeclared = touching
      .filter((x) => !(x.rel in FILES))
      .map(
        (x) =>
          `${x.rel}\n` +
          `      names terminalId: ${x.namesTerminalId}\n` +
          `      pty pool fns:     ${ptyFnsFor(x).join(', ') || '(none)'}\n` +
          `      sdk liveness:     ${x.sdkLiveness.join(', ') || '(none)'}\n` +
          `      sdk-aware:        ${x.sdkAware}`,
      )
    expect(
      undeclared,
      `A production file started addressing a worker or a desk and is not in FILES.\n` +
        `This is the event the whole file exists to interrupt — every one of the fifteen\n` +
        `defects looked exactly like this the day it was written.\n\n` +
        `Add an entry with a tier:\n` +
        `  'pty-only-by-design'  the op only means anything for a PTY, and the file knows\n` +
        `                        nothing about SDK sessions (this is CHECKED).\n` +
        `  'runtime-dispatched'  reached via workerKey / runtimeOf / deliverAnswerToWorker,\n` +
        `                        or an explicit sdkId branch (file must be SDK-aware).\n` +
        `  'both-pools'          asks BOTH pools in one call — see liveDesks.ts.\n` +
        `  'sdk-live-predicate'  SDK liveness from reaped, never from status.\n` +
        `  'display-only'        a client component reading status to DRAW something.\n` +
        `  'OPEN'                still PTY-only, knowingly — costs an OPEN_BUDGET slot and\n` +
        `                        must state its impact.\n` +
        `…plus the SET of pool functions it uses (printed above), and one honest sentence.\n\n` +
        `  ${undeclared.join('\n  ')}`,
    ).toEqual([])

    const stale = Object.keys(FILES).filter(
      (rel) => !touching.some((x) => x.rel === rel),
    )
    expect(
      stale,
      `FILES declares entries for files that no longer touch this surface (or are gone).\n` +
        `Remove them. A dead entry makes the inventory look more complete than it is —\n` +
        `the exact failure mode docs/MAP.md §5 records for the "the seams are six" commit.\n\n` +
        `  ${stale.join('\n  ')}`,
    ).toEqual([])
  })

  it('has no declaration whose basis has collapsed', () => {
    const problems: string[] = []
    for (const x of allFacts().filter(touchesSurface)) {
      const d = FILES[x.rel]
      if (!d) continue // reported by the assertion above
      // ⚠ THE SDK ARM IS INVENTORIED BY SET, exactly like `ptyFns`. Without
      // this, deleting one dispatch arm left every other SDK token in the file
      // standing, so the strongest tiers could not be falsified at all — four
      // production mutations, each the literal harm this file names, all stayed
      // green (see scan A′). A promise that cannot fail is not a promise.
      if (d.sdkCalls !== undefined) {
        const gone = d.sdkCalls.filter((fn) => !x.sdkCalls.includes(fn))
        const added = x.sdkCalls.filter((fn) => !d.sdkCalls!.includes(fn))
        if (gone.length) {
          problems.push(
            `ARM GONE    ${x.rel} — declared as calling ${gone.join(', ')}, and it no longer ` +
              `does. An SDK dispatch arm was deleted while its PTY sibling stayed. If that ` +
              `was deliberate, the tier is no longer honest either.`,
          )
        }
        if (added.length) {
          problems.push(
            `ARM NEW     ${x.rel} — now calls ${added.join(', ')}. Confirm the tier still ` +
              `describes the file, then add them to sdkCalls.`,
          )
        }
      }
      if (d.sdkHandleFloor !== undefined && x.sdkHandleUses < d.sdkHandleFloor) {
        problems.push(
          `HANDLE LOST ${x.rel} — names sdkSessionId ${x.sdkHandleUses} times, declared floor ` +
            `${d.sdkHandleFloor}. An SDK handle was dropped from an address, a filter or a ` +
            `record. That is how an SDK worker becomes unaddressable without anything failing.`,
        )
      }
      const complaint = tierComplaint(d, x.sdkAware, x.rel)
      if (complaint) problems.push(`${x.rel} — ${complaint}`)

      const declared = [...d.ptyFns].sort()
      const actual = ptyFnsFor(x)
      const added = actual.filter((fn) => !declared.includes(fn))
      const dropped = declared.filter((fn) => !actual.includes(fn))
      if (added.length) {
        problems.push(
          `${x.rel} — now calls PTY pool function(s) it did not before: ${added.join(', ')}. ` +
            `Confirm each one still fits tier '${d.tier}', then add it to ptyFns.`,
        )
      }
      if (dropped.length) {
        problems.push(
          `${x.rel} — no longer calls ${dropped.join(', ')}. Drop it from ptyFns (a stale ` +
            `entry hides the next addition, because the set would still "match").`,
        )
      }
    }
    expect(
      problems,
      `A declaration in FILES no longer describes the file.\n\n  ${problems.join('\n  ')}`,
    ).toEqual([])
  })
})

describe('worker addressing — every PTY call handed a terminalId is declared', () => {
  it('finds the direct-addressing sites at all', () => {
    const pool = poolFns()
    const n = sweptFiles().reduce(
      (acc, f) => acc + addressingSitesIn(f.rel, f.code, pool).length,
      0,
    )
    expect(
      n,
      `the poolFn(<…terminalId…>) scan found NOTHING. There are more than a dozen such ` +
        `calls in this tree; a zero means balancedArgs, maskSource or the pool list is ` +
        `broken. Refusing to read it as "the shape is gone".`,
    ).toBeGreaterThan(5)
  })

  it('has no undeclared site, no stale one, and no miscounted one', () => {
    const pool = poolFns()
    const byKey = new Map<string, Site[]>()
    for (const f of sweptFiles()) {
      for (const s of addressingSitesIn(f.rel, f.code, pool)) {
        const key = `${s.rel}::${s.fn}`
        const at = byKey.get(key)
        if (at) at.push(s)
        else byKey.set(key, [s])
      }
    }

    const problems: string[] = []
    for (const [key, sites] of Array.from(byKey.entries())) {
      const d = SITES[key]
      if (!d) {
        problems.push(
          `UNDECLARED  ${key} ×${sites.length}\n` +
            sites.map((s) => `      L${s.line}  ${s.fn}(${s.args})`).join('\n'),
        )
        continue
      }
      if (d.count !== sites.length) {
        problems.push(
          `COUNT       ${key} — declared ${d.count}, found ${sites.length}. A new direct PTY ` +
            `call appeared (or one went away). Confirm the tier still holds, then update it:\n` +
            sites.map((s) => `      L${s.line}  ${s.fn}(${s.args})`).join('\n'),
        )
      }
      const complaint =
        d.why.trim().length < MIN_WHY
          ? `the reason is too short to be a reason`
          : d.tier === 'OPEN' && (d.impact ?? '').trim().length < MIN_WHY
            ? `tier 'OPEN' requires an 'impact'`
            : null
      if (complaint) problems.push(`PROSE       ${key} — ${complaint}`)

      // The one tier that makes a checkable promise about the SITE itself.
      if (d.tier === 'runtime-dispatched') {
        const blind = sites.filter((s) => s.witnesses.length === 0)
        if (blind.length) {
          problems.push(
            `BASIS GONE  ${key} — declared 'runtime-dispatched', but no SDK counterpart ` +
              `appears within ${SITE_WINDOW_LINES} lines of the call. The sdk arm was ` +
              `deleted, moved out of reach, or was never there — and a PTY-only call in ` +
              `an engine path is exactly the silent defect this file inventories.\n` +
              blind.map((s) => `      L${s.line}  ${s.fn}(${s.args})`).join('\n'),
          )
        }
      }
    }

    const stale = Object.keys(SITES).filter((k) => !byKey.has(k))
    for (const k of stale) {
      problems.push(
        `STALE       ${k} — declared, but the scan no longer finds it. Remove the entry.`,
      )
    }

    expect(
      problems,
      `The direct-addressing inventory no longer matches the tree.\n` +
        `Every entry here is a place that reaches a PTY BY ITS terminalId. For an SDK\n` +
        `worker that id is the empty string, so such a call does not fail — it does\n` +
        `nothing, or it hits somebody else.\n\n  ${problems.join('\n  ')}`,
    ).toEqual([])
  })
})

describe('worker addressing — SDK liveness comes from reaped, never from status', () => {
  it('names isSdkSessionAlive in no production file but its own definition', () => {
    // The predicate's own doc comment states this rule; this is the standing
    // version of it. `terminateSdkSession` flips `status` SYNCHRONOUSLY — it
    // means "we asked it to stop", not "it stopped" — so a consumer that
    // believes it calls a worker DEAD while its claude is still unwinding, and
    // that is the answer which authorises removing the worktree underneath it.
    const offenders = sweptFiles()
      .filter((f) => f.rel !== SDK_MODULE && has(f.code, 'isSdkSessionAlive'))
      .map((f) => f.rel)
    expect(
      offenders,
      `isSdkSessionAlive answers from 'status', which is flipped the moment a stop is\n` +
        `REQUESTED. Use isSdkSessionLive(s) for a snapshot, or isSdkSessionReaped(id)\n` +
        `when you are about to touch the session's directory.\n\n  ${offenders.join('\n  ')}`,
    ).toEqual([])
  })

  it('has no undeclared file reading SDK liveness', () => {
    const facts = allFacts().filter((x) => x.sdkLiveness.length > 0)
    expect(
      facts.length,
      `no file names reaped / isSdkSessionLive / isSdkSessionReaped at all — the scan is ` +
        `broken, not the tree.`,
    ).toBeGreaterThan(3)
    const undeclared = facts
      .filter((x) => !(x.rel in FILES))
      .map((x) => `${x.rel} — ${x.sdkLiveness.join(', ')}`)
    expect(
      undeclared,
      `A file started asking whether an SDK session is alive and is not in FILES.\n` +
        `Declare it (see the tier list above), and check it asks via reaped.\n\n` +
        `  ${undeclared.join('\n  ')}`,
    ).toEqual([])
  })

  it('has every status-vs-terminal-literal comparison declared, with a count', () => {
    const found = new Map<string, string[]>()
    for (const f of sweptFiles()) {
      const hits = statusLivenessIn(f.rel, f.codeWithStrings, isSdkAware(f))
      if (hits.length) found.set(f.rel, hits)
    }
    expect(
      found.size,
      `no status-literal comparison found in any SDK-aware file — sdkSession.ts alone ` +
        `contains two (the body of isSdkSessionAlive). The literal-preserving mask is ` +
        `broken.`,
    ).toBeGreaterThan(0)

    const problems: string[] = []
    for (const [rel, hits] of Array.from(found.entries())) {
      const d = STATUS_SITES[rel]
      if (!d) {
        problems.push(`UNDECLARED  ${rel} ×${hits.length}\n${hits.map((h) => `      ${h}`).join('\n')}`)
        continue
      }
      if (d.count !== hits.length) {
        problems.push(
          `COUNT       ${rel} — declared ${d.count}, found ${hits.length}:\n` +
            hits.map((h) => `      ${h}`).join('\n'),
        )
      }
      if (d.why.trim().length < MIN_WHY) problems.push(`PROSE       ${rel} — reason too short`)
      if (d.tier === 'display-only' && !rel.startsWith('src/components/')) {
        problems.push(
          `TIER        ${rel} — 'display-only' is for client components. On the server a ` +
            `status read authorises actions, and that is the defect.`,
        )
      }
    }
    for (const rel of Object.keys(STATUS_SITES)) {
      if (!found.has(rel)) problems.push(`STALE       ${rel} — declared, no longer found.`)
    }
    expect(
      problems,
      `A status comparison in an SDK-aware file is undeclared or has changed.\n` +
        `If it decides LIVENESS, it is a defect: use isSdkSessionLive / isSdkSessionReaped.\n` +
        `If it only decides what to DRAW, or reads a spawn-time 'failed', say so.\n\n` +
        `  ${problems.join('\n  ')}`,
    ).toEqual([])
  })
})

// ─── scan D: terminalId used as an IDENTITY ─────────────────────────────────
//
// WHY THIS SCAN EXISTS, AND WHY IT WAS ADDED AFTER THE OTHERS. Scans B and C
// find a terminalId being handed to the PTY POOL. They are blind to the shape
// that costs the most: a terminalId used as the worker's NAME — a map key, a
// lookup, an equality test, a template that builds an id. For a PTY worker that
// name is unique. For an SDK worker it is `''`, so every SDK worker in the fleet
// collapses onto ONE entry.
//
// That is not hypothetical. `S4:${w.terminalId}` was the overseer's
// dedup key: with the dial on, the FIRST SDK worker's escalation took the single
// slot and every later worker's was discarded as a duplicate — silently, in the
// channel whose entire job is to not lose a worker's question. It was found by a
// reviewer reading the file, and when this inventory was first written it could
// not catch it: the file already named terminalId, so scan B saw no change, and
// nothing was handed to a pool function, so scan C saw nothing at all. Measured
// 2026-08-01 by planting `` `S9:${w.terminalId}` `` in a declared file — all 33
// tests stayed green.
//
// The rule this encodes: **`terminalId` may be a HANDLE, never an IDENTITY.**
// `workerKey(w)` is the identity, and it is total over both runtimes.
const IDENTITY_SHAPES: { name: string; re: RegExp; what: string }[] = [
  {
    name: 'interpolated',
    re: /`[^`\n]*\$\{[^}]*\bterminalId\b[^}]*\}[^`\n]*`/g,
    what: 'built into a string id (the `S4:${w.terminalId}` shape)',
  },
  {
    name: 'map-keyed',
    re: /\.(?:get|set|has|delete)\s*\(\s*[^),\n]*\bterminalId\b/g,
    what: 'used as a Map/Set key',
  },
  {
    name: 'compared',
    re: /\bterminalId\s*(?:===|!==)|(?:===|!==)\s*[A-Za-z_$][\w$.]*\.terminalId\b/g,
    what: 'compared for identity (=== / !==)',
  },
]

/** How close the sibling handle must be to count as this use's basis. Tight on
 *  purpose: the claim is "this very comparison also asks the SDK half", not
 *  "the file knows SDK exists somewhere". */
const IDENTITY_BASIS_LINES = 8

interface IdentityUse {
  rel: string
  shape: string
  line: number
  text: string
  sdkBasis: boolean
}

/** Pure matcher, so the teeth below can exercise it on literal source. */
const identityUsesIn = (rel: string, code: string): IdentityUse[] => {
  const lines = code.split('\n')
  const out: IdentityUse[] = []
  for (const shape of IDENTITY_SHAPES) {
    const re = new RegExp(shape.re.source, 'g')
    for (;;) {
      const m = re.exec(code)
      if (!m) break
      const line = lineAt(code, m.index)
      const from = Math.max(0, line - 1 - IDENTITY_BASIS_LINES)
      out.push({
        rel,
        shape: shape.name,
        line,
        text: m[0].replace(/\s+/g, ' ').trim().slice(0, 70),
        // The SIBLING half of the identity, within arm's reach of this use.
        sdkBasis: has(lines.slice(from, line + IDENTITY_BASIS_LINES).join('\n'), 'sdkSessionId'),
      })
    }
  }
  return out.sort((a, b) => a.line - b.line)
}

/**
 * Every place a terminalId becomes an identity, declared per (file, shape) with
 * a COUNT — the same ratchet scan C uses, for the same reason: this set is small
 * and it only changes when somebody names a worker by its PTY handle again.
 */
const IDENTITY_SITES: Record<string, Decl & { count: number }> = {
  // ── the PTY pool's own internals: there is no second runtime in here ──
  'src/lib/server/terminal.ts::map-keyed': {
    tier: 'pty-only-by-design',
    count: 2,
    why: 'The node-pty pool indexing ITS OWN sessions map. The id is the handle it minted; an SDK session is not in this map and never will be.',
  },
  'src/components/canvas/modules/CustomModuleView.tsx::interpolated': {
    tier: 'pty-only-by-design',
    count: 1,
    why: 'Builds the /api/terminal/:id/paste-custom-module URL for a custom tab, which is a PTY terminal pane by construction — there is no SDK equivalent of a custom module desk.',
  },
  'src/components/canvas/modules/BoardSupplyDock.tsx::map-keyed': {
    tier: 'pty-only-by-design',
    count: 3,
    why: "The dock's own exitedIds set and the live-beacon map, keyed by the SUPPLY desk's terminalId. That desk is PTY-only by design, so there is no SDK handle this could ever have to carry; the fleet monitor in the same file addresses WORKERS through engineWorkerKey instead, which is total over both runtimes.",
  },
  'src/components/canvas/modules/useSupplyDesk.ts::map-keyed': {
    tier: 'pty-only-by-design',
    count: 1,
    why: "The desk-reconcile's storedDead probe — does the caller's exitedIds hold the STORED supply desk's id. Same reason as the dock above: the supply desk is PTY-only, so terminalId IS its whole address. (This is the supply half of what SwarmModule.tsx::map-keyed used to declare; it moved here with the hook, and SwarmModule's count dropped by one to match.)",
  },
  'src/components/canvas/modules/useSupplyDesk.ts::compared': {
    tier: 'pty-only-by-design',
    count: 2,
    why: "Two PTY-scoped identity tests on the supply desk, which has no SDK form: the persisted record's shape check on rehydrate (`typeof r.terminalId !== 'string'` ⇒ reject), and the just-stopped guard that refuses to re-adopt the one handle the owner just asked to die (without it, 停止 loses to the next poll).",
  },
  'src/components/canvas/modules/SwarmModule.tsx::map-keyed': {
    tier: 'pty-only-by-design',
    count: 5,
    why: "statusOfPty's own three maps (exitedIds / statusByPty / seenRef). The name says the scope: an SDK desk's status comes from the SDK pane's own stream, and feeding '' in here would read the PTY map's absent entry as 'starting' forever. 0803 (+2): the desk-reconcile effect asks exitedIds whether the STORED desk is confirmed dead before clearing it — the manager probe uses `terminalId || sdkSessionId` (both-runtime, the empty-string invariant makes the fallback correct). 0815 (6 → 5): the SUPPLY probe left with the desk itself — its state moved into useSupplyDesk so the Board's front-desk seat and this tab drive ONE record, and its declaration moved with it.",
  },
  'server/routes/swarm.ts::interpolated': {
    tier: 'runtime-dispatched',
    count: 1,
    why: "The 400 message naming WHICH handle the declared runtime requires — `runtime === 'sdk' ? 'sdkSessionId' : 'terminalId'`. It is the error text of the check that enforces the pairing, not a key built from a handle; the value never leaves the sentence.",
  },
  'server/routes/swarm.ts::compared': {
    tier: 'pty-only-by-design',
    count: 2,
    why: "Body validation — `typeof body?.terminalId === 'string'`, i.e. is this field present and of the right shape. Not a worker identity test: the handle it validates is passed on WHOLE (with runtime + sdkSessionId beside it) for the engine to dispatch on.",
  },
  'src/components/canvas/modules/SwarmModule.tsx::compared': {
    tier: 'pty-only-by-design',
    count: 1,
    why: "The same shape check on a persisted record being rehydrated (`typeof r.terminalId !== 'string'` ⇒ reject). The SDK branch immediately below demands sdkSessionId for an 'sdk' record, which is the identity half. 0815 (2 → 1): the SUPPLY record's copy of that check moved to useSupplyDesk with the desk it belongs to.",
  },

  // ── asks the identity question correctly, over BOTH runtimes ──
  'src/components/canvas/modules/useSwarmEngine.ts::compared': {
    tier: 'runtime-dispatched',
    count: 1,
    why: "The runtime/handle sibling test on the roster row. The FILTER beside it no longer compares at all — `typeof '' === \'string\'` admitted a row addressable in neither pool, so it asks `Boolean(handle)` instead — which is why this count went 2 → 1.",
  },
  'src/lib/server/swarmEscalations.ts::compared': {
    tier: 'runtime-dispatched',
    count: 1,
    why: 'Dedup compares the WHOLE address field by field (runtime, terminalId, sdkSessionId), so a re-raise from a different worker is not folded into an existing row.',
  },
  'src/components/canvas/modules/BoardModule.tsx::compared': {
    tier: 'runtime-dispatched',
    count: 2,
    why: "The board's re-render suppressor, comparing BOTH handles. With terminalId alone it answered `'' === ''` for every SDK worker, so a card whose worker was replaced by a new SDK session kept the stale record and the drawer addressed a dead id. 0815 (+1): the same suppressor for the published SUPPLY desk handle — that desk is PTY-only, and the comparison is on `handleId`, the runtime-neutral name the wire uses, with `runtime` compared beside it.",
  },
  'src/components/canvas/modules/BoardModule.tsx::map-keyed': {
    tier: 'display-only',
    count: 1,
    why: "markWorkerScreenExited's set of PTY screens that have ended. It gates a PTY screen strip only; an SDK worker's tile is a different component with its own stream, so an '' entry here darkens nothing.",
  },

  // ── prose about the rule, inside the dispatcher that enforces it ──
  'src/lib/server/workerRuntime.ts::interpolated': {
    tier: 'runtime-dispatched',
    count: 1,
    why: "workerKey's own throw message — `${kind} ${kind === 'sdk' ? 'sdkSessionId' : 'terminalId'}` — naming which handle was missing. This is the function that MAKES the identity; the interpolation is its error text.",
  },
}

describe('worker addressing — a terminalId is a HANDLE, never an IDENTITY', () => {
  it('finds identity uses at all', () => {
    const n = sweptFiles().reduce((acc, f) => acc + identityUsesIn(f.rel, f.code).length, 0)
    expect(
      n,
      `the identity-shape scan found NOTHING. This tree compares and keys on ` +
        `terminalId in several places; a zero means the regexes or maskSource ` +
        `broke. Refusing to read it as "nobody names a worker by its PTY handle".`,
    ).toBeGreaterThan(3)
  })

  it('has every identity use declared, with a count', () => {
    const byKey = new Map<string, IdentityUse[]>()
    for (const f of sweptFiles()) {
      for (const u of identityUsesIn(f.rel, f.code)) {
        const key = `${u.rel}::${u.shape}`
        const at = byKey.get(key)
        if (at) at.push(u)
        else byKey.set(key, [u])
      }
    }

    const problems: string[] = []
    for (const [key, uses] of Array.from(byKey.entries())) {
      const d = IDENTITY_SITES[key]
      if (!d) {
        problems.push(
          `UNDECLARED  ${key} ×${uses.length}\n` +
            uses.map((u) => `      L${u.line}  ${u.text}`).join('\n'),
        )
        continue
      }
      if (d.count !== uses.length) {
        problems.push(
          `COUNT       ${key} — declared ${d.count}, found ${uses.length}\n` +
            uses.map((u) => `      L${u.line}  ${u.text}`).join('\n'),
        )
      }
      // ⚠ THE COUNT CANNOT SEE A SIBLING BEING DELETED. Removing
      // `p.sdkSessionId === w.sdkSessionId` from a two-handle comparison leaves
      // the terminalId use — and the count — untouched, while turning the test
      // back into `'' === ''` for every SDK worker. Measured 2026-08-01: that
      // exact deletion kept all 36 tests green until this check existed.
      if (d.tier === 'runtime-dispatched') {
        const blind = uses.filter((u) => !u.sdkBasis)
        if (blind.length) {
          problems.push(
            `BASIS GONE  ${key} — declared 'runtime-dispatched', but no sdkSessionId ` +
              `appears within ${IDENTITY_BASIS_LINES} lines. The half that makes this ` +
              `a two-runtime identity was deleted or moved out of reach, and what is ` +
              `left answers '' === '' for every SDK worker.\n` +
              blind.map((u) => `      L${u.line}  ${u.text}`).join('\n'),
          )
        }
      }
    }
    for (const key of Object.keys(IDENTITY_SITES)) {
      if (!byKey.has(key)) problems.push(`STALE       ${key} — declared but no longer present`)
    }

    expect(
      problems,
      `A terminalId became a worker's NAME somewhere new.\n\n` +
        `For a PTY worker that name is unique; for an SDK worker it is '' — so every\n` +
        `SDK worker in the fleet collapses onto ONE entry, and whatever this key\n` +
        `guards (dedup, cancellation, a pending map) silently applies to the first\n` +
        `one only. That is the \`S4:\${w.terminalId}\` defect, which discarded every\n` +
        `SDK worker's escalation but the first.\n\n` +
        `The fix is almost always \`workerKey(w)\` — total over both runtimes. If this\n` +
        `use really is PTY-scoped (a PTY-pool-internal map, a DELETE route's own id),\n` +
        `declare it below with the one line that says why it can never see an SDK\n` +
        `worker.\n\n` +
        problems.join('\n'),
    ).toEqual([])
  })

  it('the scan sees the real defect shape and ignores prose', () => {
    // The exact line that shipped, and the exact line that must not count.
    expect(identityUsesIn('x.ts', 'const k = `S4:${w.terminalId}`\n').map((u) => u.shape)).toEqual([
      'interpolated',
    ])
    expect(identityUsesIn('x.ts', 'seen.set(w.terminalId, 1)\n').map((u) => u.shape)).toEqual([
      'map-keyed',
    ])
    expect(identityUsesIn('x.ts', 'if (x.terminalId === id) return\n').map((u) => u.shape)).toEqual([
      'compared',
    ])
    // Prose is not a use. maskSource blanks comments before any scan runs, so
    // the warning that TELLS you not to do this cannot trip it.
    expect(identityUsesIn('x.ts', maskSource('// never key on `S4:${w.terminalId}`\n', false))).toEqual([])
    // …and the basis is judged per USE, not per file: a comparison that asks
    // both halves records it, one that asks only the PTY half does not.
    expect(identityUsesIn('x.ts', 'a.terminalId === b.terminalId\n')[0].sdkBasis).toBe(false)
    expect(
      identityUsesIn('x.ts', 'a.terminalId === b.terminalId &&\na.sdkSessionId === b.sdkSessionId\n')[0]
        .sdkBasis,
    ).toBe(true)
  })
})

describe('worker addressing — OPEN is a ratchet, not a hatch', () => {
  const openEntries = (): string[] => [
    ...Object.entries(FILES)
      .filter(([, d]) => d.tier === 'OPEN')
      .map(([k]) => `FILES  ${k}`),
    ...Object.entries(SITES)
      .filter(([, d]) => d.tier === 'OPEN')
      .map(([k]) => `SITES  ${k}`),
    ...Object.entries(STATUS_SITES)
      .filter(([, d]) => d.tier === 'OPEN')
      .map(([k]) => `STATUS ${k}`),
  ]

  it('stays within the budget', () => {
    const open = openEntries()
    expect(
      open.length,
      `${open.length} OPEN declarations against a budget of ${OPEN_BUDGET}.\n` +
        `Every OPEN is a place the SDK runtime is knowingly not reached. Close one\n` +
        `before opening another, or raise the budget deliberately — the line saying it\n` +
        `may only go down is right above the constant.\n\n  ${open.join('\n  ')}`,
    ).toBeLessThanOrEqual(OPEN_BUDGET)
  })

  it('leaves no headroom in the budget', () => {
    // Without this, a budget of 20 against 7 holes would absorb thirteen new
    // ones in silence, and the ratchet above would report a serene green for
    // each. Pinning them equal is what forces the number to move in the SAME
    // diff as the hole — which is the only deterrent a guard can actually offer.
    expect(
      openEntries().length,
      `OPEN_BUDGET (${OPEN_BUDGET}) must EQUAL the number of OPEN declarations ` +
        `(${openEntries().length}). Spare headroom is a hatch that swallows the next few ` +
        `holes without a word.`,
    ).toBe(OPEN_BUDGET)
  })

  it('makes every OPEN state what it costs', () => {
    const thin = [
      ...Object.entries(FILES),
      ...Object.entries(SITES),
      ...Object.entries(STATUS_SITES),
    ]
      .filter(([, d]) => d.tier === 'OPEN')
      .filter(([, d]) => (d.impact ?? '').trim().length < MIN_WHY)
      .map(([k]) => k)
    expect(
      thin,
      `An OPEN declaration without an 'impact' is a TODO with better formatting.\n` +
        `Say what actually breaks with the SDK dial on — writing that sentence is the\n` +
        `only part of this that does any work.\n\n  ${thin.join('\n  ')}`,
    ).toEqual([])
  })
})

// ─── the scans' own teeth ───────────────────────────────────────────────────
//
// Every assertion above reports "[]" — the same answer for "nothing is wrong"
// and for "I looked at nothing". These tell those apart by feeding the pure
// matchers synthetic sources, so the coverage claims are STANDING rather than a
// one-time re-read (which is exactly the practice this file replaces).
//
// Fixtures are assembled from pieces where a verbatim copy would make this file
// its own top offender — the self-reference trap the sibling guard keeps
// re-learning. (This file is excluded from the sweep anyway, by isTestPath.)

describe('worker addressing — the scans themselves have teeth', () => {
  const POOL = ['killTerminal', 'writeInput', 'getTerminal', 'waitForTerminalGone']

  describe('maskSource', () => {
    it('does not let a comment satisfy the scan', () => {
      // The trap this file records as already sprung: workerRuntime.ts's header
      // spells `w.terminalId` four times while telling you not to write it.
      const prose = '// never call killTerminal(w.terminalId) — use runtimeOf(w).kill\n'
      expect(addressingSitesIn('src/lib/server/x.ts', maskSource(prose, false), POOL)).toEqual([])
      const block = ['/*', ' * killTerminal(w.terminalId) is the old shape', ' */'].join('\n')
      expect(addressingSitesIn('src/lib/server/x.ts', maskSource(block, false), POOL)).toEqual([])
    })

    it('does not let a string literal satisfy the scan', () => {
      const s = "const msg = 'killTerminal(w.terminalId)'\n"
      expect(addressingSitesIn('src/lib/server/x.ts', maskSource(s, false), POOL)).toEqual([])
    })

    it('KEEPS a template interpolation, which is code', () => {
      // `writeInput(id, `${line}\r`)` is a real call in swarmOrchestrator; a
      // masker that blanked the whole template would still see the call, but a
      // masker that blanked `${…}` would lose an argument that can name the
      // handle. Proven directly: the interpolation IS the terminalId.
      const src = 'writeInput(`${terminalId}`, x)\n'
      expect(addressingSitesIn('src/lib/server/x.ts', maskSource(src, false), POOL)).toHaveLength(1)
    })

    it('preserves line numbers through masking', () => {
      const src = ['// a comment', "const s = 'text'", 'killTerminal(w.terminalId)'].join('\n')
      const sites = addressingSitesIn('src/lib/server/x.ts', maskSource(src, false), POOL)
      expect(sites).toHaveLength(1)
      expect(sites[0].line).toBe(3)
    })

    it('keeps string CONTENT when asked, for the literal-sensitive scan', () => {
      const src = "if (s.status === 'exited') return\n"
      expect(statusLivenessIn('src/lib/server/y.ts', maskSource(src, true), true)).toHaveLength(1)
      // …and the identifier mask would have hidden it, which is why there are two.
      expect(statusLivenessIn('src/lib/server/y.ts', maskSource(src, false), true)).toEqual([])
    })
  })

  describe('the pool API surface is derived', () => {
    it('reads every export style terminal.ts uses', () => {
      const src = [
        'export const alpha = (id: string) => {}',
        'export function beta() {}',
        'export async function gamma() {}',
        'export interface NotAFunction { x: number }',
        'const notExported = 1',
      ].join('\n')
      expect(poolExportsOf(src)).toEqual(['alpha', 'beta', 'gamma'])
    })

    it('is what the real terminal.ts yields — not a list kept here', () => {
      // If poolExportsOf ever stops matching the real file's style it returns
      // [], every later scan finds nothing, and every assertion goes green. The
      // scan-A test pins the count; this pins that the derivation is REAL by
      // naming functions the tree must still have.
      const exported = poolExportsOf(fileNamed(TERMINAL_MODULE).code)
      expect(exported).toContain('killTerminal')
      expect(exported).toContain('listActiveTerminals')
    })
  })

  describe('addressingSitesIn', () => {
    it('sees a call wrapped across lines by prettier', () => {
      const src = ['killTerminal(', '  ref.terminalId,', ')'].join('\n')
      expect(addressingSitesIn('src/lib/server/x.ts', maskSource(src, false), POOL)).toHaveLength(1)
    })

    it('reads past a nested call in the argument list', () => {
      // A naive "up to the first )" would cut `join(a, b)` in half and lose the
      // handle that follows it.
      const src = 'writeInput(mapOf(a, b).terminalId, text)\n'
      expect(addressingSitesIn('src/lib/server/x.ts', maskSource(src, false), POOL)).toHaveLength(1)
    })

    it('does not fire on a pool call that names no handle', () => {
      expect(
        addressingSitesIn('src/lib/server/x.ts', maskSource('killTerminal(id)\n', false), POOL),
      ).toEqual([])
    })

    it('does not fire on a similarly-named function', () => {
      const src = 'myKillTerminal(w.terminalId)\n'
      expect(addressingSitesIn('src/lib/server/x.ts', maskSource(src, false), POOL)).toEqual([])
    })

    it('collects the SDK witnesses in the window — the runtime-dispatched basis', () => {
      const dispatched = [
        'if (sdkId) await waitForSdkSessionGone(sdkId)',
        'else await waitForTerminalGone(opts.terminalId)',
      ].join('\n')
      const [site] = addressingSitesIn('src/lib/server/x.ts', maskSource(dispatched, false), POOL)
      expect(site.witnesses).toContain('waitForSdkSessionGone')

      // …and the SAME call with its sdk arm deleted collects nothing, which is
      // what turns 'runtime-dispatched' into a claim that can FAIL. This is the
      // regression the fifteen defects were: the pty arm left standing alone.
      const orphaned = 'await waitForTerminalGone(opts.terminalId)\n'
      const [alone] = addressingSitesIn('src/lib/server/x.ts', maskSource(orphaned, false), POOL)
      expect(alone.witnesses).toEqual([])
    })
  })

  describe('statusLivenessIn', () => {
    it('sees the shapes that decide liveness from status', () => {
      expect(statusLivenessIn('a.ts', "e.status !== 'exited'", true)).toHaveLength(1)
      expect(statusLivenessIn('a.ts', "s?.status === 'failed'", true)).toHaveLength(1)
      expect(statusLivenessIn('a.ts', "'exited' === s.status", true)).toHaveLength(1)
    })

    it('stays silent in a file that knows nothing about SDK sessions', () => {
      // The measured false positive: swarmSelfSupply reads a VITEST assertion's
      // `status !== 'failed'`. Reporting that as an SDK liveness bug is how a
      // guard teaches people to skim it.
      expect(statusLivenessIn('src/lib/server/z.ts', "a.status !== 'failed'", false)).toEqual([])
    })

    it('does not fire on an unrelated status value', () => {
      expect(statusLivenessIn('a.ts', "if (r.status === 'ready') go()", true)).toEqual([])
    })
  })

  describe('tierComplaint', () => {
    const long = 'x'.repeat(MIN_WHY + 1)

    it('rejects a reason too short to be a reason', () => {
      expect(tierComplaint({ tier: 'both-pools', why: 'ok' }, true, 'src/lib/server/liveDesks.ts'))
        .toMatch(/reason/)
    })

    it('rejects OPEN without an impact, and impact without OPEN', () => {
      expect(
        tierComplaint({ tier: 'OPEN', why: long }, false, 'src/lib/server/x.ts'),
      ).toMatch(/impact/)
      expect(
        tierComplaint({ tier: 'both-pools', why: long, impact: long }, true, 'src/lib/server/x.ts'),
      ).toMatch(/only tier/)
    })

    it("rejects 'runtime-dispatched' on a file with no SDK symbol — the collapsed basis", () => {
      expect(
        tierComplaint({ tier: 'runtime-dispatched', why: long }, false, 'src/lib/server/x.ts'),
      ).toMatch(/NO SDK symbol/)
    })

    it("rejects 'pty-only-by-design' on a file that DOES know the SDK runtime", () => {
      // The half-migrated shape: a file that learned about SDK sessions in one
      // function while another still reaches for terminalId. Every one of the
      // fifteen defects lived in a file exactly this far along.
      const rel = 'src/lib/server/liveDesks.ts' // a real, SDK-aware swept file
      expect(tierComplaint({ tier: 'pty-only-by-design', why: long }, true, rel)).toMatch(
        /does not know the SDK runtime/,
      )
    })

    it("rejects 'display-only' on server code", () => {
      expect(
        tierComplaint({ tier: 'display-only', why: long }, true, 'src/lib/server/x.ts'),
      ).toMatch(/client components/)
    })

    it('accepts each tier when its basis holds', () => {
      expect(tierComplaint({ tier: 'both-pools', why: long }, true, 'src/lib/server/x.ts')).toBeNull()
      expect(
        tierComplaint({ tier: 'pty-only-by-design', why: long }, false, 'src/lib/server/x.ts'),
      ).toBeNull()
      expect(
        tierComplaint({ tier: 'OPEN', why: long, impact: long }, false, 'src/lib/server/x.ts'),
      ).toBeNull()
      expect(
        tierComplaint({ tier: 'display-only', why: long }, true, 'src/components/canvas/x.tsx'),
      ).toBeNull()
    })
  })
})

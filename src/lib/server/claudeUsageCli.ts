import { spawn as ptySpawn } from 'node-pty'
import { existsSync, watch as fsWatch, type FSWatcher } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import {
  claudeConnection,
  resolvedClaudeBin,
  absoluteClaudeOnPath,
} from './claudeConnection'

// The Claude Code interactive `/usage` view is the canonical source for the
// numbers OPEN GROUND's HUD wants to show — it matches what the user sees on
// claude.ai/usage exactly (session %, weekly %, reset times in their
// timezone). The trick is that /usage is a TUI command, so we drive it via
// node-pty: spawn claude, wait for boot, type /usage, capture the rendered
// output, parse, kill.
//
// Cost is ~9 seconds of wall time per fetch. A successful scrape is cached; the
// activity watcher below is the *primary* freshness trigger (re-scrape ~30s
// after Claude writes), with a 30-min TTL backstop for idle sessions. That lag
// is well below the rate-limit window, so it's meaningless for the user's "am I
// close to the cap?" decision. A FAILED scrape is never cached, so the next
// poll retries instead of pinning a stale "couldn't read" forever.

/** Why a CLI scrape produced no usable %, so the HUD can show an explicit
 *  reason (or fall back to the local-jsonl estimate) instead of a silent "—":
 *  - `ok`            — scraped a session %, numbers are live.
 *  - `signed-out`    — claude is installed but not signed in (no spawn made).
 *  - `not-installed` — no runnable `claude` binary found (no spawn made).
 *  - `scrape-failed` — spawn/boot/timeout error, or the /usage TUI format
 *                      changed so the regex matched nothing. */
export type CliUsageStatus = 'ok' | 'signed-out' | 'not-installed' | 'scrape-failed'

export interface CliUsageSlot {
  pct: number
  /** Verbatim from /usage — e.g. "12:30pm (Asia/Tokyo)" or
   *  "May 25 at 3pm (Asia/Tokyo)". Left as a string so the user sees the
   *  exact text Claude uses; HUD parses it best-effort into a Date. */
  resetsAt: string
}

/** A `Current week (<Model>)` row — a weekly cap that belongs to ONE model
 *  instead of the account-wide pool. `model` is the label VERBATIM from the TUI
 *  ("Sonnet", "Fable 5", "Opus"), never normalised against a hard-coded list:
 *  WHICH model gets its own weekly row depends on the account's plan and moves
 *  with each new flagship. Matching a label to a swarm tier is the launch
 *  layer's job (swarmLaunch.isTopTierExhaustedByUsage). */
export interface CliUsageModelSlot extends CliUsageSlot {
  model: string
}

export interface CliUsage {
  session: CliUsageSlot | null
  weekAll: CliUsageSlot | null
  /** EVERY per-model weekly row the render carried, in TUI order.
   *
   *  LIVE as of claude 2.1.220 (`Current week (Fable)`). It has not always been:
   *  2.1.196 printed the row with an "only" suffix, 2.1.207 printed none at all,
   *  2.1.220 brought it back suffix-less. This is the ONLY reading that can show
   *  a model whose OWN weekly quota is spent while the account-wide slots still
   *  look healthy — the 2026-07-13 wall ("You've reached your Fable 5 limit" at
   *  session 3% / weekAll 63%) is exactly that shape.
   *
   *  ⚠ `[]` is a legitimate value (a plan with no per-model row, an older CLI, an
   *  older cached payload) — do NOT read it as "the parser is fine". It was `[]`
   *  for a whole release cycle BECAUSE the pattern was stale. Check a live render.
   *
   *  Optional so every pre-existing `CliUsage` literal (other layers' tests,
   *  older cached payloads) stays valid; the parser and {@link emptyCliUsage}
   *  always populate it. */
  weekModels?: CliUsageModelSlot[]
  capturedAt: string
  /** Outcome of the most recent fetch attempt — drives the HUD's
   *  reason-or-fallback when `session` is null (see {@link CliUsageStatus}). */
  status: CliUsageStatus
}

// One construction point for the "no live %" results, so the route, the cache,
// and the parser all agree on the shape (null slots + a reason). Exported for
// the /api/usage route's defensive catch.
export const emptyCliUsage = (status: CliUsageStatus): CliUsage => ({
  session: null,
  weekAll: null,
  weekModels: [],
  capturedAt: new Date().toISOString(),
  status,
})

// Upper bound on cache age. The watcher below is the *primary* refresh
// trigger; this TTL just makes sure idle OPEN GROUND sessions eventually re-fetch
// in case the watcher misses something (file move on a network volume, etc).
const CACHE_TTL_MS = 30 * 60 * 1000
// Wait this long after the last write inside ~/.claude/projects before
// invalidating — claude's jsonl files get appended once per assistant turn,
// so a multi-turn run would otherwise re-spawn the scrape repeatedly. Letting
// the burst settle collapses each run into a single refresh.
const INVALIDATE_DEBOUNCE_MS = 30 * 1000

// Cross hot-reload by hanging state off globalThis — Next dev reloads the
// module on every change, but the FSWatcher resource and cache should survive.
interface UsageCliState {
  // Only a *successful* ('ok') scrape is ever stored here; null = nothing
  // cached yet. Failures are returned uncached so the next poll retries.
  cache: CliUsage | null
  cacheAt: number
  inflight: Promise<CliUsage> | null
  watcher: FSWatcher | null
  invalidateTimer: ReturnType<typeof setTimeout> | null
}
const STATE_KEY = '__openground_usage_cli_state'
const g = globalThis as unknown as { [STATE_KEY]?: UsageCliState }
const state: UsageCliState =
  g[STATE_KEY] ??
  (g[STATE_KEY] = {
    cache: null,
    cacheAt: 0,
    inflight: null,
    watcher: null,
    invalidateTimer: null,
  })

// Wipe the cache so the next /api/usage call triggers a fresh CLI scrape.
export const invalidateUsageCache = () => {
  state.cache = null
  state.cacheAt = 0
}

// SYNCHRONOUS cache-only peek — the overseer's M8 sub-cycle (OVERSEER_DESIGN §4)
// reads the last SUCCESSFUL scrape without ever awaiting a ~9s spawn. Returns null
// when nothing is cached OR the cache is past its TTL (a scrape is due but must be
// fired detached, not awaited inside the 3s engine tick). Only successes are ever
// stored (see fetchClaudeUsageCli), so a hit is always live 'ok' numbers.
export const peekCachedUsage = (): CliUsage | null => {
  if (!state.cache) return null
  if (Date.now() - state.cacheAt >= CACHE_TTL_MS) return null
  return state.cache
}

// Fire a usage refresh in the BACKGROUND (never awaited) — the M8 detached-refresh
// the overseer runs when its cache peek misses. Swallows every error; the next peek
// picks up the result. fetchClaudeUsageCli already single-flights (state.inflight)
// and only caches successes, so repeated calls never stack scrapes.
export const refreshUsageCacheDetached = (): void => {
  void fetchClaudeUsageCli().catch(() => {})
}

// Subscribe to writes inside ~/.claude/projects. Claude writes one jsonl
// append per assistant message, so any change here means token usage just
// happened. We debounce 30s after the last write so a long streaming run
// becomes one refresh, not one per turn.
const ensureActivityWatcher = () => {
  if (state.watcher) return
  const dir = join(homedir(), '.claude', 'projects')
  if (!existsSync(dir)) return
  try {
    state.watcher = fsWatch(dir, { recursive: true }, () => {
      if (state.invalidateTimer) clearTimeout(state.invalidateTimer)
      state.invalidateTimer = setTimeout(() => {
        invalidateUsageCache()
        state.invalidateTimer = null
      }, INVALIDATE_DEBOUNCE_MS)
    })
    // Don't keep the Node process alive just for the watcher.
    state.watcher.unref?.()
  } catch {
    // Recursive watch unsupported on this OS — fall back to TTL-only refresh.
  }
}

const stripAnsi = (s: string): string =>
  s
    .replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, '')
    .replace(/\x1B\][^\x07]*\x07/g, '')

// /usage renders a fixed-width TUI block. After ANSI strip, the words inside
// each row are often *concatenated* because the TUI uses padding glyphs /
// non-breaking spaces that don't survive the strip — e.g. "Current session"
// arrives as "Currentsession". We make the header tokens whitespace-tolerant
// (\s* between every pair) and let the percentage and Resets line be picked
// up by relaxed `[\s\S]{0,N}?` spans.

// What follows EVERY section header: the bar row's "NN% used", then the
// "Resets …" line. Shared by the fixed headers (session / week-all) and the
// dynamic per-model ones so all three tolerate the space loss identically.
// Contributes two capture groups (pct, resetsAt) AFTER whatever the header adds.
const SECTION_BODY =
  '[\\s\\S]{0,400}?(\\d{1,3})\\s*%\\s*used[\\s\\S]{0,200}?Resets\\s*([^\\r\\n]+)'

const escapeRe = (s: string): string => s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')

// Normalise "ResetsMay25at3pm(Asia/Tokyo)" → "May 25 at 3pm (Asia/Tokyo)".
// The TUI's space loss hits the reset line too; inject a space at every
// digit↔letter boundary so the result reads like the original /usage line.
const cleanResetsAt = (raw: string): string =>
  raw
    .replace(/([a-z])(\d)/gi, '$1 $2')
    .replace(/(\d)([a-z])/gi, '$1 $2')
    .replace(/\s*\(\s*/, ' (')
    .replace(/\s+/g, ' ')
    .trim()

const findSection = (header: string, clean: string): CliUsageSlot | null => {
  const flexible = header.split(/\s+/).map(escapeRe).join('\\s*')
  const m = clean.match(new RegExp(`${flexible}${SECTION_BODY}`, 'i'))
  if (!m) return null
  const pct = Number(m[1])
  if (!Number.isFinite(pct)) return null
  return { pct, resetsAt: cleanResetsAt(m[2]) }
}

// Every per-model weekly row. THREE builds, three behaviours (all observed):
//   • 2.1.196 — `Current week (Sonnet only)`
//   • 2.1.207 — no row at all; a "Per-model breakdown unavailable" placeholder
//   • 2.1.220 — `Current week (Fable)`  ← the "only" suffix is GONE
// The label now comes from the API's `weekly_scoped` field and there is no
// `only)` format string left in the 2.1.220 binary (verified 2026-07-30 against
// the binary's strings AND a live `/usage` capture).
//
// BOTH suffix shapes are accepted. OG drives whatever `claude` is on the user's
// machine, so reading only the newest shape would just move the blindness to
// older CLIs.
//
// ⚠ WHY THIS WAS BROKEN, AND WHY IT MATTERED. The pattern used to REQUIRE
// "only", so on 2.1.220 it read [] from a render that HAD the row — and
// swarmLaunch.isTopTierExhaustedByUsage's per-model arm was dead: a flagship
// whose OWN weekly quota is spent while the account-wide slots look healthy was
// invisible, which is the exact wall observed 2026-07-13 ("You've reached your
// Fable 5 limit" at session 3% / weekAll 63%). The comment here even said "today's
// CLI prints none" — true when written, and it kept being believed after the row
// returned. Re-verify against a LIVE render before trusting any claim in this
// block; a fixture is not evidence (that mistake cost a whole worker once).
//
// The model name is CAPTURED, never matched against a fixed list — which model
// owns a weekly cap is a property of the account's plan and moves with each new
// flagship. An account could render more than one, so all rows are scanned rather
// than the first: a dry flagship must stay visible even when a cheaper tier's row
// comes first.
//
// ⚠ THE "only" SUFFIX USED TO BE THE GUARD against the account-wide
// `Current week (all models)` row — that parenthetical never ended in "only", so
// the pattern excluded it for free. With the suffix now OPTIONAL that is gone,
// and the label has to be excluded EXPLICITLY (below). Without the exclusion the
// account-wide row parses as a model literally named "all models" and
// isTopTierExhaustedByUsage starts steering on the account-wide number.
const ACCOUNT_WIDE_LABEL = 'allmodels'

// Space-insensitive compare: the TUI's ANSI-strip welds words, so the very row we
// must exclude arrives as "(allmodels)" as often as "(all models)".
const isAccountWideLabel = (model: string): boolean =>
  model.replace(/\s+/g, '').toLowerCase() === ACCOUNT_WIDE_LABEL

const findModelWeeks = (clean: string): CliUsageModelSlot[] => {
  const re = new RegExp(
    `Current\\s*week\\s*\\(\\s*([^)]{1,40}?)\\s*(?:only\\s*)?\\)${SECTION_BODY}`,
    'gi',
  )
  const rows: CliUsageModelSlot[] = []
  // exec-loop rather than matchAll: tsconfig sets no `target` (⇒ ES5), where
  // iterating an iterator is a TS2802. The pattern can never match empty, so
  // lastIndex always advances.
  let m: RegExpExecArray | null
  while ((m = re.exec(clean)) !== null) {
    const model = m[1].replace(/\s+/g, ' ').trim()
    const pct = Number(m[2])
    if (!model || !Number.isFinite(pct)) continue
    if (isAccountWideLabel(model)) continue
    rows.push({ model, pct, resetsAt: cleanResetsAt(m[3]) })
  }
  return rows
}

// Exported for unit testing against captured `/usage` fixtures — the TUI scrape
// is the gauge's authoritative %, and its space-losing regex is fragile, so we
// pin it against real output. Not called outside this module otherwise.
export const parseUsageOutput = (raw: string): CliUsage => {
  const clean = stripAnsi(raw)
  const session = findSection('Current session', clean)
  return {
    session,
    weekAll: findSection('Current week (all models)', clean),
    weekModels: findModelWeeks(clean),
    capturedAt: new Date().toISOString(),
    // A usable session % is the gauge's headline; its absence means the TUI
    // format changed (or the render was truncated) — surface that as a failure
    // so the HUD shows a reason, not a silent "—".
    status: session ? 'ok' : 'scrape-failed',
  }
}

// Resolve the `claude` binary the same robust way the connection probe does:
// the EXACT absolute path that probe just validated (resolvedClaudeBin, set by
// the claudeConnection() call right before this in fetchClaudeUsageCli), then a
// full PATH walk + the per-OS well-known install targets (absoluteClaudeOnPath).
// This replaces a fixed 3-path list that missed nvm/volta/Windows installs.
const findClaudeBinary = (): string | null =>
  resolvedClaudeBin() ?? absoluteClaudeOnPath()

const pickCwd = async (): Promise<string> => {
  // Trusted-folder dialog fires in unfamiliar dirs and locks the TUI until
  // it's answered. The OPEN GROUND server's own working directory (the
  // OPEN GROUND repo) is the safest pick: the user is actively running it
  // from there, so it's unambiguously on claude's trust list. We always have it.
  return process.cwd()
}

const drive = (claudeBin: string, cwd: string): Promise<CliUsage> =>
  new Promise((resolveFn) => {
    let buf = ''
    let resolved = false
    let proc: ReturnType<typeof ptySpawn> | null = null

    const finish = (val: CliUsage) => {
      if (resolved) return
      resolved = true
      try {
        proc?.kill()
      } catch {}
      resolveFn(val)
    }
    // Any non-success exit path (spawn throw, early exit, timeout) resolves to
    // an explicit scrape-failed reason — never a bare null — so the HUD can say
    // "couldn't read /usage" and fall back to the local estimate.
    const fail = () => finish(emptyCliUsage('scrape-failed'))

    try {
      proc = ptySpawn(claudeBin, [], {
        name: 'xterm-256color',
        cols: 120,
        rows: 50,
        cwd,
        env: process.env as { [k: string]: string },
      })
    } catch {
      fail()
      return
    }

    proc.onData((d) => {
      buf += d
      // The render is "done enough" once all three sections' "NN% used" text
      // has appeared. Match against the ANSI-stripped buffer because ANSI
      // codes routinely split the "% used" pair.
      const clean = stripAnsi(buf)
      const pctCount = (clean.match(/\d+\s*%\s*used/g) || []).length
      if (pctCount >= 3) {
        // One short beat for the trailing breakdown text, then parse. The parse
        // result already carries status 'ok' / 'scrape-failed' (the latter if
        // the TUI format shifted and the session row didn't match).
        setTimeout(() => finish(parseUsageOutput(buf)), 800)
      }
    })

    proc.onExit(() => fail())

    // Boot grace, then a stray Enter to dismiss any trust dialog (the default
    // is "Yes, I trust this folder", so Enter is the no-op-or-confirm key).
    setTimeout(() => {
      try {
        proc?.write('\r')
      } catch {}
    }, 2000)

    // Send the slash command once the welcome screen is up.
    setTimeout(() => {
      try {
        proc?.write('/usage\r')
      } catch {}
    }, 4500)

    // Hard timeout — bail and let the caller fall back to local-jsonl numbers.
    setTimeout(fail, 15000)
  })

export const fetchClaudeUsageCli = async (): Promise<CliUsage> => {
  // Lazy-start the activity watcher on first fetch — keeps module init free
  // of side effects.
  ensureActivityWatcher()
  const now = Date.now()
  // A cache hit is always live 'ok' numbers — only successes are stored.
  if (state.cache && now - state.cacheAt < CACHE_TTL_MS) return state.cache
  if (state.inflight) return state.inflight

  state.inflight = (async (): Promise<CliUsage> => {
    // Never spawn a signed-out interactive `claude`: with no args it drops to
    // claude's own sign-in screen and opens an OAuth browser — the exact loop
    // the run-route gate (claudeRunPreflight) was added to stop, and this 60s
    // HUD poll would re-trigger it. Usage is optional, so signed-out / not
    // installed report an explicit reason and the HUD falls back to the
    // local-jsonl estimate. (claudeConnection caches ~10s; loggedIn implies
    // installed.)
    const conn = await claudeConnection()
    if (!conn.loggedIn) {
      return emptyCliUsage(conn.installed ? 'signed-out' : 'not-installed')
    }
    const claudeBin = findClaudeBinary()
    if (!claudeBin) return emptyCliUsage('not-installed')
    const cwd = await pickCwd()
    const result = await drive(claudeBin, cwd)
    // Cache successes only — a failed scrape stays uncached so the next poll
    // retries instead of pinning the failure for the whole TTL.
    if (result.status === 'ok') {
      state.cache = result
      state.cacheAt = Date.now()
    }
    return result
  })()
  try {
    return await state.inflight
  } finally {
    state.inflight = null
  }
}

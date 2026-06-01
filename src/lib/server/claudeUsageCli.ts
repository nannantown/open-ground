import { spawn as ptySpawn } from 'node-pty'
import { existsSync, watch as fsWatch, type FSWatcher } from 'fs'
import { homedir } from 'os'
import { join, resolve as pathResolve } from 'path'

// The Claude Code interactive `/usage` view is the canonical source for the
// numbers OPEN GROUND's HUD wants to show — it matches what the user sees on
// claude.ai/usage exactly (session %, weekly %, reset times in their
// timezone). The trick is that /usage is a TUI command, so we drive it via
// node-pty: spawn claude, wait for boot, type /usage, capture the rendered
// output, parse, kill.
//
// Cost is ~9 seconds of wall time per fetch, so the result is cached for 5
// minutes — well below the rate-limit window so the freshness lag is
// meaningless for the user's "am I close to the cap?" decision.

export interface CliUsageSlot {
  pct: number
  /** Verbatim from /usage — e.g. "12:30pm (Asia/Tokyo)" or
   *  "May 25 at 3pm (Asia/Tokyo)". Left as a string so the user sees the
   *  exact text Claude uses; HUD parses it best-effort into a Date. */
  resetsAt: string
}

export interface CliUsage {
  session: CliUsageSlot | null
  weekAll: CliUsageSlot | null
  weekSonnet: CliUsageSlot | null
  capturedAt: string
}

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
  cache: CliUsage | null
  cacheAt: number
  inflight: Promise<CliUsage | null> | null
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
const findSection = (header: string, clean: string): CliUsageSlot | null => {
  const flexible = header
    .split(/\s+/)
    .map(t => t.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'))
    .join('\\s*')
  const re = new RegExp(
    `${flexible}[\\s\\S]{0,400}?(\\d{1,3})\\s*%\\s*used[\\s\\S]{0,200}?Resets\\s*([^\\r\\n]+)`,
    'i',
  )
  const m = clean.match(re)
  if (!m) return null
  const pct = Number(m[1])
  if (!Number.isFinite(pct)) return null
  // Normalise "ResetsMay25at3pm(Asia/Tokyo)" → "May 25 at 3pm (Asia/Tokyo)".
  // The TUI's space loss hits us here too; inject spaces around the
  // recognizable shapes so the result reads like the original /usage line.
  const resetsAt = m[2]
    .replace(/(\d)(am|pm)/i, '$1$2')
    .replace(/([a-z])(\d)/gi, '$1 $2')
    .replace(/(\d)([a-z])/gi, '$1 $2')
    .replace(/\s*\(\s*/, ' (')
    .replace(/\s+/g, ' ')
    .trim()
  return { pct, resetsAt }
}

const parseUsageOutput = (raw: string): CliUsage => {
  const clean = stripAnsi(raw)
  return {
    session: findSection('Current session', clean),
    weekAll: findSection('Current week (all models)', clean),
    weekSonnet: findSection('Current week (Sonnet only)', clean),
    capturedAt: new Date().toISOString(),
  }
}

const findClaudeBinary = (): string | null => {
  // The user's symlink (`~/.local/bin/claude`) and the homebrew default cover
  // the install paths we've seen in the wild.
  const candidates = [
    pathResolve(homedir(), '.local/bin/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}

const pickCwd = async (): Promise<string> => {
  // Trusted-folder dialog fires in unfamiliar dirs and locks the TUI until
  // it's answered. The OPEN GROUND server's own working directory (the
  // OPEN GROUND repo) is the safest pick: the user is actively running it
  // from there, so it's unambiguously on claude's trust list. We always have it.
  return process.cwd()
}

const drive = (claudeBin: string, cwd: string): Promise<CliUsage | null> =>
  new Promise((resolveFn) => {
    let buf = ''
    let resolved = false
    let proc: ReturnType<typeof ptySpawn> | null = null

    const finish = (val: CliUsage | null) => {
      if (resolved) return
      resolved = true
      try {
        proc?.kill()
      } catch {}
      resolveFn(val)
    }

    try {
      proc = ptySpawn(claudeBin, [], {
        name: 'xterm-256color',
        cols: 120,
        rows: 50,
        cwd,
        env: process.env as { [k: string]: string },
      })
    } catch {
      finish(null)
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
        // One short beat for the trailing breakdown text, then parse.
        setTimeout(() => {
          const parsed = parseUsageOutput(buf)
          if (parsed.session) finish(parsed)
          else finish(null)
        }, 800)
      }
    })

    proc.onExit(() => finish(null))

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
    setTimeout(() => finish(null), 15000)
  })

export const fetchClaudeUsageCli = async (): Promise<CliUsage | null> => {
  // Lazy-start the activity watcher on first fetch — keeps module init free
  // of side effects.
  ensureActivityWatcher()
  const now = Date.now()
  if (state.cache && now - state.cacheAt < CACHE_TTL_MS) return state.cache
  if (state.inflight) return state.inflight

  state.inflight = (async () => {
    const claudeBin = findClaudeBinary()
    if (!claudeBin) return null
    const cwd = await pickCwd()
    const result = await drive(claudeBin, cwd)
    if (result) {
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

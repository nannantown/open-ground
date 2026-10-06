import type { Stats } from 'fs'
import { open, readdir, stat } from 'fs/promises'
import { homedir } from 'os'
import { basename, join, sep } from 'path'
import type { ClaudeUsage, UsageBreakdown, UsageBreakdownRow, UsageSourceKind } from '../types'

/** Claude Code's max context window, in tokens. The auto-compact denominator for
 *  the per-session gauge: `% used = contextTokens ÷ this`. Pinned at 200k by the
 *  card-1 spike, where the JSONL usage sum (38,848) matched the CLI's own
 *  `/context` readout (`38.8k/200k`) exactly. 【一次資料】 code.claude.com/docs
 *  context-window.md ("200,000 tokens"), via docs/CONTEXT_MANAGEMENT_PLAN.md §A1. */
export const CONTEXT_WINDOW_TOKENS = 200_000

const WINDOW_HOURS = 5
const WINDOW_MS = WINDOW_HOURS * 60 * 60 * 1000
// Skip files whose mtime is older than (now - WINDOW - slack). 1h slack covers
// long-running sessions whose last write is fresh but oldest line is old.
const FILE_MTIME_SLACK_MS = 60 * 60 * 1000

const claudeProjectsDir = () => join(homedir(), '.claude', 'projects')

/** The ONE de-duplication rule, shared by every consumer of this walk.
 *
 *  Claude Code writes the same assistant turn into MULTIPLE jsonl files when
 *  sessions resume, branch, or spawn subagents — counting every line inflates
 *  totals wildly (the symptom: the gauge pinned past 100% while real usage was
 *  ~10%). Keyed by message id, with requestId as the tiebreaker for entries that
 *  carry one (a retried request is a genuinely separate charge).
 *
 *  Written as a helper because there are now TWO walkers over the same files
 *  ({@link collectClaudeUsage} and {@link collectUsageBreakdown}) and a second
 *  copy of this rule is how the two would silently drift into disagreeing about
 *  the same week. Returns false when the line has already been counted. */
const countOnce = (seen: Set<string>, parsed: { messageId?: string; requestId?: string }): boolean => {
  if (!parsed.messageId) return true // no id to dedupe on — count it
  const key = parsed.requestId ? `${parsed.messageId}|${parsed.requestId}` : parsed.messageId
  if (seen.has(key)) return false
  seen.add(key)
  return true
}

interface UsageLine {
  timestamp: string
  model?: string
  messageId?: string
  requestId?: string
  usage: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

const walkJsonl = async (root: string): Promise<string[]> => {
  const out: string[] = []
  const walk = async (dir: string) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) await walk(p)
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p)
    }
  }
  await walk(root)
  return out
}

// How long one recursive listing of ~/.claude/projects may be reused.
//
// WHY THIS EXISTS: the per-session context gauge (card 5) reads the beacon every
// 5s, and the beacon resolves EVERY live claude pane — so an unmemoized walk ran
// once per pane per tick. On a heavy ~/.claude with four panes open that is four
// full recursive traversals every five seconds, forever, for a number that moves
// once a turn (flagged at card-2 integration, 2026-07-23).
//
// Staleness is harmless in BOTH directions: the memo holds a list of PATHS, and
// the file each path points at is still read fresh every call, so a live session's
// token count is never stale. Only the LISTING ages — i.e. a session file created
// in the last few seconds may be missed, which reads as "no number yet" for one
// tick and resolves on the next. That is the same null the gauge already shows
// before a session's first assistant turn.
const WALK_MEMO_MS = 4_000

let walkMemo: { root: string; at: number; files: Promise<string[]> } | null = null

/** {@link walkJsonl} with a few seconds of memoisation, keyed by root so a
 *  different directory (every test uses its own tmpdir) always recomputes. A
 *  rejected walk is evicted immediately rather than cached as a poison pill. */
const walkJsonlMemo = (root: string): Promise<string[]> => {
  const now = Date.now()
  if (walkMemo && walkMemo.root === root && now - walkMemo.at < WALK_MEMO_MS) return walkMemo.files
  const files = walkJsonl(root)
  const entry = { root, at: now, files }
  walkMemo = entry
  files.catch(() => {
    if (walkMemo === entry) walkMemo = null
  })
  return files
}

/** Drop the listing memo — for tests that mutate one directory across ticks. */
export const resetJsonlWalkMemo = (): void => {
  walkMemo = null
}

const parseLine = (raw: string): UsageLine | null => {
  if (!raw || raw[0] !== '{') return null
  // Cheap pre-filter: only assistant messages carry a usage block.
  if (raw.indexOf('"usage"') < 0) return null
  try {
    const obj = JSON.parse(raw)
    if (obj?.type !== 'assistant') return null
    const usage = obj?.message?.usage
    const timestamp = obj?.timestamp
    if (!usage || typeof timestamp !== 'string') return null
    return {
      timestamp,
      model: obj?.message?.model,
      messageId: obj?.message?.id,
      requestId: obj?.requestId,
      usage,
    }
  } catch {
    return null
  }
}

// ─── Incremental transcript reading (2026-10-06) ─────────────────────────────
// WHY: every reader here used to `readFile` WHOLE transcripts on every call. The
// beacon (GET /api/terminal/active, polled every 5 s by up to three panels)
// resolves every live claude pane, and the HUD polls /api/usage every 60 s — on
// the owner's machine that was 14 desk transcripts (≈160 MB) re-read and
// re-decoded every few seconds, measured as the server's largest idle CPU cost
// (CPU profile of the packaged app after 12 h: readFileHandle + string_decoder +
// sessionContextTokens + parseLine + collectClaudeUsage ≈ the whole JS share of
// a process sitting at 50–90% CPU with no work running).
//
// Transcripts are append-only JSONL, so each file is read ONCE and afterwards
// only from where the last read stopped. An unchanged file costs one stat. The
// bytes just before the resume point are kept and re-checked on every resume,
// so a file that was rewritten instead of appended to is detected and re-read
// from the start rather than parsed mid-line.

/** One assistant turn's usage, as read from a transcript line. */
interface UsageEntry {
  ts: number // Date.parse(timestamp) — NaN when unparseable (callers skip it)
  model?: string
  messageId?: string
  requestId?: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** What one line contributes: a usage entry and/or a new context fill
 *  (undefined = the line says nothing about the fill). */
interface LineRead {
  entry: UsageEntry | null
  fill: number | null | undefined
}

interface FileScan {
  size: number
  mtimeMs: number
  /** Bytes consumed: the end of the last newline-terminated line. */
  offset: number
  /** The bytes just before `offset`, re-read on resume to prove an append. */
  guard: Buffer
  /** Every usage line in [0, offset), in file order. */
  entries: UsageEntry[]
  /** The context fill as of `offset` (see {@link sessionContextTokens}). */
  fill: number | null | undefined
  /** The unterminated last line (claude mid-write, or a fixture without a final
   *  newline) — counted, but NOT consumed: it is re-read on the next change. */
  tail: LineRead | null
}

const GUARD_BYTES = 64
const scans = new Map<string, FileScan>()
const scansInFlight = new Map<string, Promise<FileScan | null>>()

const readLineUsage = (line: string): LineRead | null => {
  const boundary = compactBoundaryPostTokens(line)
  if (boundary !== undefined) return { entry: null, fill: boundary }
  const parsed = parseLine(line)
  if (!parsed) return null
  const u = parsed.usage
  const entry: UsageEntry = {
    ts: Date.parse(parsed.timestamp),
    model: parsed.model,
    messageId: parsed.messageId,
    requestId: parsed.requestId,
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
  }
  return { entry, fill: entry.input + entry.cacheRead + entry.cacheWrite }
}

const emptyScan = (): FileScan => ({
  size: 0,
  mtimeMs: 0,
  offset: 0,
  guard: Buffer.alloc(0),
  entries: [],
  fill: undefined,
  tail: null,
})

const advanceScan = async (file: string, known?: Stats): Promise<FileScan | null> => {
  let st: Stats
  try {
    st = known ?? (await stat(file))
  } catch {
    scans.delete(file)
    return null
  }
  let s = scans.get(file)
  if (s && s.size === st.size && s.mtimeMs === st.mtimeMs) return s
  // Shrunk, or the same size with a new mtime: rewritten, not appended.
  if (!s || st.size < s.offset || st.size === s.size) s = emptyScan()

  let fh
  try {
    fh = await open(file, 'r')
  } catch {
    scans.delete(file)
    return null
  }
  try {
    for (;;) {
      const start = s.offset - s.guard.length
      const buf = Buffer.allocUnsafe(Math.max(0, st.size - start))
      const { bytesRead } = await fh.read(buf, 0, buf.length, start)
      const got = buf.subarray(0, bytesRead)
      if (s.offset > 0 && !got.subarray(0, s.guard.length).equals(s.guard)) {
        s = emptyScan() // the bytes before the resume point changed: rewritten
        continue
      }
      const fresh = got.subarray(s.guard.length)
      const lastNl = fresh.lastIndexOf(0x0a)
      const done = lastNl < 0 ? 0 : lastNl + 1
      if (done > 0) {
        for (const line of fresh.toString('utf8', 0, done).split('\n')) {
          const r = readLineUsage(line)
          if (!r) continue
          if (r.entry) s.entries.push(r.entry)
          if (r.fill !== undefined) s.fill = r.fill
        }
        s.offset += done
        const consumed = got.subarray(0, s.guard.length + done)
        s.guard = Buffer.from(consumed.subarray(Math.max(0, consumed.length - GUARD_BYTES)))
      }
      s.tail = done < fresh.length ? readLineUsage(fresh.toString('utf8', done)) : null
      break
    }
  } catch {
    scans.delete(file)
    return null
  } finally {
    await fh.close().catch(() => {})
  }
  s.size = st.size
  s.mtimeMs = st.mtimeMs
  scans.set(file, s)
  return s
}

/** The file's scan, brought up to date. One read per file at a time: two
 *  pollers landing together share it rather than reading the file twice (the
 *  guard check would still catch a concurrent resume and re-read from 0). */
const scanFile = (file: string, known?: Stats): Promise<FileScan | null> => {
  const running = scansInFlight.get(file)
  if (running) return running
  const p = advanceScan(file, known).finally(() => scansInFlight.delete(file))
  scansInFlight.set(file, p)
  return p
}

const forEachEntry = (s: FileScan, fn: (e: UsageEntry) => void): void => {
  for (const e of s.entries) fn(e)
  if (s.tail?.entry) fn(s.tail.entry)
}

const fillOf = (s: FileScan): number | null =>
  (s.tail && s.tail.fill !== undefined ? s.tail.fill : s.fill) ?? null

/** `${root}\0${sessionId}` → transcript path, so a live pane's file is found
 *  once rather than by walking ~/.claude/projects on every beacon poll. */
const sessionPaths = new Map<string, string>()

/** The widest window /api/usage/breakdown serves (its one caller, UsageHud,
 *  asks for 7). It also bounds what the scans keep in memory: on the owner's
 *  machine a 30-day keep held ~30–35 MB of entries on the heap for windows
 *  nobody reads. */
export const USAGE_BREAKDOWN_MAX_DAYS = 7
const SCAN_KEEP_MS = USAGE_BREAKDOWN_MAX_DAYS * 24 * 60 * 60 * 1000 + FILE_MTIME_SLACK_MS

/** Drop the scans under `root` that this walk no longer lists (deleted by
 *  Claude Code's cleanup) or that aged past every reader's window, and the
 *  entries too old for any reader inside a long-lived transcript — the app
 *  runs for weeks, and each scan holds one entry per assistant turn. */
const pruneScans = (root: string, listed: readonly string[], now: number): void => {
  const keep = new Set(listed)
  const cut = now - SCAN_KEEP_MS
  scans.forEach((s, file) => {
    if (!file.startsWith(root + sep)) return
    if (!keep.has(file) || s.mtimeMs < cut) {
      scans.delete(file)
      return
    }
    // Lines are appended in time order, so a stale head is the cheap check.
    if (s.entries.length > 0 && s.entries[0].ts < cut) s.entries = s.entries.filter((e) => !(e.ts < cut))
  })
}

/** Forget every scan and resolved path — for tests that reuse paths. */
export const resetTranscriptScans = (): void => {
  scans.clear()
  sessionPaths.clear()
}

// `projectsDir` defaults to the real ~/.claude/projects; tests pass a fixture
// dir so the log-aggregation source can be exercised without touching the real
// home (see claudeUsage.test.ts).
export const collectClaudeUsage = async (
  projectsDir: string = claudeProjectsDir(),
): Promise<ClaudeUsage> => {
  const root = projectsDir
  const cutoffMs = Date.now() - WINDOW_MS
  const fileCutoffMs = cutoffMs - FILE_MTIME_SLACK_MS

  let files: string[] = []
  try {
    files = await walkJsonl(root)
    pruneScans(root, files, Date.now())
  } catch {
    // ~/.claude/projects missing — empty usage.
  }

  let input = 0
  let output = 0
  let cacheRead = 0
  let cacheWrite = 0
  let messageCount = 0
  let oldestMs: number | null = null
  let newestMs: number | null = null
  let currentModel: string | null = null
  const byModel: Record<string, number> = {}
  // Claude Code writes the same assistant turn into multiple jsonl files when
  // sessions resume, branch, or spawn subagents — counting every line gives
  // wildly inflated totals (the symptom: gauge pinned past 100% while the
  // real per-window usage is ~10%). Dedupe by message id (with requestId as a
  // tiebreaker for entries that carry one) to match what ccusage / Claude
  // Code Usage Monitor report.
  const seen = new Set<string>()

  for (const file of files) {
    let st
    try {
      st = await stat(file)
    } catch {
      continue
    }
    if (st.mtimeMs < fileCutoffMs) continue

    const scan = await scanFile(file, st)
    if (!scan) continue
    forEachEntry(scan, (e) => {
      const ts = e.ts
      if (!Number.isFinite(ts) || ts < cutoffMs) return

      if (!countOnce(seen, e)) return

      input += e.input
      output += e.output
      cacheRead += e.cacheRead
      cacheWrite += e.cacheWrite
      messageCount += 1
      if (oldestMs === null || ts < oldestMs) oldestMs = ts
      if (newestMs === null || ts > newestMs) {
        newestMs = ts
        if (e.model) currentModel = e.model
      }

      if (e.model) {
        // Bill model usage by the same metric as the headline total
        // (input + output + cache writes — cache reads are heavily discounted).
        byModel[e.model] = (byModel[e.model] ?? 0) + e.input + e.output + e.cacheWrite
      }
    })
  }

  const total = input + output + cacheWrite

  return {
    windowHours: WINDOW_HOURS,
    windowStart: oldestMs !== null ? new Date(oldestMs).toISOString() : null,
    nextResetAt:
      oldestMs !== null ? new Date(oldestMs + WINDOW_MS).toISOString() : null,
    tokens: { input, output, cacheRead, cacheWrite, total },
    messageCount,
    byModel,
    currentModel,
  }
}

/** undefined ⇒ not a compaction boundary line; otherwise its postTokens (null
 *  when the boundary does not say). See {@link sessionContextTokens}. */
const compactBoundaryPostTokens = (raw: string): number | null | undefined => {
  if (!raw || raw[0] !== '{' || raw.indexOf('"compact_boundary"') < 0) return undefined
  try {
    const obj = JSON.parse(raw)
    if (obj?.type !== 'system' || obj?.subtype !== 'compact_boundary') return undefined
    const post = obj?.compactMetadata?.postTokens
    return typeof post === 'number' && Number.isFinite(post) ? post : null
  } catch {
    return undefined
  }
}

/** The context-window FILL for one claude session, in tokens: the sum its LAST
 *  assistant turn reported carrying (`input + cache_read + cache_creation`) — the
 *  same number the CLI's own `/context` prints (verified equal to `38.8k/200k` in
 *  the card-1 spike, 2026-07-23). This is the ALWAYS-ON source for the per-session
 *  context gauge; the on-screen footnote only appears near the limit
 *  (claudeScreen.extractContextLeftPct is that near-limit alarm).
 *
 *  Distinct from {@link collectClaudeUsage}, which sums a whole 5-hour QUOTA
 *  window across every session — this is ONE session's current fill, a different
 *  measure (spike §5: "既存 UsageHud はクォータ枠であってセッション長ではない").
 *
 *  claude keys each session's transcript by its uuid (`<sessionId>.jsonl`), so the
 *  file is found by basename without knowing its cwd-encoded parent dir. Reads the
 *  NEWEST assistant line's usage (each turn's usage reflects the whole context it
 *  carried in, so the last line is the current fill). Returns null when no such
 *  file / assistant line exists yet. `projectsDir` is injectable for tests.
 *  Requires transcript ON — the OG server (not a child of claude) runs with it on
 *  (spike §3-B3). */
export const sessionContextTokens = async (
  sessionId: string,
  projectsDir: string = claudeProjectsDir(),
): Promise<number | null> => {
  if (!sessionId) return null
  // The fill is the LAST fill-bearing line (readLineUsage): a reply's usage sum,
  // or a COMPACTION newer than the last reply — the context the session now
  // carries is what the compaction left, not what the last reply carried, and
  // no reply may follow for hours on a quiet desk. Without that the fill read
  // stays at the PRE-compaction size until the next turn, so the gauge shows a
  // full desk that is not, and the desk context cap (supplyContextCap.ts) would
  // re-send `compact` into a desk that already did it. Measured 2026-09-18:
  // claude writes `{type:'system', subtype:'compact_boundary',
  // compactMetadata:{preTokens, postTokens}}` for both auto and manual
  // compaction (PTY and SDK alike). An unreadable postTokens ⇒ null
  // ("unknown"), never the stale pre-compaction number.
  const key = `${projectsDir}\0${sessionId}`
  const known = sessionPaths.get(key)
  if (known) {
    const scan = await scanFile(known)
    if (scan) return fillOf(scan)
    sessionPaths.delete(key) // moved or deleted — look it up again below
  }
  let files: string[]
  try {
    // Memoised listing (see WALK_MEMO_MS): only a session whose file has not
    // been found yet walks, and several such panes share one listing.
    files = await walkJsonlMemo(projectsDir)
  } catch {
    return null
  }
  const target = files.find((f) => basename(f) === `${sessionId}.jsonl`)
  if (!target) return null
  const scan = await scanFile(target)
  if (!scan) return null
  sessionPaths.set(key, target)
  return fillOf(scan)
}

// ─── Who is burning the weekly budget (2026-09-02) ───────────────────────────
// The HUD answers "how much is left"; it could not answer "why is it draining",
// which is the question the owner actually acted on (measured: half a weekly
// Fable budget gone with no heavy card in flight — the always-on desks). This
// walks the SAME jsonl files over a longer window and groups the billed tokens
// by model × source.
//
// SOURCES are what the file path can PROVE, and no more:
//   • 'swarm-worker' — the session ran in a swarm worktree (isSwarmWorktreeSessionDir).
//   • 'project'      — its cwd is one of the owner's registered projects. That is
//                      the commander/supply desks AND the owner's own `claude`
//                      in that repo: both sit in the repo root, and nothing in
//                      the transcript separates them. The UI says so rather than
//                      guessing.
//   • 'other'        — every other cwd (other repos, one-off sessions).

// The wire types live in src/lib/types.ts (the shared client/server contract).

const isSwarmWorktreeDirName = (dirName: string): boolean =>
  dirName.includes('-openground-projects-') && dirName.includes('-worktrees-')

/** Group the last `days` of billed tokens by model × source. READ-ONLY; a
 *  missing/unreadable file is skipped, never thrown. `projectDirs` are the
 *  ENCODED ~/.claude/projects entry names of the owner's registered projects
 *  (encodeClaudeProjectKey) — absent ⇒ nothing is attributable to 'project'. */
export const collectUsageBreakdown = async (opts: {
  projectsDir?: string
  days?: number
  now?: number
  projectDirs?: readonly string[]
  /** session id → desk role, from the desk ledger (swarmDeskLedger.ts). A
   *  transcript whose file name (its session id) is in here is that desk's,
   *  wherever it lives — desks run in the project's own dir, so the directory
   *  alone cannot tell a commander turn from the owner's. Absent ⇒ no desk
   *  attribution (every project-dir session stays 'project'). */
  deskSessions?: ReadonlyMap<string, 'manager' | 'supply'>
} = {}): Promise<UsageBreakdown> => {
  const root = opts.projectsDir ?? claudeProjectsDir()
  const days = opts.days && opts.days > 0 ? Math.min(opts.days, USAGE_BREAKDOWN_MAX_DAYS) : USAGE_BREAKDOWN_MAX_DAYS
  const now = opts.now ?? Date.now()
  const cutoffMs = now - days * 24 * 60 * 60 * 1000
  const fileCutoffMs = cutoffMs - FILE_MTIME_SLACK_MS
  const projectDirs = new Set(opts.projectDirs ?? [])

  let files: string[] = []
  try {
    files = await walkJsonl(root)
    pruneScans(root, files, now)
  } catch {
    // no ~/.claude/projects — nothing to attribute
  }

  const seen = new Set<string>()
  const sums = new Map<string, number>() // `${model}\u0000${source}` → tokens
  for (const file of files) {
    let st
    try {
      st = await stat(file)
    } catch {
      continue
    }
    if (st.mtimeMs < fileCutoffMs) continue
    const scan = await scanFile(file, st)
    if (!scan) continue
    const dirName = basename(join(file, '..'))
    // Desk first, by session id: a commander/supply transcript sits in the
    // project's dir, exactly where the owner's own sessions sit. Only the
    // ledger can tell them apart; a session it does not name is 'project'
    // (the owner's, or a desk from before the ledger — the UI label says so).
    const sessionId = basename(file, '.jsonl')
    const desk = opts.deskSessions?.get(sessionId)
    const source: UsageSourceKind = isSwarmWorktreeDirName(dirName)
      ? 'swarm-worker'
      : desk
        ? desk
        : projectDirs.has(dirName)
          ? 'project'
          : 'other'
    forEachEntry(scan, (e) => {
      if (!Number.isFinite(e.ts) || e.ts < cutoffMs) return
      if (!countOnce(seen, e)) return
      if (!e.model) return
      const billed = e.input + e.output + e.cacheWrite
      if (billed <= 0) return
      const key = `${e.model}\u0000${source}`
      sums.set(key, (sums.get(key) ?? 0) + billed)
    })
  }

  const rows: UsageBreakdownRow[] = Array.from(sums.entries())
    .map(([key, tokens]) => {
      const [model, source] = key.split('\u0000')
      return { model, source: source as UsageSourceKind, tokens }
    })
    .sort((a, b) => b.tokens - a.tokens)
  return {
    days,
    rows,
    total: rows.reduce((n, r) => n + r.tokens, 0),
    scannedAt: new Date(now).toISOString(),
  }
}

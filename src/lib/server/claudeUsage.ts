import { readdir, readFile, stat } from 'fs/promises'
import { homedir } from 'os'
import { basename, join } from 'path'
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
const countOnce = (seen: Set<string>, parsed: UsageLine): boolean => {
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

    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch {
      continue
    }

    // Walk lines once; jsonl writes append-only so reading whole file is fine
    // for the typical (small-to-mid) Claude session log.
    const lines = raw.split('\n')
    for (const line of lines) {
      const parsed = parseLine(line)
      if (!parsed) continue
      const ts = Date.parse(parsed.timestamp)
      if (!Number.isFinite(ts) || ts < cutoffMs) continue

      if (!countOnce(seen, parsed)) continue

      const u = parsed.usage
      const ti = u.input_tokens ?? 0
      const to = u.output_tokens ?? 0
      const tcr = u.cache_read_input_tokens ?? 0
      const tcw = u.cache_creation_input_tokens ?? 0
      input += ti
      output += to
      cacheRead += tcr
      cacheWrite += tcw
      messageCount += 1
      if (oldestMs === null || ts < oldestMs) oldestMs = ts
      if (newestMs === null || ts > newestMs) {
        newestMs = ts
        if (parsed.model) currentModel = parsed.model
      }

      if (parsed.model) {
        // Bill model usage by the same metric as the headline total
        // (input + output + cache writes — cache reads are heavily discounted).
        byModel[parsed.model] = (byModel[parsed.model] ?? 0) + ti + to + tcw
      }
    }
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
  let files: string[]
  try {
    // Memoised listing (see WALK_MEMO_MS): the beacon calls this once per live
    // pane every few seconds, and they all want the same directory tree.
    files = await walkJsonlMemo(projectsDir)
  } catch {
    return null
  }
  const target = files.find((f) => basename(f) === `${sessionId}.jsonl`)
  if (!target) return null

  let raw: string
  try {
    raw = await readFile(target, 'utf8')
  } catch {
    return null
  }
  // Walk from the end so a long transcript costs one parse, not a full scan.
  const lines = raw.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const parsed = parseLine(lines[i])
    if (!parsed) continue
    const u = parsed.usage
    return (
      (u.input_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0)
    )
  }
  return null
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
} = {}): Promise<UsageBreakdown> => {
  const root = opts.projectsDir ?? claudeProjectsDir()
  const days = opts.days && opts.days > 0 ? opts.days : 7
  const now = opts.now ?? Date.now()
  const cutoffMs = now - days * 24 * 60 * 60 * 1000
  const fileCutoffMs = cutoffMs - FILE_MTIME_SLACK_MS
  const projectDirs = new Set(opts.projectDirs ?? [])

  let files: string[] = []
  try {
    files = await walkJsonl(root)
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
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch {
      continue
    }
    const dirName = basename(join(file, '..'))
    const source: UsageSourceKind = isSwarmWorktreeDirName(dirName)
      ? 'swarm-worker'
      : projectDirs.has(dirName)
        ? 'project'
        : 'other'
    for (const line of raw.split('\n')) {
      const parsed = parseLine(line)
      if (!parsed) continue
      const ts = Date.parse(parsed.timestamp)
      if (!Number.isFinite(ts) || ts < cutoffMs) continue
      if (!countOnce(seen, parsed)) continue
      if (!parsed.model) continue
      const u = parsed.usage
      const billed = (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
      if (billed <= 0) continue
      const key = `${parsed.model}\u0000${source}`
      sums.set(key, (sums.get(key) ?? 0) + billed)
    }
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

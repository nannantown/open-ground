import { readdir, readFile, stat } from 'fs/promises'
import { homedir } from 'os'
import { basename, join } from 'path'
import type { ClaudeUsage } from '../types'

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

      if (parsed.messageId) {
        const dedupKey = parsed.requestId
          ? `${parsed.messageId}|${parsed.requestId}`
          : parsed.messageId
        if (seen.has(dedupKey)) continue
        seen.add(dedupKey)
      }

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
    files = await walkJsonl(projectsDir)
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

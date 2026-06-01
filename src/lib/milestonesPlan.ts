// Phase 6.B — parser for the `OPENGROUND_MILESTONES_PLAN:` marker Claude
// emits when asked to break a Goal into milestones. Mirrors OPENGROUND_RESULT
// in shape so a single tail-line scan recovers the structured payload
// without needing a separate transport channel.
//
// The marker carries a JSON object like:
//   OPENGROUND_MILESTONES_PLAN: {"milestones":[{"name":"...","verifyCommands":["..."],"order":0}, ...]}
//
// `parseMilestonesPlan` returns the parsed milestone list or null when no
// marker / invalid JSON. Defensive — even malformed Claude output should
// not throw inside the UI.

export interface MilestonePlanItem {
  name: string
  description?: string
  verifyCommands?: string[]
  order?: number
}

const MARKER_RE = /OPENGROUND_MILESTONES_PLAN:\s*(\{[\s\S]*?\})\s*$/

export const parseMilestonesPlan = (log: string): MilestonePlanItem[] | null => {
  if (!log) return null
  // Look from the bottom up so we always pick up the *latest* plan emission
  // (Claude may iterate within one round). Reverse-iterate trimmed lines so
  // the same regex can match a single line confidently.
  const lines = log.split('\n')
  let raw: string | null = null
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/OPENGROUND_MILESTONES_PLAN:\s*(\{.*\})/)
    if (m) {
      raw = m[1]
      break
    }
  }
  // Also try a multi-line greedy match in case Claude pretty-printed the JSON.
  if (!raw) {
    const m = log.match(MARKER_RE)
    if (m) raw = m[1]
  }
  if (!raw) return null
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const ms = (obj as { milestones?: unknown }).milestones
  if (!Array.isArray(ms)) return null
  const out: MilestonePlanItem[] = []
  for (const item of ms) {
    if (!item || typeof item !== 'object') continue
    const it = item as Partial<MilestonePlanItem>
    if (typeof it.name !== 'string' || !it.name.trim()) continue
    out.push({
      name: it.name.trim(),
      ...(typeof it.description === 'string' ? { description: it.description } : {}),
      ...(Array.isArray(it.verifyCommands)
        ? {
            verifyCommands: it.verifyCommands.filter(
              c => typeof c === 'string' && c.trim(),
            ),
          }
        : {}),
      ...(typeof it.order === 'number' ? { order: it.order } : {}),
    })
  }
  return out.length > 0 ? out : null
}

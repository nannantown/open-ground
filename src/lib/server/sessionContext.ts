// sessionContext.ts — resolve each live claude pane's context-window FILL for the
// beacon (GET /api/terminal/active), as a 0–100 "% still free" signal.
//
// Two sources, per the card-1 spike (docs/CONTEXT_MANAGEMENT_PLAN.md §3-B3/§5):
//   • MAIN — the session's JSONL usage sum (always available, non-invasive):
//     `input + cache_read + cache_creation ÷ 200k`, matched the CLI's own
//     `/context` readout exactly in the spike.
//   • ALARM — the on-screen `Context left until auto-compact: N%` footnote, which
//     claude only paints NEAR the limit. When present it OVERRIDES the JSONL
//     estimate (a sharper, more urgent value at exactly the moment it matters).
//
// This is a SIGNAL only — for the gauge (card 5) and task-boundary hint (card 3).
// It never triggers compaction; native auto-compact still owns that (spike §0).
//
// Kept OUT of terminal.ts (the synchronous pty-pool Map scan) and mirrored on
// terminalProjects.attachProjectIds: a separate, async, transcript-reading enrich
// the beacon route chains on. Seams are injected so it is unit-testable without a
// live PTY pool or a real ~/.claude transcript.

import type { ActiveTerminalsResponse } from '@/lib/types'
import type { ContextLeftSource } from '@/lib/contextGauge'
import { extractContextLeftPct } from '@/lib/claudeScreen'
import { getTerminal, getTerminalScreen } from './terminal'
import { CONTEXT_WINDOW_TOKENS, sessionContextTokens } from './claudeUsage'

const clampPct = (n: number): number => Math.max(0, Math.min(100, n))

/** Injected seams so the resolver runs without a live pool or real transcript. */
export interface ContextLeftDeps {
  /** A pane's current rendered screen (read for the near-limit footnote). */
  getScreen: (id: string) => string | null
  /** The claude session id a pane is driving (the JSONL key), or null. */
  getSessionId: (id: string) => string | null
  /** A session's context FILL in tokens, from its JSONL. */
  contextTokens: (sessionId: string, projectsDir?: string) => Promise<number | null>
}

const defaultDeps: ContextLeftDeps = {
  getScreen: getTerminalScreen,
  getSessionId: (id) => getTerminal(id)?.agentSessionId ?? null,
  contextTokens: sessionContextTokens,
}

/** A pane's reading, WITH the scale it is on. The two sources have different
 *  denominators — 'footnote' counts down to the auto-compact threshold, 'jsonl'
 *  to the 200k window — so a consumer that colours or labels the number has to
 *  know which one it got (see src/lib/contextGauge.ts). */
export interface ContextLeftReading {
  pct: number
  source: ContextLeftSource
}

/** One pane's context-left %: the on-screen footnote wins when present (near-limit
 *  alarm), else the JSONL usage estimate (the always-on main source). null when
 *  neither yields a number (no footnote AND no transcript line yet). */
export const paneContextLeft = async (
  terminalId: string,
  deps: ContextLeftDeps = defaultDeps,
  projectsDir?: string,
): Promise<ContextLeftReading | null> => {
  const screen = deps.getScreen(terminalId)
  const footnote = screen ? extractContextLeftPct(screen) : null
  if (footnote != null) return { pct: clampPct(footnote), source: 'footnote' }

  const sessionId = deps.getSessionId(terminalId)
  if (!sessionId) return null
  const usedTokens = await deps.contextTokens(sessionId, projectsDir)
  if (usedTokens == null) return null
  return {
    pct: clampPct(Math.round((1 - usedTokens / CONTEXT_WINDOW_TOKENS) * 100)),
    source: 'jsonl',
  }
}

/** Copy of `res` whose every claude entry carries `contextLeftPct` (a number, or
 *  null when unknown — the card's contract: "なければ null") plus the
 *  `contextLeftSource` that produced it (null alongside a null reading), so the
 *  gauge can label/colour the two scales apart. Best-effort per pane: a resolver
 *  fault degrades that one pane to null rather than failing the whole beacon.
 *  Panes are resolved concurrently. `deps`/`projectsDir` are injected for tests;
 *  production reads the live pool and the real ~/.claude transcripts. */
export const attachContextLeftPct = async (
  res: ActiveTerminalsResponse,
  deps: ContextLeftDeps = defaultDeps,
  projectsDir?: string,
): Promise<ActiveTerminalsResponse> => {
  if (res.claude.length === 0) return res
  const claude = await Promise.all(
    res.claude.map(async (a) => {
      let reading: ContextLeftReading | null = null
      try {
        reading = await paneContextLeft(a.id, deps, projectsDir)
      } catch {
        reading = null
      }
      return {
        ...a,
        contextLeftPct: reading?.pct ?? null,
        contextLeftSource: reading?.source ?? null,
      }
    }),
  )
  return { ...res, claude }
}

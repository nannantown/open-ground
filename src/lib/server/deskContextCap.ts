// deskContextCap — the resident desks' context cap (owner decision 2026-09-18).
//
// THE PROBLEM (measured 2026-09-18 from ~/.claude/projects/*.jsonl): the 5-hour
// window drained in ~2h, and the fingerprint was cache READS — 50.8M against 992
// input tokens. That is a desk carrying a huge context and talking often. The
// resident desks (commander, supply officer) are 1M-context sessions that are
// resumed forever, and native auto-compact only fires near ~950k (seen firing
// on the supply desk at 965k → 170k), so every turn between 0 and ~950k
// re-reads the whole, still-growing conversation.
//
// THE CAP fires EARLIER, and differently per role (owner's decision):
//   • COMMANDER — RECYCLE. It is stateless by design: MANAGER_RESUME_INJECTION
//     already orders it to distrust its memory and re-read the world through the
//     API and git. Dropping the conversation loses nothing, and costs nothing —
//     a summary would have to read the whole context to write it. So at SPAWN,
//     a persisted conversation over the cap is not resumed; a fresh one opens
//     with the same re-read instruction. (This module — the decision.)
//   • SUPPLY OFFICER — COMPACT. Its conversation with the owner continues, so
//     cutting the thread would be felt. It is sent one compaction command once idle
//     (supplyContextCap.ts).
// Native auto-compact itself is untouched.
//
// The measure is sessionContextTokens (claudeUsage.ts) — the same fill the CLI's
// /context prints. Fail-OPEN everywhere: an unreadable fill or setting means the
// desk behaves exactly as before (resumes), never that a conversation is dropped
// on a guess.

import { randomUUID } from 'crypto'
import { sessionContextTokens } from './claudeUsage'
import { getDeskContextCapTokens } from './store'

export interface DeskSessionChoice {
  agentSessionId: string
  resume: boolean
}

export interface CappedDeskSession {
  session: DeskSessionChoice
  /** The context fill (tokens) of the conversation that was NOT resumed because
   *  it was over the cap; null ⇒ nothing was recycled. */
  recycledFromTokens: number | null
}

export interface DeskContextCapDeps {
  contextTokens?: (sessionId: string) => Promise<number | null>
  cap?: () => Promise<number>
  newId?: () => string
}

/** Decide whether a desk that is about to RESUME `session` should open a fresh
 *  conversation instead. Only a resume can be recycled (a fresh session has no
 *  context to cap). Never throws. */
export const recycleDeskSessionIfOverCap = async (
  session: DeskSessionChoice,
  deps: DeskContextCapDeps = {},
): Promise<CappedDeskSession> => {
  const keep: CappedDeskSession = { session, recycledFromTokens: null }
  if (!session.resume) return keep
  let cap: number
  let tokens: number | null
  try {
    cap = await (deps.cap ?? getDeskContextCapTokens)()
    if (!(cap > 0)) return keep // 0 = off
    tokens = await (deps.contextTokens ?? sessionContextTokens)(session.agentSessionId)
  } catch {
    return keep
  }
  if (tokens === null || tokens < cap) return keep
  return {
    session: { agentSessionId: (deps.newId ?? randomUUID)(), resume: false },
    recycledFromTokens: tokens,
  }
}

/** The engine-log line for a recycled desk (owner-readable, next to the
 *  `consumption:` lines). */
export const deskRecycledLogLine = (deskLabel: string, fromTokens: number): string =>
  `${deskLabel}の卓を作り直した(文脈 ${fromTokens.toLocaleString('en-US')} から 0 へ)— 文脈上限を超えたため前回の会話を再開せず新しい会話で起動`

/** The engine-log line for a compacted desk. */
export const deskCompactedLogLine = (deskLabel: string, fromTokens: number, toTokens: number | null): string =>
  `${deskLabel}の卓を圧縮した(文脈 ${fromTokens.toLocaleString('en-US')} から ${toTokens === null ? '不明' : toTokens.toLocaleString('en-US')} へ)`

// supplyContextCap — compact the SUPPLY desk early, once its context passes the
// desk context cap (owner decision 2026-09-18; the why is in deskContextCap.ts).
//
// The supply officer is the owner's conversation desk, so it is COMPACTED, not
// recycled: `/compact` keeps the thread (summarised) where a fresh conversation
// would cut it. The commander is recycled at spawn instead (swarmManager.ts).
//
// MEASURED before this was built (scripts/probe-desk-compact.mts, 2026-09-18,
// throwaway desks): a `/compact` line is ACCEPTED on both runtimes —
//   PTY (app launch route → zsh -l → claude TUI): compact_boundary manual, 40,237 → 9,845
//   SDK (spawnSdkSession + pushSdkInput):        compact event   manual, 27,245 → 1,502
// The supply desk is PTY-only today (spawnSwarmSupply → launchClaude), so only
// the PTY arm is wired; if it ever moves to the SDK, `pushSdkInput(id,
// '/compact')` is the measured equivalent.
//
// WRITING INTO A LIVE DESK — three refusals, not one (0728 lesson): reused
// verbatim from the engine's notice channel, {@link noticeDeliverable}: not
// generating, input box READ and EMPTY (null is not empty), no menu open. Any
// refusal ⇒ "not now", the next pass asks again. Nothing here ever sends ESC or
// kills anything; the worst case is the keystroke the owner would have typed.
//
// ONE SEND PER COMPACTION: after sending, the desk is remembered as pending
// until its fill drops under the cap (sessionContextTokens reads the
// compact_boundary's postTokens as soon as it lands) — then ONE engine-log line
// 「補給官の卓を圧縮した(文脈 N → M)」. A pending send that never lands is
// retried after COMPACT_RETRY_MS, never every pass.
//
// Native auto-compact is untouched; this only fires earlier than it would.

import { noticeDeliverable } from './deskDeliverable'
import { SUPPLY_DESK_LABEL } from './swarmSupply'
import { listOwnerDeskTerminals, isTerminalProcessAlive, getTerminalScreen, writeInput } from './terminal'
import { sendClaudeSlash } from './claudeSlash'
import { sessionContextTokens } from './claudeUsage'
import { getDeskContextCapTokens } from './store'
import { logToEngine } from './engineLogSink'
import { deskCompactedLogLine } from './deskContextCap'
import { flushSupplyNotices } from './supplyNotice'
import { kickAllCommanderQuestionSweeps } from './commanderQuestions'
import type { OrchestratorLogLine } from '../types'

/** How often the loop measures. A desk grows by one turn at a time, so a minute
 *  late costs at most a turn or two over the cap. */
export const SUPPLY_CONTEXT_CAP_INTERVAL_MS = 60_000

/** How long a sent `/compact` may take to show up in the transcript before it
 *  counts as lost and may be sent again. Measured compactions of a ~1M desk
 *  took 160s (durationMs in the real supply transcript); 20 minutes is far past
 *  that while still bounding a desk that silently swallowed the line. */
export const COMPACT_RETRY_MS = 20 * 60 * 1000

export interface SupplyDesk {
  id: string
  cwd: string
  agentSessionId?: string
}

export interface SupplyContextCapDeps {
  desks: () => SupplyDesk[]
  isAlive: (terminalId: string) => boolean
  contextTokens: (sessionId: string) => Promise<number | null>
  cap: () => Promise<number>
  screen: (terminalId: string) => string | null
  /** Type the compaction into the desk; true iff the keystrokes were written. */
  sendCompact: (terminalId: string) => boolean
  log: (projectPath: string, level: OrchestratorLogLine['level'], message: string) => void
  now: () => number
}

const defaultDeps: SupplyContextCapDeps = {
  desks: () => listOwnerDeskTerminals().filter((d) => d.deskLabel === SUPPLY_DESK_LABEL),
  isAlive: isTerminalProcessAlive,
  contextTokens: (sid) => sessionContextTokens(sid),
  cap: getDeskContextCapTokens,
  screen: getTerminalScreen,
  // The sanctioned slash sender (claudeSlash.ts — the context gauge's own
  // 「今すぐ圧縮」 path), so the exact keystrokes are the ones already proven.
  sendCompact: (id) => sendClaudeSlash(id, 'compact', undefined, { getScreen: getTerminalScreen, write: writeInput }).ok,
  log: logToEngine,
  now: Date.now,
}

interface Pending {
  sentAt: number
  fromTokens: number
}

interface SupplyCapState {
  pending: Map<string, Pending>
  passInFlight: boolean
}

declare global {
  // eslint-disable-next-line no-var
  var __openground_supply_context_cap: SupplyCapState | undefined
  // eslint-disable-next-line no-var
  var __openground_supply_context_cap_timer: ReturnType<typeof setInterval> | null | undefined
}

const state: SupplyCapState =
  globalThis.__openground_supply_context_cap ??
  (globalThis.__openground_supply_context_cap = { pending: new Map(), passInFlight: false })

export const resetSupplyContextCapState = (): void => {
  state.pending.clear()
  state.passInFlight = false
}

export interface SupplyContextCapPassResult {
  /** Terminal ids a `/compact` was typed into this pass. */
  sent: string[]
  /** Terminal ids whose compaction landed (and was logged) this pass. */
  compacted: string[]
}

/** One measurement pass over every live supply desk. Never throws. */
export const runSupplyContextCapPass = async (
  partial: Partial<SupplyContextCapDeps> = {},
): Promise<SupplyContextCapPassResult> => {
  const deps = { ...defaultDeps, ...partial }
  const out: SupplyContextCapPassResult = { sent: [], compacted: [] }
  if (state.passInFlight) return out
  state.passInFlight = true
  try {
    const cap = await deps.cap().catch(() => 0)
    const seen = new Set<string>()
    for (const d of deps.desks()) {
      const sid = d.agentSessionId
      if (!sid || !deps.isAlive(d.id)) continue
      seen.add(sid)
      if (!(cap > 0)) continue // 0 = off
      const tokens = await deps.contextTokens(sid).catch(() => null)
      const pending = state.pending.get(sid)
      if (pending) {
        if (tokens !== null && tokens < cap) {
          state.pending.delete(sid)
          deps.log(d.cwd, 'info', deskCompactedLogLine('補給官', pending.fromTokens, tokens))
          out.compacted.push(d.id)
          continue
        }
        if (deps.now() - pending.sentAt < COMPACT_RETRY_MS) continue // still compacting
        state.pending.delete(sid) // lost — fall through and try again
      }
      if (tokens === null || tokens < cap) continue
      if (!noticeDeliverable(deps.screen(d.id))) continue // busy / half-typed / menu — next pass
      if (!deps.sendCompact(d.id)) continue
      state.pending.set(sid, { sentAt: deps.now(), fromTokens: tokens })
      out.sent.push(d.id)
    }
    // Forget desks that are gone, so the map cannot grow across restarts of desks.
    for (const sid of Array.from(state.pending.keys())) if (!seen.has(sid)) state.pending.delete(sid)
  } catch {
    /* a failed pass must never kill the loop */
  } finally {
    state.passInFlight = false
  }
  return out
}

/** Start the loop — wired ONCE at server boot (server/index.ts), independent of
 *  the swarm engine and of the UI (a supply desk talks to the owner whether or
 *  not the engine runs). Idempotent + reload-safe; `unref`'d. */
export const startSupplyContextCapLoop = (intervalMs: number = SUPPLY_CONTEXT_CAP_INTERVAL_MS): void => {
  if (globalThis.__openground_supply_context_cap_timer) {
    clearInterval(globalThis.__openground_supply_context_cap_timer)
  }
  const timer = setInterval(() => {
    // Re-offer any notice a busy desk refused (supplyNotice.ts). It rides THIS
    // loop rather than starting one of its own: the owner decision that asked
    // for the channel also forbade adding polling, and this is already the pass
    // that walks every live supply desk. Delivery on the happy path happened
    // inline at queue time; this is only the retry.
    flushSupplyNotices()
    // Backstop for the commander question lane (commanderQuestions.ts): a
    // question held inside the company must reach someone even with no engine
    // running to carry its sweep.
    void kickAllCommanderQuestionSweeps()
    void runSupplyContextCapPass().catch(() => {})
  }, intervalMs)
  ;(timer as { unref?: () => void }).unref?.()
  globalThis.__openground_supply_context_cap_timer = timer
}

export const stopSupplyContextCapLoop = (): void => {
  if (globalThis.__openground_supply_context_cap_timer) {
    clearInterval(globalThis.__openground_supply_context_cap_timer)
    globalThis.__openground_supply_context_cap_timer = null
  }
}

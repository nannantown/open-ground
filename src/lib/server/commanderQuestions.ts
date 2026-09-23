// commanderQuestions — a worker's question is settled INSIDE the company first
// (owner decision 2026-09-23: 「僕が喋るのは社長さんだけ」).
//
// WHY. Until 2026-09-19 a proxy (Persona) absorbed workers' everyday questions.
// With it removed, EVERY question a worker wrote went straight to the owner's
// inbox, and the worker sat waiting — the owner, who does not want to see the
// commander or the workers at all, found work stopped on questions like "which
// helper should I reuse?". Those are engineering choices; the commander owns
// them (DECISION_ROUTING_RULES already said so, and nothing routed them there).
//
// THE LANE.
//   1. openEscalation({askCommanderFirst:true}) records the question with
//      `routedTo:'commander'` and rings NOTHING — unless its text touches a
//      standing owner boundary (needsOwnerDirectly), which goes to the owner as
//      before. That word list is the structural stop, not the commander's
//      judgement.
//   2. This sweep hands each such question to the commander desk (waking one if
//      none is standing — commanderRelay.ts, the same path manager/say takes) and
//      stamps `commanderToldAt` so it is said once.
//   3. The commander either ANSWERS it (`POST /api/swarm/escalations/answer`
//      with `by:'commander'`; the worker is told, in words, that the commander —
//      not the owner — answered), or RAISES it (`POST /api/swarm/escalations/raise`)
//      with a plain-language rendering, which is when the owner — through the
//      supply desk — first hears of it.
//   4. FAIL-SAFE: a question the commander has not settled within
//      COMMANDER_ANSWER_WINDOW_MS is promoted to the owner automatically. The
//      lane can only ever make a question reach the owner LATER, never not at all.
//
// NO MODEL IS CALLED HERE and nothing polls on its own: the sweep rides the
// engine pass that already runs, throttled to COMMANDER_SWEEP_MS, off-tick.

import {
  listEscalations,
  markCommanderTold,
  raiseEscalationToOwner,
} from './swarmEscalations'
import { relayToCommander } from './commanderRelay'
import type { Escalation } from '../types'

const envMinutesMs = (name: string, defMin: number, minMin: number, maxMin: number): number => {
  const raw = Number(process.env[name])
  const min = Number.isFinite(raw) && raw > 0 ? Math.min(Math.max(raw, minMin), maxMin) : defMin
  return min * 60_000
}

/** How long a question may sit with the commander before the owner is asked
 *  instead. Short on purpose: the worker is blocked the whole time, and the
 *  engine parks a question-blocked worker after QUESTION_GRACE_MS (30m). */
export const COMMANDER_ANSWER_WINDOW_MS = envMinutesMs('OPENGROUND_COMMANDER_ANSWER_WINDOW_MIN', 10, 2, 60)

/** Minimum gap between two sweeps of one project. */
export const COMMANDER_SWEEP_MS = 20_000

/** The line the commander receives. Carries the id and both exits, because an
 *  SDK commander resumed from a compacted conversation may no longer hold the
 *  skill text — the obligation travels with the line. Pure. */
export const commanderQuestionText = (e: Escalation, windowMs = COMMANDER_ANSWER_WINDOW_MS): string => {
  const flat = (s: string, n: number) => {
    const t = s.replace(/\s+/g, ' ').trim()
    return t.length > n ? `${t.slice(0, n)}…` : t
  }
  const mins = Math.round(windowMs / 60_000)
  return (
    `【社内の質問】ワーカー${e.branch ? `(${e.branch})` : ''}が作業を止めて質問しています(id=${e.id}): ` +
    `「${flat(e.question, 1200)}」 ` +
    `カードの完了条件・リポジトリの決まり・調査で判断できる技術的なことなら、あなたが決めて答えてください: ` +
    `POST $OG/api/swarm/escalations/answer {"id":"${e.id}","answer":"<答え>","by":"commander"}。` +
    `オーナーにしか決められないこと(目的・好み・公開・削除・費用など)なら、平易な文で渡してください: ` +
    `POST $OG/api/swarm/escalations/raise {"id":"${e.id}","plainQuestion":"<①決めること ②選択肢 ③それぞれどうなるか>"}。` +
    `${mins}分以内にどちらもしなければ自動でオーナーに回ります。`
  )
}

export interface CommanderQuestionDeps {
  now: () => number
  listOpen: (projectPath: string) => Promise<Escalation[]>
  tell: (projectPath: string, text: string) => Promise<boolean>
  markTold: (id: string, atIso: string) => Promise<void>
  raise: (id: string) => Promise<unknown>
  windowMs: number
}

const defaultDeps: CommanderQuestionDeps = {
  now: Date.now,
  listOpen: (projectPath) => listEscalations({ projectPath, status: 'open' }),
  tell: async (projectPath, text) => {
    const r = await relayToCommander(projectPath, text, { wake: true })
    return r.ok && r.delivered
  },
  // Lambdas, not captured references: this module sits in an import cycle with
  // swarmEscalations → swarmOrchestrator, so a binding read at init may be unset.
  markTold: (id, at) => markCommanderTold(id, at),
  raise: (id) => raiseEscalationToOwner(id),
  windowMs: COMMANDER_ANSWER_WINDOW_MS,
}

export interface CommanderSweepOutcome {
  told: string[]
  raised: string[]
}

/**
 * One pass over a project's commander-lane questions: promote the overdue ones
 * to the owner, hand the untold ones to the commander. Never throws.
 */
export const sweepCommanderQuestions = async (
  projectPath: string,
  partial: Partial<CommanderQuestionDeps> = {},
): Promise<CommanderSweepOutcome> => {
  const deps = { ...defaultDeps, ...partial }
  const out: CommanderSweepOutcome = { told: [], raised: [] }
  let open: Escalation[]
  try {
    open = (await deps.listOpen(projectPath)).filter((e) => e.routedTo === 'commander')
  } catch {
    return out
  }
  const now = deps.now()
  for (const e of open) {
    try {
      const age = now - Date.parse(e.createdAt)
      // An unparseable timestamp cannot prove the question is fresh — hand it on
      // (the fail-safe direction: the owner hears of it).
      if (!(age < deps.windowMs)) {
        await deps.raise(e.id)
        out.raised.push(e.id)
        continue
      }
      if (e.commanderToldAt) continue
      if (await deps.tell(projectPath, commanderQuestionText(e, deps.windowMs))) {
        await deps.markTold(e.id, new Date(now).toISOString())
        out.told.push(e.id)
      }
      // Not delivered (desk busy / half-typed / could not wake): retried on the
      // next sweep; the window keeps running, so the owner still hears in time.
    } catch {
      /* one bad record must not stop the rest — next sweep retries */
    }
  }
  return out
}

declare global {
  // eslint-disable-next-line no-var
  var __openground_commander_q_sweep: Map<string, { at: number; inFlight: boolean }> | undefined
}
const sweeps: Map<string, { at: number; inFlight: boolean }> =
  globalThis.__openground_commander_q_sweep ?? (globalThis.__openground_commander_q_sweep = new Map())

/** The engine pass's hook: throttled per project, fire-and-forget, one sweep in
 *  flight at a time (waking a commander can take a while and must never hold
 *  the tick). */
export const kickCommanderQuestionSweep = (projectPath: string, now = Date.now()): void => {
  const s = sweeps.get(projectPath) ?? { at: 0, inFlight: false }
  if (s.inFlight || now - s.at < COMMANDER_SWEEP_MS) return
  s.at = now
  s.inFlight = true
  sweeps.set(projectPath, s)
  void sweepCommanderQuestions(projectPath)
    .catch(() => {})
    .finally(() => {
      s.inFlight = false
    })
}

/** The boot-wide backstop, riding the supply desk loop (60s, runs whether or
 *  not any engine does): a question left in the commander lane when its engine
 *  stopped must still reach the commander or, past the window, the owner. */
export const kickAllCommanderQuestionSweeps = async (now = Date.now()): Promise<void> => {
  try {
    const open = await listEscalations({ status: 'open' })
    const projects = new Set(open.filter((e) => e.routedTo === 'commander').map((e) => e.projectPath))
    for (const p of Array.from(projects)) kickCommanderQuestionSweep(p, now)
  } catch {
    /* next loop retries */
  }
}

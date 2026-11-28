// swarmStanding — where a project stands, decided in ONE place (AUTONOMY-SPEC
// R-A1 / R-A2 / R-E1).
//
// Six engine fields hold work today (savedWorkHold, sdkSpawnHold, parkUntil,
// manualStop, the manager's offline hold, the boot-resume map) and each told the
// owner through a different path, so every silent stop so far was found by the
// owner and patched one cause at a time. Here every hold field has ONE adapter
// that names it in the owner's words; the Ground lamp, the agent-team bar and
// the president's status answer read the result and nothing else.
//
// The next unknown cause is caught by `unexplained`: work is needed, nothing
// serves it, nothing progressed for STANDING_STALL_MS, and no adapter can say
// why. That is a defect report, not a normal state — the engine's watchdog
// journals the facts and tells the owner once (swarmOrchestrator watchStanding).
//
// Pure: every input is a fact handed in, so each case is testable without an
// engine, a clock or a disk. Adding a hold = one fact + one adapter line.

import { projectPanel } from '../../i18n/messages/projectPanel'
import { settings } from '../../i18n/messages/settings'
import { APP_SIGN_IN_WHERE, CHATGPT_REVIEW_HOLD_HINT, CHATGPT_SIGN_IN_HOLD_HINT, CHATGPT_UNREADABLE_HOLD_HINT, OWNER_REVIEW_HOLD_HINT } from './savedWorkHold'
import type { ProjectStanding, StandingReason, StandingReasonKind, StandingState } from '../types'

/** How long a need may stand with no progress and no reason before it is
 *  `unexplained` (R-A2). */
export const STANDING_STALL_MS = 15 * 60_000

type Lang = 'ja' | 'en'

/** What the standing is computed from. Each hold field is optional and absent
 *  when it holds nothing — the facts builder (swarmOrchestrator
 *  standingFactsOf) reads them off the engine. */
export interface StandingFacts {
  now: number
  lang: Lang
  /** The engine's drain chain is on (engine.running). */
  engineRunning: boolean
  /** Work waiting to be served (see ProjectStanding.needs). */
  needs: { dispatch: number; integrate: number }
  /** Something is serving the work right now: a live counted worker, or the
   *  commander mid-turn. */
  serving: boolean
  /** Last observed progress (reported only). */
  progressedAt?: number
  /** Since when a need has stood with no progress and no reason — the
   *  watchdog's clock. Absent ⇒ never measured (no engine pass) ⇒ never stalled. */
  quietSince?: number
  // ── hold fields (one adapter each) ──
  /** Open escalations for the owner. */
  openQuestions?: number
  /** engine.savedWorkHold: an unconfirmed operation, or the launch guard's
   *  question unanswerable (`unanswered` = its error). */
  savedWorkHold?: { count: number; unanswered?: string }
  /** The owner switched every model tier off (spawnBlock 'none-allowed'). */
  modelsOff?: boolean
  /** The boot resume is held (its reason is Japanese-only); `ownerOnly` = only
   *  the owner's review clears it. */
  bootHold?: { reason: string; ownerOnly?: boolean }
  /** Stopped by hand (in memory or the persisted record). */
  manualStop?: boolean
  /** In a Ground with an automation frame, but outside it. */
  outsideFrame?: boolean
  /** Every enabled tier cooling — dispatch parked until this instant. */
  parkUntil?: number
  /** SDK spawn-failure backoff — no dispatch until this instant. */
  sdkSpawnHold?: { until: number }
  /** The machine is offline and the engine holds its voice to the commander. */
  offlineHold?: boolean
  /** The budget gate (swarmBudget) held this pass's candidates: the hold that
   *  lifts soonest, or only the note that no usage reading was fresh enough. */
  budget?: { kind: 'window-headroom' | 'weekly-pace' | 'weekly-reserve' | 'usage-unknown'; until?: number }
  /** engine.automationBlocked: inside the frame, but automatic operation is not
   *  allowed right now (the owner signed out, the owner role lost). */
  automationBlocked?: boolean
  /** The commander's SDK desk is paused on a usage refusal until this instant
   *  (sdkQuotaPause) — a per-model limit cools only its tier, so no park says it. */
  commanderQuotaPause?: { until: number }
  /** A waiting card's dispatch keeps failing and the president was told
   *  (engine.dispatchFailures, its own 'automation-held' notice). */
  dispatchFailing?: boolean
  /** The engine gave up reviving the commander ('manager-unrevivable' rang) or it
   *  ignored every poke ('manager-unresponsive' rang). */
  commanderDown?: boolean
}

const MESSAGES = { ja: projectPanel.ja, en: projectPanel.en } as Record<Lang, Record<string, string>>

const say = (lang: Lang, key: string, vars: Record<string, string | number> = {}): string =>
  Object.entries(vars).reduce(
    (s, [k, v]) => s.split(`{${k}}`).join(String(v)),
    MESSAGES[lang][`projectPanel.standing.${key}`] ?? MESSAGES.en[`projectPanel.standing.${key}`] ?? key,
  )

/** A clock time on this machine (the app is local: server and owner share it),
 *  with the date when it is not today-ish. */
const clock = (lang: Lang, until: number | undefined, now: number): string => {
  if (until === undefined) return say(lang, 'soon')
  const loc = lang === 'ja' ? 'ja-JP' : 'en-US'
  const d = new Date(until)
  const time = d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' })
  return until - now >= 20 * 3_600_000 ? `${d.toLocaleDateString(loc, { month: 'numeric', day: 'numeric' })} ${time}` : time
}

/** Where the owner answers for an unconfirmed operation: its question in the bar —
 *  or, for a held ChatGPT desk conversation, which raises no question there, the
 *  Settings recovery panel, by that screen's own labels (review R2 S-4). */
const reviewAction = (lang: Lang, door: 'inbox' | 'settings' = 'inbox'): string =>
  door === 'settings'
    ? say(lang, 'action.reviewSettings', { advanced: settings[lang]['settings.advanced'], recovery: settings[lang]['settings.recovery.title'] })
    : say(lang, 'action.review')

const reason = (kind: StandingReasonKind, plain: string, extra: Omit<StandingReason, 'kind' | 'plain'> = {}): StandingReason => ({ kind, plain, ...extra })

/** A hold on dispatch / the commander's wake that lifts by itself (at `until`,
 *  when known), in the sentence keyed by its kind. Said only while work is
 *  waiting for it — a park over an empty todo column holds nothing. */
const held = (f: StandingFacts, kind: StandingReasonKind, until?: number): StandingReason | null =>
  f.needs.dispatch + f.needs.integrate > 0
    ? reason(kind, say(f.lang, kind, { time: clock(f.lang, until, f.now) }), until !== undefined ? { until } : {})
    : null

/** One adapter per hold field. `fact` names the field it reads — the test
 *  removes each in turn and expects exactly that field's cases to go red. */
export const STANDING_ADAPTERS: ReadonlyArray<{ fact: keyof StandingFacts; reason: (f: StandingFacts) => StandingReason | null }> = [
  {
    fact: 'openQuestions',
    reason: (f) =>
      f.openQuestions
        // Both doors (review R2 S-5): the president answers every question, but a
        // held operation's question is also answered in the bar — the only door
        // when the president's own conversation is the held one.
        ? reason('owner-question', say(f.lang, 'question', { count: f.openQuestions }), { ownerAction: say(f.lang, 'action.question') })
        : null,
  },
  {
    // An unconfirmed operation holds until the owner reviews it — the inbox
    // question it becomes once holds are scoped (spec U2) is the same ask.
    fact: 'savedWorkHold',
    reason: (f) => {
      const h = f.savedWorkHold
      if (!h) return null
      if (h.unanswered === undefined) return reason('owner-question', say(f.lang, 'savedWork'), { ownerAction: reviewAction(f.lang) })
      const signIn = /sign-in/i.test(h.unanswered)
      return reason('owner-question', say(f.lang, signIn ? 'signIn' : 'recordUnreadable'), { ownerAction: say(f.lang, signIn ? 'action.signIn' : 'action.restart', { signIn: APP_SIGN_IN_WHERE[f.lang] }) })
    },
  },
  {
    fact: 'modelsOff',
    reason: (f) => (f.modelsOff ? reason('models-off', say(f.lang, 'models-off'), { ownerAction: say(f.lang, 'action.models') }) : null),
  },
  {
    fact: 'bootHold',
    reason: (f) => {
      const h = f.bootHold
      if (!h) return null
      // The hold's own words are Japanese only (swarmRuntimeTransition); English gets the plain fact.
      const plain = f.lang === 'ja' ? say(f.lang, 'boot-pending.why', { reason: h.reason }) : say(f.lang, 'boot-pending')
      if (!h.ownerOnly) return reason('boot-pending', plain)
      // The hold's own words name its door; a reason joining several names each.
      const settingsDoor = h.reason.includes(CHATGPT_REVIEW_HOLD_HINT)
      const signInDoor = h.reason.includes(CHATGPT_SIGN_IN_HOLD_HINT)
      const unreadable = h.reason.includes(CHATGPT_UNREADABLE_HOLD_HINT)
      const inboxDoor = !(settingsDoor || signInDoor || unreadable) || h.reason.includes(OWNER_REVIEW_HOLD_HINT)
      const doors = [inboxDoor && reviewAction(f.lang), settingsDoor && reviewAction(f.lang, 'settings'),
        signInDoor && say(f.lang, 'action.chatgptSignIn', { signIn: APP_SIGN_IN_WHERE[f.lang], connect: settings[f.lang]['settings.chatgpt.connect'], workMode: settings[f.lang]['settings.lockdown.heading'], advanced: settings[f.lang]['settings.advanced'], recovery: settings[f.lang]['settings.recovery.title'] }),
        unreadable && say(f.lang, 'action.chatgptUnreadable')].filter(Boolean)
      return reason('boot-pending', plain, { ownerAction: doors.join(' ') })
    },
  },
  { fact: 'manualStop', reason: (f) => (f.manualStop ? reason('manual-stop', say(f.lang, 'manual-stop')) : null) },
  { fact: 'outsideFrame', reason: (f) => (f.outsideFrame ? reason('outside-frame', say(f.lang, 'outside-frame')) : null) },
  { fact: 'parkUntil', reason: (f) => (f.parkUntil === undefined ? null : held(f, 'usage-limit', f.parkUntil)) },
  { fact: 'sdkSpawnHold', reason: (f) => (f.sdkSpawnHold === undefined ? null : held(f, 'spawn-backoff', f.sdkSpawnHold.until)) },
  { fact: 'offlineHold', reason: (f) => (f.offlineHold ? held(f, 'offline') : null) },
  { fact: 'budget', reason: (f) => (f.budget ? held(f, f.budget.kind, f.budget.until) : null) },
  // Holds the engine already knew but the standing did not, so each read as
  // `unexplained` after 15 quiet minutes (review 2026-11-28 B-S3).
  {
    fact: 'automationBlocked',
    reason: (f) => (f.automationBlocked ? reason('owner-question', say(f.lang, 'signIn'), { ownerAction: say(f.lang, 'action.signIn', { signIn: APP_SIGN_IN_WHERE[f.lang] }) }) : null),
  },
  {
    // The commander serves integration only.
    fact: 'commanderQuotaPause',
    reason: (f) =>
      f.commanderQuotaPause && f.needs.integrate > 0
        ? reason('usage-limit', say(f.lang, 'usage-limit.manager', { time: clock(f.lang, f.commanderQuotaPause.until, f.now) }), { until: f.commanderQuotaPause.until })
        : null,
  },
  { fact: 'dispatchFailing', reason: (f) => (f.dispatchFailing ? reason('spawn-backoff', say(f.lang, 'dispatch-failing')) : null) },
  {
    fact: 'commanderDown',
    reason: (f) =>
      // The manager seat's own buttons, by their labels (review R2 S-7): a manual
      // start that comes up clears the give-up (swarmOrchestrator fatalFired).
      f.commanderDown && f.needs.integrate > 0
        ? reason('commander-down', say(f.lang, 'commander-down'), {
            ownerAction: say(f.lang, 'action.manager', { start: MESSAGES[f.lang]['projectPanel.swarm.manager.start'], stop: MESSAGES[f.lang]['projectPanel.swarm.manager.stop'] }),
          })
        : null,
  },
]

/** Reasons that explain why nothing starts but hold nothing themselves. */
const NOTE_KINDS = new Set<StandingReasonKind>(['usage-unknown'])
/** Reasons that mean the autopilot is off on purpose. */
const OFF_KINDS = new Set<StandingReasonKind>(['manual-stop', 'outside-frame'])

/** Where the project stands. `adapters` is injectable for the adapter-removal test only. */
export const standingOf = (f: StandingFacts, adapters = STANDING_ADAPTERS): ProjectStanding => {
  const found = adapters.map((a) => a.reason(f)).filter((r): r is StandingReason => r !== null)
  // What the owner can act on first.
  const reasons = [...found.filter((r) => r.ownerAction), ...found.filter((r) => !r.ownerAction)]
  const blocking = reasons.filter((r) => !NOTE_KINDS.has(r.kind))
  const needed = f.needs.dispatch + f.needs.integrate > 0
  if (
    needed && blocking.length === 0 && !f.serving && f.engineRunning &&
    f.quietSince !== undefined && f.now - f.quietSince >= STANDING_STALL_MS
  ) {
    reasons.push(reason('unexplained', say(f.lang, 'unexplained', { minutes: Math.floor((f.now - f.quietSince) / 60_000) })))
  }
  const held = reasons.some((r) => !NOTE_KINDS.has(r.kind))
  const state: StandingState = reasons.some((r) => r.ownerAction)
    ? 'needs-owner'
    : f.serving
      ? 'running'
      : reasons.some((r) => OFF_KINDS.has(r.kind)) || (!f.engineRunning && !f.bootHold)
        ? 'off'
        : held
          ? 'waiting'
          : needed
            ? 'running' // inside the window: the engine is serving it on its next pass
            : 'idle'
  return {
    state,
    needs: { ...f.needs },
    ...(f.progressedAt !== undefined ? { progressedAt: f.progressedAt } : {}),
    reasons,
  }
}

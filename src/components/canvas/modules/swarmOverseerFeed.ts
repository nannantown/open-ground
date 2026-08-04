// swarmOverseerFeed.ts — PURE, React-free derivations for the Overseer tab's
// "needs attention" feed (SwarmOverseerPane). Carried over from the removed Flow
// tab: the swarm's messages to the owner — persisted FATAL notifications + engine
// anomalies — now live on the Overseer tab (alongside the escalation inbox)
// instead of a banner surface, so they are read where the owner chooses to look.
//
// WHY a separate module (not inlined in the pane): keeping the alert merge
// React-free makes it unit-testable without a DOM — the same split useSwarmEngine
// uses for its pure planSwarmPower.
//
// FATAL EVENTS: the escalation safety valve (card 6fe48c1f) persists EVERY fatal
// event of the unmanned loop as a notification. We surface those (the
// authoritative `SwarmFatalView`s useSwarmEngine polls from
// GET /api/swarm/notifications) — EVERY kind, with no client-side allowlist:
// engine-side ones (rework-exhausted / all-workers-down / exec-timeout /
// review-panel-failed / high-risk-hold / manager-unrevivable /
// engine-resume-suppressed), the worker spawn path's guard-unwired, the Electron
// self-update cycle's rollback / canary-failed, and the boot-time data-integrity
// check — because a hand-kept list here DID silently drop four of them (fixed
// 2026-08-04). Engine `anomalies` (state drift the loop couldn't self-heal) are
// folded in alongside as lower-severity alerts, deduped against the matching
// rework-exhausted notification so it isn't shown twice.

import type { EngineAnomaly, SwarmEngineState, SwarmFatalView } from './useSwarmEngine'

/** Events that arrive on BOTH lanes for the same engine-level fact: a one-shot
 *  fatal notification (the wake-up) and an anomaly re-derived every pass (the
 *  "still true right now" line that a dismissal cannot hide). Neither is
 *  card-rooted, so they are deduped on the kind alone. */
const ENGINE_LEVEL_MIRRORED: ReadonlySet<string> = new Set([
  'all-workers-down',
  'manager-unrevivable',
])

// One "needs attention" alert in the feed. Either a persisted FATAL notification
// (a wake-a-human escalation — any SwarmFatalEvent) or an engine ANOMALY (state
// drift the loop detected but couldn't self-heal). The pane localizes each.
export interface OverseerAlert {
  /** Stable React key. */
  id: string
  /** Origin — drives how the pane labels the row. */
  source: 'fatal' | 'anomaly'
  /** fatal source — the persisted fatal notification (event + server detail). */
  fatal?: SwarmFatalView
  /** anomaly source — the full anomaly (the pane maps `kind` to a localized label). */
  anomaly?: EngineAnomaly
}

// Derive the "needs attention" set: the persisted FATAL notifications first (the
// authoritative escalation source — every kind, including the Electron
// self-update ones the engine state can't carry), newest-first, then the engine
// ANOMALIES (drift). A rework-exhausted that is BOTH a fatal notification and an
// anomaly is shown once (the richer notification wins) — keyed on the card id
// (notification.taskId === anomaly.ref).
export const deriveOverseerAlerts = (
  engine: SwarmEngineState,
  fatalNotifications: readonly SwarmFatalView[] = [],
  // NO DEFAULT, deliberately. With `= new Set()` a caller that forgets to pass
  // the dismissal set still compiles and quietly reverts the feed to
  // never-goes-quiet — the silent-registration failure CLAUDE.md §4 tells us to
  // convert into a build error. Every call site must state its set (tests that
  // only care about the other arguments pass `new Set()` explicitly).
  handledIds: ReadonlySet<string>,
): OverseerAlert[] => {
  const out: OverseerAlert[] = []
  const reworkRefs = new Set<string>()
  // Engine-level events (no card, no branch) that exist in BOTH lanes: the
  // one-shot notification AND the every-pass anomaly mirror. Shown once — see
  // the dedup below.
  const shownEngineEvents = new Set<string>()
  for (const f of fatalNotifications) {
    // Already dealt with — hidden. `f.handled` is the durable server-side
    // `handledAt`; `handledIds` is this session's optimistic set so a clicked
    // row vanishes at once. THIS IS THE ONLY WAY THE FEED GOES QUIET:
    // fatal notifications are persisted for the life of the install and expire
    // only by falling out of the 50-row cap, so without this one `if` the pane's
    // "nothing needs you" state became unreachable the first time anything ever
    // went wrong, and the alert list became wallpaper nobody reads.
    if (f.handled || handledIds.has(f.id)) continue
    if (f.event === 'rework-exhausted' && f.taskId) reworkRefs.add(f.taskId)
    if (ENGINE_LEVEL_MIRRORED.has(f.event)) shownEngineEvents.add(f.event)
    out.push({ id: `fatal:${f.id}`, source: 'fatal', fatal: f })
  }
  for (const a of engine.anomalies) {
    // Skip a rework-exhausted anomaly already covered by a SHOWN fatal
    // notification. Deliberately not covered by a HANDLED one: the notification
    // records an event that happened once, while the anomaly is live engine
    // state — if the drift is still there after the owner acked the event, they
    // should still see it. Marking history read must not hide the present.
    if (a.kind === 'rework-exhausted' && reworkRefs.has(a.ref)) continue
    // …and the same rule for the two ENGINE-LEVEL events, which are mirrored in
    // both lanes on purpose (the notification wakes the owner once; the anomaly
    // keeps the standing failure visible after they dismiss it). While the
    // notification is still SHOWN they are the same fact twice — and this feed's
    // own header warns that a list which repeats itself is one nobody reads.
    // They carry no card, so the match is on the kind alone rather than a ref.
    if (ENGINE_LEVEL_MIRRORED.has(a.kind) && shownEngineEvents.has(a.kind)) continue

    out.push({ id: `anomaly:${a.kind}:${a.ref}`, source: 'anomaly', anomaly: a })
  }
  return out
}

// Compact, language-neutral age token ("32s" / "4m" / "2h" / "3d") for an alert
// timestamp. The pane wraps it in a localized "{age} ago" template, so the
// digits + unit letter stay identical across locales. null on a missing /
// unparseable input.
export const compactAge = (iso: string | undefined | null, nowMs: number): string | null => {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  const sec = Math.max(0, Math.round((nowMs - t) / 1000))
  if (sec < 60) return `${sec}s`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h`
  return `${Math.round(hr / 24)}d`
}

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
// GET /api/swarm/notifications) so ALL FIVE kinds show — the three engine-side
// ones (rework-exhausted / all-workers-down / exec-timeout) AND the two from the
// Electron self-update cycle (rollback / canary-failed), which never touch the
// engine state. Engine `anomalies` (state drift the loop couldn't self-heal) are
// folded in alongside as lower-severity alerts, deduped against the matching
// rework-exhausted notification so it isn't shown twice.

import type { EngineAnomaly, SwarmEngineState, SwarmFatalView } from './useSwarmEngine'

// One "needs attention" alert in the feed. Either a persisted FATAL notification
// (a wake-a-human escalation — the 5 SwarmFatalEvents) or an engine ANOMALY (state
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
// authoritative escalation source — all five kinds, including the Electron
// self-update ones the engine state can't carry), newest-first, then the engine
// ANOMALIES (drift). A rework-exhausted that is BOTH a fatal notification and an
// anomaly is shown once (the richer notification wins) — keyed on the card id
// (notification.taskId === anomaly.ref).
export const deriveOverseerAlerts = (
  engine: SwarmEngineState,
  fatalNotifications: readonly SwarmFatalView[] = [],
): OverseerAlert[] => {
  const out: OverseerAlert[] = []
  const reworkRefs = new Set<string>()
  for (const f of fatalNotifications) {
    if (f.event === 'rework-exhausted' && f.taskId) reworkRefs.add(f.taskId)
    out.push({ id: `fatal:${f.id}`, source: 'fatal', fatal: f })
  }
  for (const a of engine.anomalies) {
    // Skip a rework-exhausted anomaly already covered by its fatal notification.
    if (a.kind === 'rework-exhausted' && reworkRefs.has(a.ref)) continue
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

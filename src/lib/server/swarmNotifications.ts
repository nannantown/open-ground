// swarmNotifications — the in-app half of the escalation safety valve. A FATAL
// event of the unmanned swarm / self-improvement loop (see {@link SwarmFatalEvent})
// becomes (1) a PERSISTED in-app notification the Ground お知らせ bell renders, and
// (2) an OS-native push toast (via osNotify.ts → electron/main.js). Reuses the
// existing notification mechanism (card d9a3e2): the records here are plain
// {@link AppNotification}s with kind 'swarm-fatal', surfaced through GET
// /api/swarm/notifications and read-tracked by the SAME /api/notifications read
// state as collab invites.
//
// WHY A SEPARATE FILE from store.ts's notifications.json: that file holds only the
// READ-STATE id set; these are notification CONTENT records (capped to the newest
// few). Persisting them means the bell still shows the event after the user
// returns — the whole point of an escalation that fires while nobody is watching.

import { readFile } from 'fs/promises'
import { ensureOpenGroundHome, swarmNotificationsFile } from './paths'
import { atomicWriteJson } from './atomicWrite'
import { sendOsNotification, CREATE_NOTIFICATION_MESSAGE, type OsNotification } from './osNotify'
import type {
  AppNotification,
  SwarmFatalNotification,
  SwarmFatalEvent,
  SwarmInfoNotification,
  SwarmInfoEvent,
} from '../types'

/** Keep only the newest few — these are urgent one-offs, not a log. A small cap
 *  bounds the file and the bell list; older events scroll off (the engine log
 *  keeps the full history).
 *
 *  PER KIND, not overall (see {@link capNotificationsByKind}): fatal records and
 *  info records share this file but must not compete for the same slots. */
export const SWARM_NOTIFICATIONS_CAP = 50

interface SwarmNotificationsState {
  items: AppNotification[]
}
const DEFAULT_STATE: SwarmNotificationsState = { items: [] }

const readState = async (): Promise<SwarmNotificationsState> => {
  await ensureOpenGroundHome()
  try {
    const raw = await readFile(swarmNotificationsFile(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<SwarmNotificationsState>
    // Guard a hand-corrupted file: a non-array items would otherwise crash the bell.
    return { items: Array.isArray(parsed.items) ? parsed.items : [] }
  } catch {
    return { ...DEFAULT_STATE }
  }
}

/** Read the persisted fatal notifications, NEWEST-FIRST (the order the bell shows). */
export const listSwarmNotifications = async (): Promise<AppNotification[]> => {
  const state = await readState()
  return [...state.items].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
}

// Serialised through a single-flight chain (mirrors store.ts's notificationsChain):
// every append re-reads inside the lock so two concurrent fatal events can't lose
// each other. Keeps advancing even if one write throws.
let chain: Promise<unknown> = Promise.resolve()

/**
 * Keep the newest {@link SWARM_NOTIFICATIONS_CAP} **of each kind**, newest-first
 * overall. Pure.
 *
 * WHY PER KIND. Every record used to share one 50-slot list, so a steady trickle
 * of routine info notices evicted rare fatal ones purely by being more recent.
 * That is exactly backwards: the fatal lane is the unmanned swarm's safety valve
 * (rework-exhausted / all-workers-down / canary-failed / data-integrity), and the
 * daily fuel report posts one info record EVERY day by design — including on
 * quiet days, which is the point of it. Left shared, a single fatal event would
 * be pushed off the bell after ~50 quiet days with nothing else happening, and
 * sooner once escalations and overseer notices mix in. Partitioning is the fix
 * that keeps both lanes bounded; the alternatives were worse:
 *   • dropping the healthy-day report — that IS the feature (a report that
 *     arrives daily is how the owner distinguishes "nothing finished" from "the
 *     loop died"), and it would only postpone the collision, not remove it;
 *   • exempting fatal from eviction — unbounded growth, and the file is read
 *     whole on every append.
 * An unknown/absent kind is partitioned under its own bucket, so a future kind
 * inherits the same isolation without touching this function.
 */
export const capNotificationsByKind = (items: readonly AppNotification[]): AppNotification[] => {
  const sorted = [...items].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  const perKind = new Map<string, number>()
  const kept: AppNotification[] = []
  for (const it of sorted) {
    const bucket = it.kind ?? 'unknown'
    const n = perKind.get(bucket) ?? 0
    if (n >= SWARM_NOTIFICATIONS_CAP) continue
    perKind.set(bucket, n + 1)
    kept.push(it)
  }
  return kept
}

/** Append one notification, keeping the newest {@link SWARM_NOTIFICATIONS_CAP}
 *  PER KIND (so info traffic can never evict a fatal record — see
 *  {@link capNotificationsByKind}). */
export const appendSwarmNotification = async (app: AppNotification): Promise<void> => {
  const run = chain.then(async () => {
    const state = await readState()
    const capped = capNotificationsByKind([...state.items, app])
    await atomicWriteJson(swarmNotificationsFile(), { items: capped } satisfies SwarmNotificationsState)
  })
  chain = run.catch(() => {})
  return run
}

/** A short, operator-facing English label per event (the OS toast title; matches
 *  the style of electron's existing notifyRollback). The Japanese specifics ride
 *  in `detail`, which the engine log already phrases. */
const EVENT_LABEL: Record<SwarmFatalEvent, string> = {
  'rework-exhausted': 'Swarm — card parked (rework limit)',
  'all-workers-down': 'Swarm — all workers stopped',
  'exec-timeout': 'Swarm — worker hit time limit',
  'guard-unwired': 'Swarm — worker spawn refused (guard unwired)',
  rollback: 'Self-update rolled back',
  'canary-failed': 'Self-update canary failed',
  'review-panel-failed': 'Swarm — review panel failed (merge withheld)',
  'high-risk-hold': 'Swarm — high-risk paths (awaiting manual merge)',
  'manager-unrevivable': 'Swarm — commander keeps dying (check it manually)',
  // Fires from TWO distinct causes (swarmOrchestrator.ts resumeEngines): the
  // crash-loop breaker tripping (repeated restarts) OR the breaker's own boot
  // ring failing to persist (a disk fault — e.g. a first-ever launch before a
  // must-fix 2026-07-22 rework fixed the missing ensureOpenGroundHome() call).
  // The title stays cause-agnostic on purpose; `detail` (built per-call at the
  // fire site) is what actually says which one happened.
  'engine-resume-suppressed': 'Swarm — auto-resume paused',
  // Plain Japanese on purpose: unlike every other entry here (read by the
  // operator), this one is read by the OWNER, who is not a programmer, and it is
  // about their own data going missing. See homeIntegrity.ts.
  'data-integrity': 'データが減っているようです',
}

/** The OS toast (title + body) for a fatal event. Body carries WHAT happened, the
 *  card/branch, and the engine-log 導線 — the three things the escalation must
 *  contain — so the toast alone is actionable even before the bell is opened. */
export const formatFatalNotification = (n: SwarmFatalNotification): OsNotification => {
  const ref = n.taskTitle ? `「${n.taskTitle}」` : ''
  const branch = n.branch ? ` (${n.branch})` : ''
  const hint = n.logHint ? `\n${n.logHint}` : ''
  return {
    title: `OPEN GROUND — ${EVENT_LABEL[n.event] ?? 'Swarm alert'}`,
    body: `${n.detail}${ref}${branch}${hint}`,
  }
}

/** A stable-per-occurrence read-state id: kind:event:ref:createdAt. `ref` is the
 *  card/branch/project so it reads sensibly; createdAt makes each occurrence
 *  independently markable (re-firing the same ongoing state is deduped UPSTREAM by
 *  the engine, so this never spams). */
const fatalNotificationId = (n: SwarmFatalNotification, createdAt: number): string => {
  const ref = n.taskId || n.branch || n.projectPath || 'global'
  return `swarm-fatal:${n.event}:${ref}:${createdAt}`
}

/** Build the {@link AppNotification} record for a fatal event. */
export const buildFatalAppNotification = (
  n: SwarmFatalNotification,
  createdAt: number,
): AppNotification => ({
  id: fatalNotificationId(n, createdAt),
  kind: 'swarm-fatal',
  createdAt,
  swarmFatal: n,
})

/**
 * Fire one FATAL swarm notification: persist the in-app record (so the bell shows
 * it) AND raise an OS toast (so a human watching nothing gets woken). The single
 * entry point both the swarm engine (notify dep) and the Electron self-update
 * bridge use.
 *
 * @param opts.os  false ⇒ create the in-app record ONLY (the caller — Electron —
 *   already showed the OS toast itself, so this avoids a double toast). Default true.
 * @param opts.now injectable clock for deterministic tests (default Date.now()).
 */
export const createSwarmFatalNotification = async (
  n: SwarmFatalNotification,
  opts?: { os?: boolean; now?: number },
): Promise<AppNotification> => {
  const createdAt = opts?.now ?? Date.now()
  const app = buildFatalAppNotification(n, createdAt)
  await appendSwarmNotification(app)
  if (opts?.os !== false) sendOsNotification(formatFatalNotification(n))
  return app
}

// ─── INFO-grade notifications (the overseer/escalation lane, C1) ─────────────
// Same persisted-bell + OS-toast plumbing as the fatal path above, calmer tone:
// nothing broke, someone just needs to look. First consumer: the Escalations
// inbox ('escalation-open'); the other events are reserved for the overseer
// brainstem (S7/S9/S11 of docs/OVERSEER_DESIGN.md §6).

const INFO_EVENT_LABEL: Record<SwarmInfoEvent, string> = {
  'escalation-open': 'Swarm — a question needs your answer',
  'escalation-reminder': 'Swarm — a question is still waiting',
  'review-idle': 'Swarm — review cards await integration',
  'overseer-throttled': 'Swarm — overseer throttled (usage cap)',
  'manager-woke': 'Swarm — commander woken to decide an integration',
  'self-update-requested': 'Swarm — engine self-update cycle requested',
  'daily-fuel-report': 'Swarm — daily fuel report',
  // Not a swarm event at all — the OWNER'S OWN conversation stopped. Titled for
  // what the owner sees on the toast, not for the subsystem that noticed.
  'session-limit': 'Claude — your conversation stopped (usage limit)',
  'engine-resumed': 'Swarm — auto-resumed after restart',
  // Also not a swarm event: the MACHINE is accumulating un-killable processes
  // (stuckProcessWatch.ts). Titled for what the owner sees, not the subsystem.
  'stuck-processes': 'Machine — stuck processes are piling up (restart clears them)',
}

/** The OS toast (title + body) for an info event — same shape as the fatal one. */
export const formatInfoNotification = (n: SwarmInfoNotification): OsNotification => {
  const ref = n.taskTitle ? `「${n.taskTitle}」` : ''
  const branch = n.branch ? ` (${n.branch})` : ''
  return {
    title: `OPEN GROUND — ${INFO_EVENT_LABEL[n.event] ?? 'Swarm info'}`,
    body: `${n.detail}${ref}${branch}`,
  }
}

/** Stable-per-occurrence read-state id (mirrors fatalNotificationId): dedup of a
 *  RE-FIRING ongoing state is the CALLER's responsibility (the escalation inbox
 *  dedups via receiptKey; the overseer dedups via its seen map). */
const infoNotificationId = (n: SwarmInfoNotification, createdAt: number): string => {
  const ref = n.escalationId || n.taskId || n.branch || n.projectPath || 'global'
  return `swarm-info:${n.event}:${ref}:${createdAt}`
}

/** Build the {@link AppNotification} record for an info event. */
export const buildInfoAppNotification = (
  n: SwarmInfoNotification,
  createdAt: number,
): AppNotification => ({
  id: infoNotificationId(n, createdAt),
  kind: 'swarm-info',
  createdAt,
  swarmInfo: n,
})

/**
 * Fire one INFO swarm notification: persist the in-app record (bell) AND raise
 * an OS toast. The info-grade sibling of {@link createSwarmFatalNotification} —
 * same cap, same read-state plumbing.
 */
export const createSwarmInfoNotification = async (
  n: SwarmInfoNotification,
  opts?: { os?: boolean; now?: number },
): Promise<AppNotification> => {
  const createdAt = opts?.now ?? Date.now()
  const app = buildInfoAppNotification(n, createdAt)
  await appendSwarmNotification(app)
  if (opts?.os !== false) sendOsNotification(formatInfoNotification(n))
  return app
}

/**
 * Register the INWARD IPC bridge: when electron/main.js observes a self-update
 * rollback / canary failure (events only Electron sees), it `child.send`s a
 * {@link CREATE_NOTIFICATION_MESSAGE} so the server creates the matching in-app
 * record. Electron shows the OS toast itself, so this creates the record only
 * (os:false). Fail-safe: only registered when we're the forked engine with an IPC
 * channel (process.send present) — in dev/tsx/vitest/bare node it's a no-op.
 * Idempotent guard so a double-call (HMR) can't stack listeners.
 */
let incomingRegistered = false
export const registerIncomingNotifications = (): void => {
  if (incomingRegistered) return
  if (typeof process.send !== 'function') return // no IPC channel → nothing sends to us
  incomingRegistered = true
  process.on('message', (msg: unknown) => {
    if (!msg || typeof msg !== 'object') return
    const m = msg as { type?: unknown; notification?: unknown }
    if (m.type !== CREATE_NOTIFICATION_MESSAGE) return
    const n = m.notification as Partial<SwarmFatalNotification> | undefined
    if (!n || typeof n !== 'object' || typeof n.event !== 'string' || typeof n.detail !== 'string') {
      return
    }
    void createSwarmFatalNotification(n as SwarmFatalNotification, { os: false }).catch(() => {})
  })
}

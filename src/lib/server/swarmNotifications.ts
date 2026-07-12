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
 *  bounds the file and the bell list; older fatal events scroll off (the engine
 *  log keeps the full history). */
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

/** Append one notification, capped to the newest {@link SWARM_NOTIFICATIONS_CAP}. */
export const appendSwarmNotification = async (app: AppNotification): Promise<void> => {
  const run = chain.then(async () => {
    const state = await readState()
    const items = [...state.items, app]
    // Cap by recency — keep the newest N (sort desc, slice, the file stays bounded).
    items.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    const capped = items.slice(0, SWARM_NOTIFICATIONS_CAP)
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

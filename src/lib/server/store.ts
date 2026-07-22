import { readFile } from 'fs/promises'
import { ensureOpenGroundHome, settingsFile, canvasFile, notificationsFile } from './paths'
import { atomicWriteJson } from './atomicWrite'
import { snapshotBeforeWrite } from './homeBackup'
import { asExecutionMode } from './swarmLaunch'
import {
  anyTierAllowed,
  normalizeAllowedModels,
  setAllowedModelTiersCache,
} from './swarmAllowedModels'
import { setLockdownCache } from './lockdown'
import type { Settings, CanvasState, ExecutionMode, SwarmAllowedModels, SwarmPaneId } from '../types'
import { SWARM_PANE_IDS } from '../types'

const DEFAULT_SETTINGS: Settings = {
  projects: [],
  defaultWorkspace: null,
  // projectsMigratedAt intentionally absent — its absence is what triggers the
  // one-shot legacy migration (see ensureProjectsMigrated). A fresh install
  // (projectsRoot=null) still runs migration once, which simply stamps the
  // sentinel and leaves `projects` empty.
  projectsRoot: null,
  archiveDirName: '_archive',
  excludePatterns: ['node_modules', '.next', 'dist', 'build', '.cache', '_archive'],
  openApps: [],
  defaultEditor: null,
}

const DEFAULT_CANVAS: CanvasState = {
  positions: {},
  viewport: { x: 0, y: 0, zoom: 1 },
  elements: [],
}

const readJson = async <T>(path: string, fallback: T): Promise<T> => {
  // Ensure the legacy ~/.pmmap home is migrated before we resolve the path —
  // otherwise the very first read would silently return defaults from a
  // not-yet-renamed directory.
  await ensureOpenGroundHome()
  try {
    const raw = await readFile(path, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    // Only spread a PLAIN object. A hand-corrupted config that parses to a
    // non-object (a bare string/number/array/null) would otherwise pollute the
    // result with char/numeric keys — e.g. `{...fallback, ...'oops'}` becomes
    // `{0:'o',1:'o',2:'p',3:'s', ...fallback}` (proven), and an array spread
    // injects numeric keys. Every config file (settings/canvas/notifications)
    // is an object, so this never rejects VALID data — it only refuses garbage,
    // returning the typed fallback instead of a polluted shape downstream code
    // (scan.ts reading settings.projects, etc.) would choke on.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return fallback
    }
    return { ...fallback, ...(parsed as Record<string, unknown>) }
  } catch {
    return fallback
  }
}

const writeJson = async (path: string, data: unknown) => {
  await ensureOpenGroundHome()
  // GENERATIONAL BACKUP (2026-07-18 incident): copy the CURRENT content aside
  // before it is replaced, so the previous generation of settings.json /
  // canvas.json always survives an overwrite. A no-op for every other path, and
  // content-deduped, so the high-frequency canvas save doesn't pile up copies.
  //
  // Awaited DELIBERATELY: it must complete before the overwrite, or it is
  // backing up content that is already gone. snapshotBeforeWrite never throws
  // (its own invariant) — a failed backup logs and the save proceeds — so this
  // cannot turn a backup problem into a save problem.
  await snapshotBeforeWrite(path)
  await atomicWriteJson(path, data)
}

export const getSettings = async (): Promise<Settings> => {
  const s = await readJson<Settings>(settingsFile(), DEFAULT_SETTINGS)
  // Coerce array-typed fields back to arrays. readJson already rejects a
  // non-OBJECT top level, but a hand-corrupted settings.json with a per-field
  // type error (e.g. {"projects":"oops"}) would still slip through and CRASH an
  // iterator at boot — scan.ts does `(settings.projects ?? []).filter(...)`, and
  // `?? []` does NOT save a non-null non-array (a string has no .filter). Drop a
  // malformed field to its default rather than wedge the whole cockpit. Valid
  // settings are unaffected.
  //
  // Mirror the swarm's model hard mask into its globalThis cache on EVERY read:
  // the launch-tier resolver (swarmLaunch.resolveAvailableTier) is synchronous
  // and is reached from spawn paths that cannot all await a settings read, so it
  // needs a last-known value. Writes go through setSettings, which re-reads here
  // inside the single-flight chain — so a toggle is mirrored the moment it lands.
  // The cache is derived, never authoritative (settings.json is).
  setAllowedModelTiersCache(s.swarmAllowedModels)
  // Mirror the lockdown switch the same way: the fetch floor (lockdown.ts) is
  // a synchronous wrapper around global fetch and cannot await a disk read per
  // request.
  setLockdownCache(s.lockdownMode)
  return {
    ...s,
    projects: Array.isArray(s.projects)
      ? s.projects.filter((e): e is (typeof s.projects)[number] => e != null && typeof e === 'object' && !Array.isArray(e))
      : [],
    openApps: Array.isArray(s.openApps) ? s.openApps : [],
    excludePatterns: Array.isArray(s.excludePatterns)
      ? s.excludePatterns
      : DEFAULT_SETTINGS.excludePatterns,
  }
}
// Merge so a partial save from one UI (e.g. the Settings panel) does not
// clobber fields owned by another (e.g. the project panel's openApps).
//
// Serialised through a single-flight chain: setSettings is a read-modify-write
// (read current → merge patch → write). Two concurrent calls — e.g. a registry
// mutation patching `projects` and a settings-panel save patching
// `defaultWorkspace` — would each read the same `current` and the second write
// would clobber the first caller's keys (a lost update). The chain makes every
// call re-read inside the lock, so patches to different keys all survive.
// (registry.ts has its own withRegistryLock for its read-compute-write; this
// closes the residual cross-caller race that lock can't see. Mirrors the
// module-level chain pattern registry.ts already uses.)
let settingsChain: Promise<unknown> = Promise.resolve()
export const setSettings = async (patch: Partial<Settings>): Promise<void> => {
  const run = settingsChain.then(async () => {
    const current = await getSettings()
    const merged = { ...current, ...patch }
    await writeJson(settingsFile(), merged)
    // Re-mirror the model mask from the value we just PERSISTED (getSettings above
    // mirrored the pre-patch one). Without this a freshly-toggled tier would stay
    // spawnable for every sync reader until the next settings read.
    setAllowedModelTiersCache(merged.swarmAllowedModels)
    // Same for lockdown: the fetch floor must see the toggle the moment it lands.
    setLockdownCache(merged.lockdownMode)
  })
  // Keep the chain advancing even if one write throws, so a single failure
  // can't wedge every subsequent settings save.
  settingsChain = run.catch(() => {})
  return run
}

// The Settings keys an UNTRUSTED HTTP body (POST /api/settings) is allowed to
// write. This is an EXPLICIT ALLOWLIST: the body is narrowed to these keys
// before the merge, so a forged / CSRF request can NEVER reach the security-
// boundary or migration-owned fields through that route. Crucially `projects` —
// the validateProjectPath allowlist — is absent, so it cannot be widened to an
// arbitrary path (/etc, $HOME, …) by simply POSTing it; `projects` is mutated
// ONLY by trusted server code (registry.ts, ensureProjectsMigrated, and the
// /api/projects/{new,import,remove,relocate} routes).
//
// Deliberately NOT listed (blocked from this route):
//   projects            — THE security boundary (validateProjectPath allowlist)
//   projectsRoot        — deprecated legacy-migration input (a path)
//   projectsMigratedAt  — one-shot legacy-migration sentinel (server-owned)
//   shareEvacuatedAt    — one-shot share-evacuation sentinel (server-owned)
//   swarmAutonomyOn     — server-owned (startOrchestrator/stopOrchestrator only);
//                         a forged body must never mark a project "autonomy on"
//   swarmManualStop     — server-owned (stopOrchestrator/startOrchestrator only);
//                         a forged body must never fake or erase the owner's
//                         "stopped by hand" record
//   swarmLocalOwner     — the login-free swarm unlock (swarmGate.ts). It must
//                         come ONLY from server-local state (a hand-edited
//                         settings.json / env), NEVER from a request — listing
//                         it here would let any local HTTP caller unlock the
//                         gate it is supposed to sit behind
//   archiveDirName      — deprecated migration input
//   excludePatterns     — deprecated migration input
//
// `defaultWorkspace` IS allowed: the Settings panel autosaves it (it is the
// "where Create-new folders go" field, edited alongside displayName) and it is
// NOT a validateProjectPath boundary — it never lands on the allowlist (only
// `projects` does). Cross-origin forgery of this route is independently blocked
// by the CSRF / Origin guard in server/app.ts. When you add a new USER-PREFERENCE
// Settings field, add its key here too or POST /api/settings will silently drop it.
const USER_SETTINGS_KEYS: readonly (keyof Settings)[] = [
  'language',
  'displayName',
  'defaultWorkspace',
  'openApps',
  'defaultEditor',
  'experiments',
  'executionMode',
  'swarmAllowedModels',
  'swarmPaneOrder',
  'lockdownMode',
]

/** Narrow an untrusted `swarmPaneOrder` body to the known pane ids, in the
 *  caller's order, DEDUPED. A forged POST /api/settings therefore can't persist
 *  arbitrary strings into the settings file; the client's `effectiveTabOrder`
 *  reconciles anything else on read anyway. Returns `undefined` when nothing
 *  valid survives (all-garbage) so the previous order is kept rather than wiped
 *  — the same "refuse a meaningless patch" stance as the swarmAllowedModels
 *  all-off guard. */
const normalizeSwarmPaneOrder = (v: unknown): SwarmPaneId[] | undefined => {
  if (!Array.isArray(v)) return undefined
  const known = new Set<string>(SWARM_PANE_IDS)
  const seen = new Set<string>()
  const out: SwarmPaneId[] = []
  for (const id of v) {
    if (typeof id === 'string' && known.has(id) && !seen.has(id)) {
      seen.add(id)
      out.push(id as SwarmPaneId)
    }
  }
  return out.length > 0 ? out : undefined
}

// Persist a settings patch that ORIGINATES FROM AN UNTRUSTED HTTP CLIENT
// (POST /api/settings). Unlike setSettings — a general internal merge that
// trusted callers (registry.ts, the migration, project create) use to write ANY
// field — this first narrows the body to USER_SETTINGS_KEYS, so the route can
// never widen the validateProjectPath allowlist or rewrite migration sentinels.
// A non-object body (string / array / null) writes nothing. Returns the keys
// actually applied (for tests / observability).
export const setUserSettings = async (body: unknown): Promise<(keyof Settings)[]> => {
  const safe: Partial<Settings> = {}
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    const src = body as Record<string, unknown>
    for (const key of USER_SETTINGS_KEYS) {
      if (Object.prototype.hasOwnProperty.call(src, key)) {
        ;(safe as Record<string, unknown>)[key] = src[key]
      }
    }
  }
  // The model hard mask is stored NORMALIZED (a full four-tier map) so every
  // reader sees the same shape, and an ALL-OFF patch is REFUSED: a swarm with no
  // enabled tier can only park, and a UI bug / bad script must not be able to
  // brick every launch path through this route. The key is then simply not
  // applied — the previous mask survives, and the caller sees it missing from
  // the returned key list. (The UI blocks the last toggle for the same reason.)
  if (Object.prototype.hasOwnProperty.call(safe, 'swarmAllowedModels')) {
    const mask = normalizeAllowedModels(safe.swarmAllowedModels)
    if (anyTierAllowed(mask)) safe.swarmAllowedModels = mask
    else delete safe.swarmAllowedModels
  }
  // The swarm sub-tab order is stored NARROWED to the known pane ids (deduped,
  // in the caller's order). An array that filters down to nothing (all-garbage)
  // is refused — the previous order survives — mirroring the swarmAllowedModels
  // all-off guard above; the caller then sees the key missing from the returned list.
  if (Object.prototype.hasOwnProperty.call(safe, 'swarmPaneOrder')) {
    const clean = normalizeSwarmPaneOrder(safe.swarmPaneOrder)
    if (clean) safe.swarmPaneOrder = clean
    else delete safe.swarmPaneOrder
  }
  // Store the lockdown switch as a REAL boolean: only a literal `true` turns it
  // on (a forged truthy string must not), everything else persists `false`.
  if (Object.prototype.hasOwnProperty.call(safe, 'lockdownMode')) {
    safe.lockdownMode = safe.lockdownMode === true
  }
  await setSettings(safe)
  return Object.keys(safe) as (keyof Settings)[]
}

// ─── Swarm model hard mask (Settings.swarmAllowedModels) ─────────────────────
// The persisted "使用可能モデル" switches every claude spawn path consults before
// picking a tier. Read it here (never straight from getSettings) so the read also
// refreshes the globalThis mirror the synchronous resolver falls back on, and so a
// hand-corrupted field degrades to "everything usable" in exactly one place.
export const getAllowedModelTiers = async (): Promise<SwarmAllowedModels> =>
  normalizeAllowedModels((await getSettings()).swarmAllowedModels)

// ─── Swarm autonomy "remembered ON" set (Settings.swarmAutonomyOn) ────────────
// The ONLY autonomy state that survives a restart — a REMINDER, never an
// auto-resume (the engine is in-memory and always relaunches OFF). Added when the
// owner turns Autonomy ON for a project, removed on an explicit OFF (resume or
// dismiss). Read-modify-write is routed through the SAME single-flight
// `settingsChain` as setSettings / markNotificationsRead: each call re-reads
// inside the lock, so toggling two projects at once can't lose a key. Keys are
// canonicalized project paths (the swarm engine's own key), passed in by the
// caller. Every read guards `Array.isArray` — a hand-corrupted non-array field
// degrades to "nothing remembered" (the SAFE direction: at worst a missing
// reminder, never a spurious run).
export const rememberSwarmAutonomy = async (key: string): Promise<void> => {
  if (!key) return
  const run = settingsChain.then(async () => {
    const current = await getSettings()
    const existing = Array.isArray(current.swarmAutonomyOn) ? current.swarmAutonomyOn : []
    if (existing.includes(key)) return
    await writeJson(settingsFile(), { ...current, swarmAutonomyOn: [...existing, key] })
  })
  settingsChain = run.catch(() => {})
  return run
}

export const forgetSwarmAutonomy = async (key: string): Promise<void> => {
  if (!key) return
  const run = settingsChain.then(async () => {
    const current = await getSettings()
    const existing = Array.isArray(current.swarmAutonomyOn) ? current.swarmAutonomyOn : []
    if (!existing.includes(key)) return
    await writeJson(settingsFile(), {
      ...current,
      swarmAutonomyOn: existing.filter((k) => k !== key),
    })
  })
  settingsChain = run.catch(() => {})
  return run
}

export const isSwarmAutonomyRemembered = async (key: string): Promise<boolean> => {
  if (!key) return false
  const { swarmAutonomyOn } = await getSettings()
  return Array.isArray(swarmAutonomyOn) && swarmAutonomyOn.includes(key)
}

// ─── Swarm "stopped by hand" set (Settings.swarmManualStop) ───────────────────
// The persisted half of the engine's in-memory `manualStop` flag: the fact "the
// owner explicitly paused this project's engine" must survive a restart so it
// stays OBSERVABLE from outside (a commander / another session asking "is this
// engine deliberately stopped?" — the 0707 twin-dispatch root cause was exactly
// this being invisible), and so the opt-in auto-drain sweep keeps respecting the
// pause after the in-memory flag dies with the process. A RECORD, never an
// auto-resume: its only engine-side effect is MORE stopping (auto-start
// suppression); nothing ever runs because of it. Added on an explicit Autonomy
// OFF (stopOrchestrator), removed on an explicit ON (startOrchestrator). Same
// single-flight `settingsChain` + Array.isArray discipline as swarmAutonomyOn
// above; a hand-corrupted field degrades to "no record" — at worst the sweep
// treats the project as never-paused, which the strict-opt-in AUTODRAIN gate
// already bounds.
export const rememberSwarmManualStop = async (key: string): Promise<void> => {
  if (!key) return
  const run = settingsChain.then(async () => {
    const current = await getSettings()
    const existing = Array.isArray(current.swarmManualStop) ? current.swarmManualStop : []
    if (existing.includes(key)) return
    await writeJson(settingsFile(), { ...current, swarmManualStop: [...existing, key] })
  })
  settingsChain = run.catch(() => {})
  return run
}

export const forgetSwarmManualStop = async (key: string): Promise<void> => {
  if (!key) return
  const run = settingsChain.then(async () => {
    const current = await getSettings()
    const existing = Array.isArray(current.swarmManualStop) ? current.swarmManualStop : []
    if (!existing.includes(key)) return
    await writeJson(settingsFile(), {
      ...current,
      swarmManualStop: existing.filter((k) => k !== key),
    })
  })
  settingsChain = run.catch(() => {})
  return run
}

export const isSwarmManualStopPersisted = async (key: string): Promise<boolean> => {
  if (!key) return false
  const { swarmManualStop } = await getSettings()
  return Array.isArray(swarmManualStop) && swarmManualStop.includes(key)
}

// ─── Swarm execution mode (token budget) ─────────────────────────────────────
// The persisted mode every in-app swarm launch reads to pick model/effort/parallelism.
// A hand-corrupted / absent value degrades to the smart default via asExecutionMode.
export const getExecutionMode = async (): Promise<ExecutionMode> =>
  asExecutionMode((await getSettings()).executionMode)

// ─── Work mode / lockdown (Settings.lockdownMode) ─────────────────────────────
// The authoritative reader every egress feature gate consults (see lockdown.ts
// for the two-layer model). Absent / hand-corrupted ⇒ off — the shipped default.
// Lives here (not lockdown.ts) so the settings module stays the only one that
// imports lockdown's cache setter, never the reverse (no import cycle).
export const isLockdownEnabled = async (): Promise<boolean> =>
  (await getSettings()).lockdownMode === true

export const getCanvas = () => readJson<CanvasState>(canvasFile(), DEFAULT_CANVAS)
export const setCanvas = (c: CanvasState) => writeJson(canvasFile(), c)

// ─── In-app notification read-state (Ground お知らせ bell) ─────────────────────
// A tiny home-cache file (~/.openground/notifications.json) holding the ids the
// user has already seen, so the bell's unread state survives a re-login — NOT
// localStorage (which a re-login / new machine would lose). Kept in its OWN file
// (not settings.json): a "seen" set is app STATE, not a user preference, and it
// can grow independently. The notification CONTENT lives elsewhere (per-kind
// sources, today GET /api/collab/invites); this only records read/unread.
interface NotificationState {
  /** Stable ids the user has marked read (e.g. `collab-invite:<collabProjectId>`). */
  readIds: string[]
}
const DEFAULT_NOTIFICATIONS: NotificationState = { readIds: [] }

export const getNotificationState = () =>
  readJson<NotificationState>(notificationsFile(), DEFAULT_NOTIFICATIONS)

// Mark ids READ. Marking read is MONOTONIC — ids are only ever ADDED (you never
// un-read) — so we UNION into the stored set rather than replace. The single-
// flight chain (like setSettings) makes every call re-read inside the lock, so
// two concurrent marks can't lose each other's ids. Returns the merged id list.
let notificationsChain: Promise<unknown> = Promise.resolve()
export const markNotificationsRead = async (ids: string[]): Promise<string[]> => {
  const clean = Array.from(
    new Set((ids ?? []).filter((s): s is string => typeof s === 'string' && s.length > 0)),
  )
  if (clean.length === 0) return (await getNotificationState()).readIds
  const run = notificationsChain.then(async () => {
    const current = await getNotificationState()
    // Guard against a hand-corrupted notifications.json (readJson merges blindly):
    // a non-array readIds would otherwise spread char-by-char / throw.
    const existing = Array.isArray(current.readIds) ? current.readIds : []
    const merged = Array.from(new Set([...existing, ...clean]))
    await writeJson(notificationsFile(), { readIds: merged } satisfies NotificationState)
    return merged
  })
  // Keep the chain advancing even if one write throws (mirrors settingsChain).
  notificationsChain = run.catch(() => {})
  return run
}

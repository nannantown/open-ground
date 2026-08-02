import { lstat, readFile } from 'fs/promises'
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

/** WHY the last read returned what it returned.
 *
 *  `absent` — nothing has been written yet (ENOENT). A fresh install.
 *  `unreadable` — something IS there and we could not use it: no permission, a
 *    directory in its place, an I/O error, truncated/hand-mangled JSON, or JSON
 *    that parses to something other than an object.
 *  `ok` — parsed into a real object.
 *
 *  The distinction exists because "absent" and "unreadable" both produce the
 *  SAME fallback value, and a reader deciding a SAFETY question has to tell them
 *  apart: nothing-written-yet is consent to a default, a broken file is not. */
type ConfigReadHealth = 'ok' | 'absent' | 'unreadable'

const readJsonWithHealth = async <T>(
  path: string,
  fallback: T,
): Promise<{ value: T; health: ConfigReadHealth }> => {
  // Ensure the legacy ~/.pmmap home is migrated before we resolve the path —
  // otherwise the very first read would silently return defaults from a
  // not-yet-renamed directory.
  await ensureOpenGroundHome()
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err: unknown) {
    // ENOENT is the ONLY read failure that CAN mean "nothing written yet".
    // EACCES, EISDIR, EIO and friends all mean the opposite — a file exists and
    // we cannot see its contents — which is the case a safety dial must not read
    // as a fresh install.
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      return { value: fallback, health: 'unreadable' }
    }
    // ...but a DANGLING SYMLINK reports ENOENT too, and it is emphatically not a
    // fresh install: someone pointed this path at a file on purpose (dotfiles
    // setups symlink settings.json into a synced folder) and the target is
    // missing right now — an unmounted volume, a repo not yet cloned. Reading
    // that as "absent" would flip the kill switch to SDK for exactly as long as
    // the target is away, and WRITING to it would replace the owner's symlink
    // with a plain file (atomicWriteJson renames over it), silently detaching
    // them from their own dotfiles. `lstat` sees the LINK rather than following
    // it, so it succeeds precisely when the path is occupied by something.
    try {
      await lstat(path)
      return { value: fallback, health: 'unreadable' }
    } catch (linkErr: unknown) {
      // SAME POLARITY AS THE READ ABOVE, and for the same reason: `absent` is
      // the fail-OPEN answer (it lets the dial say sdk and lets a write
      // proceed), so it must be reached only by the ONE error that actually
      // means "nothing occupies this path". An EACCES on the parent directory,
      // or an EIO, means we could not answer the question at all — and an
      // unanswered question is not permission. Catching everything here would
      // have left the fail-open door propped by any lstat failure whatsoever,
      // which is the exact asymmetry this card exists to remove.
      return {
        value: fallback,
        health: (linkErr as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'absent' : 'unreadable',
      }
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { value: fallback, health: 'unreadable' }
  }
  // Only spread a PLAIN object. A hand-corrupted config that parses to a
  // non-object (a bare string/number/array/null) would otherwise pollute the
  // result with char/numeric keys — e.g. `{...fallback, ...'oops'}` becomes
  // `{0:'o',1:'o',2:'p',3:'s', ...fallback}` (proven), and an array spread
  // injects numeric keys. Every config file (settings/canvas/notifications)
  // is an object, so this never rejects VALID data — it only refuses garbage,
  // returning the typed fallback instead of a polluted shape downstream code
  // (scan.ts reading settings.projects, etc.) would choke on. Garbage of this
  // shape is `unreadable`, not `absent`: the file was written, just not with
  // anything we can use.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { value: fallback, health: 'unreadable' }
  }
  return { value: { ...fallback, ...(parsed as Record<string, unknown>) }, health: 'ok' }
}

/** The tolerant read every non-safety caller wants: failures of any kind become
 *  the fallback. Deliberately kept — canvas positions and notification marks
 *  SHOULD degrade quietly rather than wedge the cockpit. Only callers deciding
 *  whether to enable something reach for `readJsonWithHealth` instead. */
const readJson = async <T>(path: string, fallback: T): Promise<T> =>
  (await readJsonWithHealth(path, fallback)).value

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

/** `getSettings` plus WHY the values are what they are — see ConfigReadHealth.
 *
 *  Private on purpose, and the two kinds of asker are both inside this file:
 *  a SAFETY READ ("may I turn this on?" — the runtime dials) and every
 *  READ-MODIFY-WRITE ("is what I am about to merge into actually the truth?" —
 *  readSettingsForWrite). Exporting it would invite callers to branch on
 *  `unreadable` in the many places where degrading quietly is the right
 *  behaviour: a missing canvas position or notification mark SHOULD fall back
 *  silently rather than wedge the cockpit. */
const getSettingsWithHealth = async (): Promise<{
  settings: Settings
  health: ConfigReadHealth
}> => {
  const { value: s, health } = await readJsonWithHealth<Settings>(settingsFile(), DEFAULT_SETTINGS)
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
    settings: {
      ...s,
      projects: Array.isArray(s.projects)
        ? s.projects.filter((e): e is (typeof s.projects)[number] => e != null && typeof e === 'object' && !Array.isArray(e))
        : [],
      openApps: Array.isArray(s.openApps) ? s.openApps : [],
      excludePatterns: Array.isArray(s.excludePatterns)
        ? s.excludePatterns
        : DEFAULT_SETTINGS.excludePatterns,
    },
    health,
  }
}

export const getSettings = async (): Promise<Settings> => (await getSettingsWithHealth()).settings

/** Refusing to save beats saving the wrong thing.
 *
 *  Worded for the OWNER, who is not a programmer: this can reach the cockpit
 *  (POST /api/settings surfaces the failure) and "ENOENT on readJson" would tell
 *  them nothing about what to do. Bilingual on purpose — the language preference
 *  lives in `Settings.language`, i.e. inside the very file we just failed to
 *  read, so there is nothing to branch on. */
export class SettingsUnreadableError extends Error {
  constructor(path: string) {
    super(
      `設定ファイル(${path})が読み取れません。` +
        `上書きして登録済みプロジェクトの一覧を失わないよう、書き込みを止めています。` +
        `ファイルを直すか削除してから、もう一度お試しください。` +
        ` / Cannot read settings.json (${path}).` +
        ` Writing has been stopped so that overwriting it cannot destroy the list` +
        ` of registered projects. Repair or remove the file, then try again.`,
    )
    this.name = 'SettingsUnreadableError'
  }
}

/** The read half of EVERY settings read-modify-write in this file.
 *
 *  Each writer below reads the current settings, merges its patch and writes the
 *  whole object back — which is safe only while "read the current settings"
 *  tells the truth. It did not: the tolerant reader turned an unreadable or
 *  corrupt file into DEFAULT_SETTINGS, so the merge persisted the DEFAULTS as
 *  the new truth. Measured 2026-08-02 (isolated HOME): a settings.json holding
 *  two registered projects, chmod 000, then `setSettings({swarmManagerRuntime})`
 *  ⇒ `projects: []`, `defaultWorkspace: null`, no exception, no log.
 *
 *  `projects` is not merely a list — it is the validateProjectPath ALLOWLIST and
 *  the key to every project's central data dir, so erasing it also unhooks all
 *  per-project data. This is the 2026-07-18 incident's shape (45 projects → 3)
 *  down a different road, and the generational backup added after that incident
 *  cannot cover it: snapshotBeforeWrite copies the CURRENT content aside, and
 *  the current content is exactly what we could not read.
 *
 *  ABSENT is deliberately NOT this case: a fresh install has no settings.json
 *  and must be able to write its first one. Only `unreadable` refuses.
 *  Pinned by settingsWriteGuard.test.ts. */
const readSettingsForWrite = async (): Promise<Settings> => {
  const { settings, health } = await getSettingsWithHealth()
  if (health === 'unreadable') throw new SettingsUnreadableError(settingsFile())
  return settings
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
    const current = await readSettingsForWrite()
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
//   compactInstructionsInstalledAt
//                       — one-shot CLAUDE.md section sentinel (server-owned).
//                         A forged body must never fake it (OG would then never
//                         install on a fresh machine) nor erase it (OG would
//                         re-add a block the user deleted from their own file)

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
  'swarmWorkerRuntime',
  'swarmManagerRuntime',
  'lockdownMode',
]

/** Narrow an untrusted runtime dial to `{ mode }` (+ the worker's optional
 *  `sdkMaxWorkers`). Anything else returns undefined so the key is DROPPED and
 *  the previous value survives — the same "refuse a meaningless patch" stance as
 *  the swarmAllowedModels all-off and swarmPaneOrder all-garbage guards.
 *
 *  Only a literal 'pty' or 'sdk' is persisted; anything else (absent, null, a
 *  forged string) drops the key rather than storing a value a reader would have
 *  to guess at. What the two dial READERS then make of a MISSING key is ONE
 *  shared rule again as of 2026-08-02: absent ⇒ 'sdk' on both
 *  (getManagerRuntimeDial flipped that day, getWorkerRuntimeDial the same day —
 *  it had been left behind by the 08-01 worker flip and shipped a fleet that
 *  disagreed with its own switch). An unrecognised MODE VALUE ⇒ pty is shared
 *  too — but a CONTAINER we cannot read `mode` out of is NOT that case (a
 *  non-object, or an object with no `mode` key: `?.mode` is then undefined, so
 *  both readers resolve it to 'sdk'). This normalizer
 *  does NOT implement that half either. It REFUSES a garbage patch (returns
 *  undefined; the caller drops it from the PATCH) so the PREVIOUS dial survives rather than falling
 *  to any default — pinned by settingsRuntimeDials.test.ts. On a machine that
 *  had no dial written yet, that refusal therefore leaves the key ABSENT, which
 *  the commander's reader resolves to 'sdk'. These keys are deliberately inert with respect to
 *  the validateProjectPath allowlist — they select a runtime, they cannot widen
 *  any boundary — so admitting them to USER_SETTINGS_KEYS does not weaken the
 *  narrowing this function's caller exists to perform. */
const normalizeRuntimeDial = (
  v: unknown,
  withMaxWorkers: boolean,
): { mode: 'pty' | 'sdk'; sdkMaxWorkers?: number } | undefined => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined
  const raw = v as { mode?: unknown; sdkMaxWorkers?: unknown }
  if (raw.mode !== 'pty' && raw.mode !== 'sdk') return undefined
  const cap = raw.sdkMaxWorkers
  // `sdkMaxWorkers: 0` IS A MEANINGFUL SETTING — "keep the dial on sdk but run
  // NO SDK workers" — and the old `cap > 0` test threw it away as falsy. The key
  // then vanished from the persisted dial, the reader fell back to
  // DEFAULT_SDK_MAX_WORKERS (1), and the result was the worst kind of silence:
  // the panel showed 0, the server kept seating one SDK worker, and nothing
  // logged the disagreement. Zero is precisely the value an owner reaches for to
  // stop the experiment without losing the setting, so it is the one that must
  // survive the round trip.
  //
  // The accept predicate is deliberately IDENTICAL to the reader's
  // (swarmWorkerRuntimeDial.sdkSlotLimit): finite, >= 0, floored. When writer and
  // reader disagree, the same number means two different things depending on
  // whether it arrived by POST /api/settings or by a hand-edited settings.json —
  // and this dial is one people hand-edit. Everything else (negative, NaN,
  // Infinity, a string, absent) OMITS the key, so the reader's documented default
  // applies rather than an unbounded fleet. No upper clamp: a silly-large cap
  // only ever means "do not cap", and every worker it admits still has to clear
  // the SDK preflight.
  const capOk = typeof cap === 'number' && Number.isFinite(cap) && cap >= 0
  return {
    mode: raw.mode,
    ...(withMaxWorkers && capOk ? { sdkMaxWorkers: Math.floor(cap) } : {}),
  }
}

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
  // The two Agent-SDK runtime dials, narrowed to `{ mode }` — see
  // normalizeRuntimeDial. A garbage patch is refused rather than persisted, so a
  // UI bug can never leave an unreadable shape where a runtime decision is made.
  if (Object.prototype.hasOwnProperty.call(safe, 'swarmWorkerRuntime')) {
    const clean = normalizeRuntimeDial(safe.swarmWorkerRuntime, true)
    if (clean) safe.swarmWorkerRuntime = clean
    else delete safe.swarmWorkerRuntime
  }
  if (Object.prototype.hasOwnProperty.call(safe, 'swarmManagerRuntime')) {
    const clean = normalizeRuntimeDial(safe.swarmManagerRuntime, false)
    if (clean) safe.swarmManagerRuntime = { mode: clean.mode }
    else delete safe.swarmManagerRuntime
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

// ─── Swarm worker runtime dial (Settings.swarmWorkerRuntime) ─────────────────
// The kill switch for the Agent SDK worker migration. Read through here rather
// than straight from getSettings so the resolution lives in ONE place: an
// unreadable file or a hand-corrupted value degrades to PTY, never to an
// experimental runtime.
//
// ⚠ THIS READER IS WHERE THE 2026-08-01 DEFAULT FLIP ACTUALLY LANDS, and for a
// day it was the one place the flip did NOT reach. `chooseWorkerRuntime` resolved
// an ABSENT dial to 'sdk' and the Swarm panel drew the switch ON — but the only
// production caller (swarmWorker.ts) feeds that decision THIS function's output,
// and this function turned absent into an explicit {mode:'pty'}. So the flip
// could never arrive: measured 2026-08-02 (isolated HOME, nothing written), the
// composed path dispatched PTY workers under a switch drawn ON, and it shipped
// that way in 0.11.47. The rule inside chooseWorkerRuntime was unreachable for
// the one machine state that matters, a fresh install.
//
// Fixed by giving this reader the SAME polarity as the commander's below —
// explicit ⇒ that runtime, ABSENT ⇒ sdk, anything else ⇒ pty — so the two dials
// answer a missing key the same way and neither can drift from the rule alone.
// Pinned end-to-end by swarmRuntimeDialParity.test.ts, which now composes
// exactly as dispatch does instead of calling chooseWorkerRuntime directly (the
// shortcut that let this defect ship green).
export const getWorkerRuntimeDial = async (): Promise<{
  mode: 'pty' | 'sdk'
  sdkMaxWorkers?: number
}> => {
  const { settings, health } = await getSettingsWithHealth()
  // FILE-level fail-closed, and since the flip above it is doing REAL work: it
  // used to agree with the absent-default by coincidence (absent resolved pty
  // here too), and that coincidence has now expired. A settings.json we cannot
  // read is not consent to run the experimental runtime — whatever it said
  // before it broke. ABSENT is NOT this case: nothing written yet is a fresh
  // install, and its rule is sdk. `sdkMaxWorkers` is dropped with the mode: a
  // PTY fleet has no SDK slot budget. Pinned by runtimeDialFileHealth.test.ts.
  if (health === 'unreadable') return { mode: 'pty' }
  const raw = settings.swarmWorkerRuntime
  const m = raw?.mode
  // Explicit ⇒ that runtime. ABSENT ⇒ sdk. Anything else ⇒ pty — including a
  // CONTAINER we cannot read `mode` out of (a non-object, or an object with no
  // `mode` key), which `?.mode` reports as undefined and therefore rides the
  // absent rule. Identical to getManagerRuntimeDial by design.
  const mode = m === 'pty' ? 'pty' : m === 'sdk' || m === undefined ? 'sdk' : 'pty'
  return { mode, ...(typeof raw?.sdkMaxWorkers === 'number' ? { sdkMaxWorkers: raw.sdkMaxWorkers } : {}) }
}

// ─── Swarm COMMANDER runtime dial (Settings.swarmManagerRuntime) ─────────────
// The stage-3 kill switch, read through here for the same reason as the worker
// dial: the resolution must live in ONE place. WHAT that resolution is changed
// on 2026-08-02 — absent ⇒ sdk, explicit 'pty' and anything unrecognised ⇒ pty
// (the polarity note on the function has the evidence). The commander's default
// matters more than the worker's, because it costs the owner's phone window (an
// SDK desk has no Remote Control) — which is why it moved a day later, and only
// once the twin-prevention race was covered on BOTH runtimes.
/** Which runtime this project's commander desk runs on. Absent ⇒ SDK.
 *
 *  ⚠ THIS DEFAULT MOVED A DAY AFTER THE WORKER'S (2026-08-02), and the delay was
 *  a measured coverage gap rather than caution. On 08-01 the SDK commander was
 *  already proven on a real machine — it seats, holds the singleton against a
 *  second launch, takes `say`, stops and relaunches — but the property the
 *  2026-07-19 eleven-desk incident was actually about was not: the check-then-act
 *  CRITICAL SECTION. Every "TWO/THREE truly simultaneous calls open ONE desk"
 *  test drove the PTY path, because the file that owns them fakes `launchClaude`.
 *  Defaulting to a runtime whose twin-prevention race is untested is that
 *  incident's trade, made on purpose.
 *
 *  `swarmManager.spawn.test.ts` now runs the race on BOTH runtimes, and the SDK
 *  block was proven to bite: removing the spawn lock reds 22 tests, dropping the
 *  SDK pool from the singleton guard reds 4, and reading liveness from `status`
 *  instead of `reaped` (so a desk still unwinding reads as absent) reds 1.
 *
 *  Polarity, unchanged where it matters: explicit 'pty' ⇒ pty (the kill switch),
 *  explicit 'sdk' ⇒ sdk, ABSENT ⇒ sdk, an unrecognised MODE VALUE ⇒ pty.
 *
 *  ⚠ THE FILE LEVEL IS A SEPARATE RULE FROM THE VALUE LEVEL, AND THIS NOTE IS
 *  THE ONE PLACE THAT STATES IT. Callers point here instead of restating it;
 *  three separate restatements drifted from the code before that rule
 *  (2026-08-02). An UNREADABLE or UNPARSEABLE settings.json ⇒ pty — the kill
 *  switch — while an ABSENT one keeps its ⇒ sdk. The two are told apart by
 *  ConfigReadHealth, because before it they were not: readJson swallowed the
 *  read failure and the parse failure alike and returned the fallback, so a
 *  chmod-000 file and a fresh install both arrived here as `mode: undefined`.
 *  Measured 2026-08-02 (isolated HOME), the behaviour that fixed:
 *  an explicit {"mode":"pty"} + chmod 000 ⇒ SDK, and broken JSON ⇒ SDK. An owner
 *  who had deliberately turned the SDK commander off got it back the moment the
 *  file stopped being readable. "A settings file we cannot parse is not evidence
 *  that the SDK runtime is wanted" was written here long before it was true; it
 *  is true now, and runtimeDialFileHealth.test.ts is what keeps it that way.
 *
 *  A caller that wraps this in `.catch(() => pty)` (swarmManager's
 *  `launchNewDesk`) reaches that fallback only from a REJECT — a narrower door
 *  than it looks, and NOT the one the corrupt-file case comes through (that one
 *  resolves, to pty, above). `getSettings` can reject when
 *  `ensureOpenGroundHome()` does — it is awaited OUTSIDE the read's try — but
 *  `homeReady` caches the RESOLVED promise and evicts on reject (paths.ts:201-264,
 *  `homeReady = null` — self-heal), so only an ensure that has not yet cached a
 *  RESOLVED promise can reject that way. Not merely the first CALL: while the
 *  cause persists every call re-enters and re-rejects (measured 2026-08-02 — an
 *  unreadable HOME parent rejected calls #1, #2 and #3 alike, and #4 resolved
 *  once the mode bits were restored). A desk launched on a long-running server
 *  is normally past that window. */
export const getManagerRuntimeDial = async (): Promise<{ mode: 'pty' | 'sdk' }> => {
  const { settings, health } = await getSettingsWithHealth()
  // FILE level first: a settings.json we cannot read is not consent to run the
  // experimental runtime — whatever it may have said before it broke. ABSENT is
  // NOT this case (nothing written yet is a fresh install, and its rule is sdk).
  if (health === 'unreadable') return { mode: 'pty' }
  const m = settings.swarmManagerRuntime?.mode
  if (m === 'pty') return { mode: 'pty' }
  if (m === 'sdk' || m === undefined) return { mode: 'sdk' }
  return { mode: 'pty' } // unrecognised ⇒ the conservative runtime
}

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
    const current = await readSettingsForWrite()
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
    const current = await readSettingsForWrite()
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
    const current = await readSettingsForWrite()
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
    const current = await readSettingsForWrite()
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

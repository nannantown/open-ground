// swarmEnginePersistence — card 2 (docs/ENGINE_PERSISTENCE_PLAN.md §3/§4): the
// engine's OWN intent (desiredRunning / selfSupply / overseer) write-through to
// disk, plus the boot-time crash-loop breaker ring. Both live OUTSIDE
// swarmOrchestrator.ts's in-memory ProjectEngine so a restart can tell "was this
// engine deliberately running" from "never started" — the gap 00-INDEX §2.1
// documented as the reason autonomy always relaunched OFF, and the plan's §2
// explicit reversal of that default.
//
// Write regime (plan §3, bottom): every write goes through atomicWriteJson.
// A WRITE fault is FAIL-OPEN — it never throws, callers just log a warning and
// keep running (a broken disk must not stop a healthy in-memory engine). A READ
// fault is FAIL-QUIET-TO-OFF — an unreadable/corrupt intent file resolves to "not
// running" (never resumes on ambiguous disk state), and an unreadable boot ring
// resolves to "no history" (the breaker degrades to never-trip on a bad disk,
// never to always-trip — a boot must never be blocked by a write fault).

import { readFile, mkdir } from 'fs/promises'
import { atomicWriteJson } from './atomicWrite'
import { projectDataDir, projectDataFile } from './projectDataPath'
import { engineBootsFile, ensureOpenGroundHome } from './paths'

/** The engine's persisted intent for one project — read at boot to decide
 *  whether to resume, written every time the owner (or a toggle route) changes
 *  what the engine SHOULD be doing. `desiredRunning` mirrors `ProjectEngine.running`
 *  at the moment of the write; `selfSupply` / `overseer` mirror their `.enabled`
 *  flags. See {@link projectDataFile} — lives at
 *  `~/.openground/projects/<uuid>/engine.json`. */
export interface EngineIntent {
  desiredRunning: boolean
  selfSupply: boolean
  overseer: boolean
  /** The UTC day (`YYYY-MM-DD`) `selfSupplyDayCount` is counting, and the count
   *  itself — self-supply's DAILY CAP, the guard that bounds how many cards the
   *  engine may propose to itself in a day.
   *
   *  PERSISTED SINCE 2026-07-29, and the asymmetry is why: `enabled` was already
   *  restored at boot while the counter lived only in memory, so every restart
   *  re-armed self-supply with a FRESH daily budget. The engine restarts on every
   *  self-update — i.e. exactly when it has been improving itself — so the cap
   *  that exists to stop a runaway was being reset by the very loop it bounds,
   *  and each round re-spawns the full scan (tsc + eslint + a whole `vitest run`).
   *  Absent/0 reads as "no count yet", so an older engine.json degrades to today's
   *  budget rather than to an unbounded one. */
  selfSupplyDayKey?: string
  selfSupplyDayCount?: number
  /** epoch ms of the write — display/debug only, never read as a decision input. */
  updatedAt: number
}

const DEFAULT_INTENT: Omit<EngineIntent, 'updatedAt'> = {
  desiredRunning: false,
  selfSupply: false,
  overseer: false,
}

const engineIntentFile = (projectPath: string): Promise<string> => projectDataFile(projectPath, 'engine.json')

/** Read the persisted engine intent for a project. FAIL-QUIET-TO-OFF: a missing
 *  file (never started), an unreadable file, or a corrupt/malformed one all
 *  resolve to "not running" — ambiguous disk state must never be read as
 *  "resume". Never throws. */
export const readEngineIntent = async (projectPath: string): Promise<EngineIntent> => {
  try {
    const raw = await readFile(await engineIntentFile(projectPath), 'utf8')
    const parsed = JSON.parse(raw) as Partial<EngineIntent>
    return {
      desiredRunning: parsed.desiredRunning === true,
      selfSupply: parsed.selfSupply === true,
      overseer: parsed.overseer === true,
      ...(typeof parsed.selfSupplyDayKey === 'string' ? { selfSupplyDayKey: parsed.selfSupplyDayKey } : {}),
      ...(typeof parsed.selfSupplyDayCount === 'number' && parsed.selfSupplyDayCount >= 0
        ? { selfSupplyDayCount: parsed.selfSupplyDayCount }
        : {}),
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
    }
  } catch {
    return { ...DEFAULT_INTENT, updatedAt: 0 }
  }
}

/** Write-through the engine's current intent. FAIL-OPEN: returns `false` (never
 *  throws) on a write fault — the in-memory engine is this process's truth; disk
 *  is a best-effort mirror for the NEXT boot, so a bad disk must never affect the
 *  running engine. Callers should log a journal warning on a `false` return
 *  (plan §3) but must not treat it as a reason to change in-memory behaviour. */
export const writeEngineIntent = async (
  projectPath: string,
  intent: Omit<EngineIntent, 'updatedAt'>,
  now: number = Date.now(),
): Promise<boolean> => {
  try {
    // The central data dir (~/.openground/projects/<uuid>/) may not exist yet
    // for a project whose engine has never run before — atomicWriteJson's
    // sibling-temp-file rename needs the directory to already be there (same
    // ensure-then-write shape as projectData.ts's writers).
    await mkdir(await projectDataDir(projectPath), { recursive: true })
    await atomicWriteJson(await engineIntentFile(projectPath), {
      ...intent,
      updatedAt: now,
    } satisfies EngineIntent)
    return true
  } catch {
    return false
  }
}

/** Update ONLY the given fields, leaving the others (read fresh from disk) untouched.
 *  FAIL-OPEN, same contract as {@link writeEngineIntent}.
 *
 *  WHY THIS EXISTS SEPARATELY from a full write of `{desiredRunning: engine.running,
 *  selfSupply: engine.selfSupply.enabled, overseer: engine.overseer.enabled}`: a full
 *  write derives `desiredRunning` from the CALLER's in-memory `engine.running` — which
 *  is only the true owner intent at the two sites that actually SET it
 *  (startOrchestrator / stopOrchestrator). A toggle route (setSelfSupply) that fires
 *  while `engine.running` is false for a reason OTHER than the owner turning it off —
 *  e.g. the crash-loop breaker suppressed this boot's resume, or preflight failed —
 *  must not stamp `desiredRunning:false` over a `true` the owner never touched. That
 *  would silently and PERMANENTLY drop the resume intent the very first time anything
 *  else touches this project's engine.json after a suppressed boot. Reading the
 *  CURRENT disk value and patching only the field this call owns closes that gap. */
export const patchEngineIntent = async (
  projectPath: string,
  patch: Partial<Omit<EngineIntent, 'updatedAt'>>,
  now: number = Date.now(),
): Promise<boolean> => {
  const current = await readEngineIntent(projectPath)
  return writeEngineIntent(
    projectPath,
    {
      desiredRunning: patch.desiredRunning ?? current.desiredRunning,
      selfSupply: patch.selfSupply ?? current.selfSupply,
      overseer: patch.overseer ?? current.overseer,
    },
    now,
  )
}

// ─── crash-loop breaker (plan §4-2) ───────────────────────────────────────────

/** One boot occurrence: when, and which build. */
export interface EngineBootRecord {
  at: number
  appVersion: string
}

interface EngineBootRing {
  items: EngineBootRecord[]
}

/** Ring depth — plan §4-2 says "ring 10 件"; only the newest few ever matter to
 *  the window check below, this just bounds the file. */
const BOOT_RING_CAP = 10
/** "10 分窓に 3 回以上" (plan §4-2). */
const BREAKER_WINDOW_MS = 10 * 60 * 1000
const BREAKER_THRESHOLD = 3

const readBootRing = async (): Promise<EngineBootRecord[]> => {
  try {
    const raw = await readFile(engineBootsFile(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<EngineBootRing>
    if (!Array.isArray(parsed.items)) return []
    return parsed.items.filter(
      (r): r is EngineBootRecord =>
        !!r && typeof r.at === 'number' && typeof r.appVersion === 'string',
    )
  } catch {
    return []
  }
}

/** Append this boot to the ring (capped) and persist it.
 *
 *  DELIBERATELY **FAIL-CLOSED** on the write — unlike the engine-intent writes
 *  above, a breaker whose memory can't reach disk must not silently become "never
 *  trips". `persisted:false` tells the caller ({@link resumeEngines} in
 *  swarmOrchestrator.ts) to refuse to resume ANY project this boot, exactly as if
 *  the breaker HAD tripped — a boot ENOSPC/corrupt-into-a-directory/perm-denied
 *  state is precisely when an unattended resume-and-crash loop (worse once card 5's
 *  Electron backoff respawn exists — 2s/4s/8s with NO window if this stayed
 *  fail-open) is most dangerous. This is the one write in this module that is NOT
 *  fail-open (contrast {@link writeEngineIntent}) — the plan's §3 fail-open rule is
 *  about the engine's OWN intent ("a broken disk must never stop a HEALTHY
 *  engine"), not about the one safety valve that exists to stop an UNHEALTHY one.
 *
 *  Always call this BEFORE judging {@link isCrashLoopTripped} so a suppressed boot
 *  still counts toward the window (otherwise a permanently-tripped state could
 *  never self-heal past the threshold) — the in-memory `items` are returned even
 *  on a write failure so THIS boot's judgement still has real data to work with. */
export const recordEngineBoot = async (
  appVersion: string,
  now: number = Date.now(),
): Promise<{ items: EngineBootRecord[]; persisted: boolean }> => {
  // MUST-FIX (2026-07-22, 2nd rework): a FIRST-EVER launch has no
  // `~/.openground/` yet — atomicWriteJson's sibling-temp-file rename needs
  // the directory to already exist, so without this the very first boot's
  // ring write ENOENTs, `persisted` comes back false, and the fail-CLOSED
  // breaker (see below) fires a FALSE "couldn't save boot history" fatal
  // notification at a brand-new owner who has zero projects and a perfectly
  // healthy disk (reviewer-observed: `suppressed:true` + a lone
  // swarm-notifications.json on a freshly-deleted test HOME). Use
  // `ensureOpenGroundHome()` — NOT a bare `mkdir(openGroundHome())` — because
  // the bare form would pre-empt the legacy `~/.hove` / `~/.pmmap` → `~/.openground`
  // migration paths.ts itself owns (that migration only runs while the new
  // home does NOT yet exist; creating an empty one first would permanently
  // strand an old install's data). `writeEngineIntent` already does this
  // correctly (via `mkdir(projectDataDir(...))`, which routes through the same
  // migration-safe home); this closes the ONE write site in this module that
  // didn't.
  // Never let ensureOpenGroundHome() itself throw out of this function —
  // resumeEngines() (the only caller) must NEVER throw. A migration/mkdir
  // fault here is exactly the kind of disk trouble the fail-CLOSED write
  // below already handles; skip straight to that outcome instead of
  // propagating.
  const ring = await ensureOpenGroundHome()
    .then(() => readBootRing())
    .catch(() => [] as EngineBootRecord[])
  const items = [...ring, { at: now, appVersion }].slice(-BOOT_RING_CAP)
  const persisted = await atomicWriteJson(engineBootsFile(), { items } satisfies EngineBootRing).then(
    () => true,
    () => false,
  )
  return { items, persisted }
}

/** Pure judgement: has THIS version restarted {@link BREAKER_THRESHOLD}+ times
 *  within the trailing {@link BREAKER_WINDOW_MS}? Filtering by `appVersion` is
 *  what makes a version bump reset the window (plan §4-2 "version が変わったら
 *  窓リセット") — a REAL release (the version string in package.json only moves on
 *  `/release`, never during an in-app self-update's own cutover) gets a fresh
 *  window. A self-update cutover looping WITHIN one version does NOT reset the
 *  window and DOES count toward the threshold — that loop is itself exactly the
 *  crash-loop symptom this breaker exists to catch, not something to exempt. */
export const isCrashLoopTripped = (
  items: readonly EngineBootRecord[],
  appVersion: string,
  now: number = Date.now(),
): boolean =>
  items.filter((r) => r.appVersion === appVersion && now - r.at <= BREAKER_WINDOW_MS).length >=
  BREAKER_THRESHOLD

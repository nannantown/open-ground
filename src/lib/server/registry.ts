import { readdir, stat } from 'fs/promises'
import { homedir } from 'os'
import { basename, join, relative, resolve, sep } from 'path'
import { createHash, randomUUID } from 'crypto'
import type { CanvasState, ProjectEntry, Settings } from '../types'
import { getCanvas, getSettings, setCanvas, setSettings } from './store'
import { openGroundHome } from './paths'
import { canonicalize } from './canonicalize'

// ─── The project registry ──────────────────────────────────────────────────
// OPEN GROUND used to derive its project list by scanning every subdirectory of
// a single configured `projectsRoot`. It now keeps a user-curated registry of
// arbitrary folder paths (`Settings.projects`): projects are added one at a
// time via "Create new" or "Import existing folder". This module owns the
// registry: its CRUD, the one-shot migration from the legacy single-root model,
// and the import-target safety predicate. `store.ts` stays a pure JSON layer.

const now = () => new Date().toISOString()

// The legacy project id: sha1 of a STABLE key (folder name for active
// projects, `_archive/<name>` relative path for archived ones), first 12 hex.
// Only used by the migration to map old canvas-position keys onto the new
// stable UUIDs. Mirrors the old scan.ts `projectId`.
const legacyProjectId = (stableKey: string) =>
  createHash('sha1').update(stableKey).digest('hex').slice(0, 12)

// ─── Migration (one-shot, idempotent) ───────────────────────────────────────
// Cached per OPEN GROUND home so the test suite (which points OPENGROUND_HOME at
// a fresh tmp dir per case) still migrates each home exactly once, while a
// single home is never migrated twice in one process. The persisted
// `projectsMigratedAt` sentinel is the cross-process guard.
const migrating = new Map<string, Promise<void>>()

export const ensureProjectsMigrated = async (): Promise<void> => {
  const home = openGroundHome()
  let p = migrating.get(home)
  if (!p) {
    p = migrateOnce()
    // Evict on rejection so a transient FS failure self-heals on the next call
    // instead of caching a permanently-rejected promise — which would wedge
    // GET /api/projects (and every validateProjectPath) at 500 forever. The
    // identity guard avoids clobbering a newer in-flight attempt.
    p.catch(() => {
      if (migrating.get(home) === p) migrating.delete(home)
    })
    migrating.set(home, p)
  }
  return p
}

const migrateOnce = async (): Promise<void> => {
  const settings = await getSettings()
  // Already migrated (idempotency keys off the sentinel, NOT projects.length —
  // a user who later removes every project must not be re-scanned).
  if (settings.projectsMigratedAt) return

  const root = settings.projectsRoot
  if (!root) {
    // Fresh install (or already-empty config): just stamp the sentinel.
    await setSettings({ projectsMigratedAt: now() })
    return
  }

  // Enumerate the old root exactly as the legacy scan did.
  const found = await enumerateLegacyRoot(root, settings)

  // Reuse each folder's LEGACY id (sha1 of the folder name) as the registry
  // entry id. This is the key to a crash-safe migration: the legacy id is
  // deterministic, so a retry mints the SAME ids, and — crucially — canvas
  // positions are already keyed by that same legacy id, so they need no
  // re-keying at all. We still rewrite canvas.positions to DROP orphan keys
  // (positions for projects that no longer exist) for tidiness.
  const projects: ProjectEntry[] = []
  const liveIds = new Set<string>()
  for (const f of found) {
    projects.push({ id: f.oldId, path: await canonicalize(f.abs), addedAt: now() })
    liveIds.add(f.oldId)
  }

  // Keep only positions whose key is a live project id; identity-map otherwise.
  const canvas = await getCanvas()
  const positions: CanvasState['positions'] = {}
  let changed = false
  for (const [id, pos] of Object.entries(canvas.positions)) {
    if (liveIds.has(id)) positions[id] = pos
    else changed = true // an orphan key we're dropping
  }

  // Commit the (orphan-pruned) canvas BEFORE the sentinel, so the sentinel
  // (written via setSettings) is the LAST durable write. Because the ids are
  // deterministic, a crash + retry re-derives the identical mapping, so this is
  // fully idempotent. Only write canvas when we actually changed it, to avoid a
  // needless write (and to never clobber positions on a no-op retry).
  if (changed) await setCanvas({ ...canvas, positions })

  await setSettings({
    projects,
    projectsMigratedAt: now(),
    // Default new-project location to where their projects already live.
    defaultWorkspace: settings.defaultWorkspace ?? root,
  })
}

type LegacyFolder = { abs: string; oldId: string }

// Mirror the old scan.ts enumeration: top-level subdirs (minus dotfiles and
// excludePatterns) as active projects, plus one level of `_archive/*` as
// (now-plain) projects so archived cards aren't silently lost.
const enumerateLegacyRoot = async (
  root: string,
  settings: Settings,
): Promise<LegacyFolder[]> => {
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch {
    return []
  }
  const out: LegacyFolder[] = []
  const archiveDir = settings.archiveDirName
  for (const entry of entries) {
    if (entry.startsWith('.')) continue
    if (entry === archiveDir) {
      const archivePath = join(root, archiveDir)
      let subs: string[] = []
      try {
        subs = await readdir(archivePath)
      } catch {
        continue
      }
      for (const sub of subs) {
        const abs = join(archivePath, sub)
        if (!(await isDir(abs))) continue
        out.push({ abs, oldId: legacyProjectId(relative(root, abs)) })
      }
      continue
    }
    if (settings.excludePatterns.includes(entry)) continue
    const abs = join(root, entry)
    if (!(await isDir(abs))) continue
    out.push({ abs, oldId: legacyProjectId(basename(abs)) })
  }
  return out
}

const isDir = async (p: string): Promise<boolean> => {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}

// ─── Registry CRUD ───────────────────────────────────────────────────────────
// All helpers store/compare paths in canonical (symlink-resolved) form so the
// validateProjectPath security comparison is symmetric.

const canonProjects = async (): Promise<ProjectEntry[]> => {
  const settings = await getSettings()
  return settings.projects ?? []
}

// store.setSettings is an unlocked read-modify-write, so two overlapping
// registry mutations can both observe the same `projects` array and the second
// write clobbers the first (a lost import/remove). Serialize every registry
// read-modify-write through this single-flight chain (mirrors canvasData's
// write queue). Canonicalization stays OUTSIDE the lock — it's pure and may
// touch the FS, so we don't want it holding the chain.
let registryChain: Promise<unknown> = Promise.resolve()
const withRegistryLock = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = registryChain.then(fn, fn)
  registryChain = run.catch(() => {})
  return run
}

/** Register a folder. Idempotent: returns the existing entry if its canonical
 *  path is already registered. Caller is responsible for any safety checks
 *  (see {@link isDangerousImportTarget}) and for confirming it's a directory. */
export const addProjectEntry = async (
  path: string,
  description?: string,
): Promise<ProjectEntry> => {
  const canon = await canonicalize(path)
  return withRegistryLock(async () => {
    const projects = await canonProjects()
    const existing = projects.find((e) => e.path === canon)
    if (existing) return existing
    const entry: ProjectEntry = {
      id: randomUUID(),
      path: canon,
      addedAt: now(),
      ...(description ? { description } : {}),
    }
    await setSettings({ projects: [...projects, entry] })
    return entry
  })
}

/** Unregister a folder (no disk change). Returns the removed entry (so the
 *  caller can drop its canvas position) or null if it wasn't registered. */
export const removeProjectEntry = async (
  path: string,
): Promise<ProjectEntry | null> => {
  const canon = await canonicalize(path)
  return withRegistryLock(async () => {
    const projects = await canonProjects()
    const entry = projects.find((e) => e.path === canon)
    if (!entry) return null
    await setSettings({ projects: projects.filter((e) => e.id !== entry.id) })
    return entry
  })
}

/** Point an existing entry at a new path after an on-disk rename/move. The
 *  entry's `id` is preserved, so its canvas position needs no remap. Returns
 *  the updated entry or null if the old path wasn't registered. */
export const updateProjectEntryPath = async (
  oldPath: string,
  newPath: string,
): Promise<ProjectEntry | null> => {
  const oldCanon = await canonicalize(oldPath)
  const newCanon = await canonicalize(newPath)
  return withRegistryLock(async () => {
    const projects = await canonProjects()
    const entry = projects.find((e) => e.path === oldCanon)
    if (!entry) return null
    const updated = { ...entry, path: newCanon }
    await setSettings({
      projects: projects.map((e) => (e.id === entry.id ? updated : e)),
    })
    return updated
  })
}

/** Set (or clear) a project's optional display name — the cosmetic project name
 *  shown on the Ground card / project header in place of the folder basename. A
 *  blank name DROPS the field (reverting to the folder name) rather than storing
 *  "". Keyed by canonical PATH (the project is active, so its path resolves) so
 *  it lines up with the route's validateProjectPath guard. The entry's id is
 *  untouched, so canvas position + central data stay put. Returns the updated
 *  entry, or null if the path isn't registered. */
export const setProjectDisplayName = async (
  path: string,
  name: string,
): Promise<ProjectEntry | null> => {
  const canon = await canonicalize(path)
  const clean = name.trim()
  return withRegistryLock(async () => {
    const projects = await canonProjects()
    const entry = projects.find((e) => e.path === canon)
    if (!entry) return null
    let updated: ProjectEntry
    if (clean) {
      updated = { ...entry, displayName: clean }
    } else {
      const { displayName: _drop, ...rest } = entry
      updated = rest
    }
    await setSettings({ projects: projects.map((e) => (e.id === entry.id ? updated : e)) })
    return updated
  })
}

// ─── Import safety ────────────────────────────────────────────────────────────
// Importing registers an arbitrary path as a new security-boundary root, so
// reject targets that would make far too much of the filesystem writable, or
// that nest with an already-registered project (which breaks the "is this path
// under exactly one project" mental model and the canvas).
export type ImportRejection =
  | 'filesystem-root'
  | 'home-root'
  | 'overlap'
  | null

export const isDangerousImportTarget = async (
  canonPath: string,
  entries: ProjectEntry[],
): Promise<ImportRejection> => {
  if (canonPath === resolve('/')) return 'filesystem-root'
  if (canonPath === (await canonicalize(homedir()))) return 'home-root'
  for (const e of entries) {
    // ancestor of an existing entry, or descendant of one
    if (
      e.path === canonPath ||
      e.path.startsWith(canonPath + sep) ||
      canonPath.startsWith(e.path + sep)
    ) {
      return 'overlap'
    }
  }
  return null
}

export type ImportResult =
  | { entry: ProjectEntry }
  | { rejection: 'duplicate' | Exclude<ImportRejection, null> }

/** Import an existing folder atomically. The duplicate + overlap/dangerous-
 *  target checks run against the registry INSIDE the same lock as the write, so
 *  two concurrent nested imports (e.g. /a/b and /a/b/c) can't both snapshot a
 *  registry that lacks the other and slip past the overlap guard. */
export const addImportedProjectEntry = async (
  path: string,
  description?: string,
): Promise<ImportResult> => {
  const canon = await canonicalize(path)
  return withRegistryLock(async () => {
    const projects = await canonProjects()
    if (projects.some((e) => e.path === canon)) return { rejection: 'duplicate' }
    const danger = await isDangerousImportTarget(canon, projects)
    if (danger) return { rejection: danger }
    const entry: ProjectEntry = {
      id: randomUUID(),
      path: canon,
      addedAt: now(),
      ...(description ? { description } : {}),
    }
    await setSettings({ projects: [...projects, entry] })
    return { entry }
  })
}

export type CreateResult =
  | { entry: ProjectEntry }
  | { rejection: Exclude<ImportRejection, null> }

/** Register a folder POST /api/projects/new just mkdir'd. Runs the SAME
 *  overlap/dangerous-target guard as Import, and like Import the check runs
 *  INSIDE the registry lock with the write — so a /new racing an import (or
 *  another /new) of a nesting path can't slip past. Without this guard a
 *  project created inside an existing one would silently share the outer
 *  entry's UUID for all central data (projectUUIDFromPath returns the first
 *  isAtOrUnder match), cross-wiring the two boards.
 *
 *  Exact-path re-registration stays idempotent like addProjectEntry (checked
 *  BEFORE the guard, which would call it overlap): mkdir succeeded, so an
 *  entry at the same canonical path can only be a missing project whose folder
 *  was recreated in place — returning it reconnects the card to its central
 *  data instead of rejecting. */
export const addCreatedProjectEntry = async (
  path: string,
  description?: string,
): Promise<CreateResult> => {
  const canon = await canonicalize(path)
  return withRegistryLock(async () => {
    const projects = await canonProjects()
    const existing = projects.find((e) => e.path === canon)
    if (existing) return { entry: existing }
    const danger = await isDangerousImportTarget(canon, projects)
    if (danger) return { rejection: danger }
    const entry: ProjectEntry = {
      id: randomUUID(),
      path: canon,
      addedAt: now(),
      ...(description ? { description } : {}),
    }
    await setSettings({ projects: [...projects, entry] })
    return { entry }
  })
}

export type RelocateResult =
  | { entry: ProjectEntry }
  | { rejection: 'not-found' | 'duplicate' | Exclude<ImportRejection, null> }

/** Re-point a registered project (looked up BY ID, so a missing card keeps its
 *  identity) at a folder the user selected — used when the original path moved
 *  or vanished (copy / email / rename outside OPEN GROUND). The entry's `id` is
 *  preserved, so its central data (~/.openground/projects/<id>/) and canvas
 *  position reconnect with zero remap. The overlap/dangerous-target guard runs
 *  INSIDE the lock against the OTHER entries (self excluded) so a relocate can't
 *  nest two projects on one tree. Distinct from Import, which mints a NEW id for
 *  a foreign folder (clean start). */
export const relocateProjectEntry = async (
  id: string,
  newPath: string,
): Promise<RelocateResult> => {
  const canon = await canonicalize(newPath)
  return withRegistryLock(async () => {
    const projects = await canonProjects()
    const entry = projects.find((e) => e.id === id)
    if (!entry) return { rejection: 'not-found' }
    if (entry.path === canon) return { entry } // already there — no-op
    const others = projects.filter((e) => e.id !== id)
    if (others.some((e) => e.path === canon)) return { rejection: 'duplicate' }
    const danger = await isDangerousImportTarget(canon, others)
    if (danger) return { rejection: danger }
    const updated = { ...entry, path: canon }
    await setSettings({ projects: projects.map((e) => (e.id === id ? updated : e)) })
    return { entry: updated }
  })
}

// ─── Member folder link (folder-less shared project → local checkout) ─────────
// A collaborator who JOINED a shared project by invite has no local folder for it
// (Board/Canvas sync over the Cloudflare DO). Linking their OWN local folder
// (their clone — never the owner's code) registers it as a security-boundary root
// so the shared project's Terminal can spawn Claude in it, while Board/Canvas keep
// syncing in realtime. The link is just a normal registry entry carrying a
// `collabProjectId` back-reference, so it goes through the SAME canonicalize +
// dangerous-target guard as Import (the allowlist is never weakened) and is hidden
// from the standalone Ground card list (scan.ts) so it doesn't duplicate the
// shared card.

export type LinkResult =
  | { entry: ProjectEntry }
  | {
      rejection: 'already-linked' | 'duplicate' | Exclude<ImportRejection, null>
    }

/** The local folder a member has linked to a folder-less shared project, or null
 *  if none. Keyed by the cross-user collabProjectId (og_projects.id). */
export const findLinkedFolder = async (
  collabProjectId: string,
): Promise<string | null> => {
  const projects = await canonProjects()
  return projects.find((e) => e.collabProjectId === collabProjectId)?.path ?? null
}

/** Link a member's OWN local folder to a folder-less shared project they joined.
 *  Mints a NEW registry entry (its own UUID) at the chosen folder, tagged with the
 *  collabProjectId, so the path lands on the validateProjectPath allowlist (the
 *  member can now run a Terminal/Claude there) while Board/Canvas stay on the
 *  shared doc. The duplicate + overlap/dangerous-target checks run INSIDE the lock
 *  (reusing {@link isDangerousImportTarget}) exactly like Import, so this never
 *  weakens the security boundary. Idempotent if the SAME folder is re-linked;
 *  re-pointing an already-linked project at a different folder is rejected
 *  ('already-linked') — swapping/unlinking is deferred. The caller (the route)
 *  must first confirm the signed-in user's MEMBERSHIP of collabProjectId and that
 *  the path is a real directory. */
export const linkSharedProjectToFolder = async (
  collabProjectId: string,
  localPath: string,
): Promise<LinkResult> => {
  const canon = await canonicalize(localPath)
  return withRegistryLock(async () => {
    const projects = await canonProjects()
    // Already linked? Same folder → idempotent no-op; different folder → reject
    // (re-pointing/unlinking is a separate, deferred concern).
    const linked = projects.find((e) => e.collabProjectId === collabProjectId)
    if (linked) {
      return linked.path === canon ? { entry: linked } : { rejection: 'already-linked' }
    }
    // The folder must not already be a registered project (don't double-register
    // one tree) — checked first for a clearer message than the overlap guard.
    if (projects.some((e) => e.path === canon)) return { rejection: 'duplicate' }
    const danger = await isDangerousImportTarget(canon, projects)
    if (danger) return { rejection: danger }
    const entry: ProjectEntry = {
      id: randomUUID(),
      path: canon,
      addedAt: now(),
      collabProjectId,
    }
    await setSettings({ projects: [...projects, entry] })
    return { entry }
  })
}

// Test seam: reset the per-home migration cache so a test can re-run migration
// against a freshly-seeded home within the same process.
export const __resetMigrationCacheForTests = () => migrating.clear()

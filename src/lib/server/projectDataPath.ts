import { join, sep } from 'path'
import { getSettings } from './store'
import { canonicalize } from './canonicalize'
import { ensureProjectsMigrated } from './registry'
import { projectCentralDir, centralWorktreesDir, openGroundHome } from './paths'

// The resolver that maps a project path to its central data directory under
// ~/.openground/projects/<uuid>/. This is the single seam every per-project
// data module routes through (projectData, journal, doc, canvases, images,
// attachments, verify-logs) AND the security boundary (validateProjectPath),
// so the "what counts as this project's storage" rule lives in exactly one
// place.
//
// The REGISTRY is never memoized: getSettings() reads disk per call (no cache),
// so the registry is always fresh. A process-lifetime path→uuid memo would
// reconnect orphaned central data after a Remove-then-same-folder-Import (a
// stale entry would hand back the dead uuid), breaking the "Import = clean
// start" contract. Only the canonical form of each entry's roots is reused
// (registryRoots below), keyed by the entries themselves — so that contract
// holds: a Remove/Import changes the key.

// Is `target` the directory `root` itself, or a descendant of it? Both args
// must already be canonical. The sep-terminated prefix check stops `/a/foobar`
// from matching root `/a/foo` (and `…/worktrees-evil` from matching the
// `…/worktrees` root).
const isAtOrUnder = (target: string, root: string): boolean =>
  target === root || target.startsWith(root + sep)

interface OwnedRoots {
  id: string
  root: string
  worktrees: string
}

// How long the canonical roots of an UNCHANGED registry may be reused.
//
// WHY (measured 2026-10-06): every call used to realpath every registered root
// and its worktrees dir — 2N realpaths per call — and GET /api/ground/lamps
// (polled every 5 s) makes ~5 calls per project, i.e. O(N²): with ~20 projects
// one lamps request cost ≈470 ms of CPU, ≈9% of a core around the clock.
//
// Safe to reuse: the key is the registry entries (+ the home they resolve
// under), read fresh every call, so any registry change recomputes at once.
// What can age is only the filesystem's answer for an unchanged entry — a
// registered root that is itself a symlink being re-pointed — and that is
// re-read within this window. A path the registry no longer names is never
// accepted from the memo: the key would differ.
const ROOTS_MEMO_MS = 10_000
let rootsMemo: { key: string; at: number; roots: Promise<OwnedRoots[]> } | null = null

const registryRoots = (entries: ReadonlyArray<{ id: string; path: string }>): Promise<OwnedRoots[]> => {
  const key = JSON.stringify([openGroundHome(), entries.map((e) => [e.id, e.path])])
  const now = Date.now()
  if (rootsMemo && rootsMemo.key === key && now - rootsMemo.at < ROOTS_MEMO_MS) return rootsMemo.roots
  const roots = Promise.all(
    entries.map(async (e) => ({
      id: e.id,
      // e.path is stored canonical, but re-canonicalize defensively (a
      // hand-edited settings.json could hold a symlinked path).
      root: await canonicalize(e.path),
      // Central worktrees live OUTSIDE the repo at
      // ~/.openground/projects/<uuid>/worktrees/<runId>; canonicalize that root
      // too — openGroundHome() is not realpathed, so under a symlinked
      // $HOME/OPENGROUND_HOME (test tmpdirs, macOS /var→/private/var) a lexical
      // root would never match the realpathed target.
      worktrees: await canonicalize(centralWorktreesDir(e.id)),
    })),
  )
  const memo = { key, at: now, roots }
  rootsMemo = memo
  roots.catch(() => {
    if (rootsMemo === memo) rootsMemo = null
  })
  return roots
}

/** Drop the canonical-roots memo — for tests that re-point a path on disk. */
export const resetRegistryRootsMemo = (): void => {
  rootsMemo = null
}

// Resolve a project path — the registered project root (or a descendant) OR one
// of its central worktree paths — to the owning registry UUID.
//
// THROWS when no registered project owns the path: callers must never silently
// fall back to a junk dir (a `projects/undefined/` write would quietly destroy
// data, since readProjectData() returns empty() on a missing file). Every route
// that reaches a data module has already passed validateProjectPath, so a throw
// here signals a real bug, not user input.
export const projectUUIDFromPath = async (projectPath: string): Promise<string> => {
  await ensureProjectsMigrated()
  const settings = await getSettings()
  const entries = settings.projects ?? []
  // Canonicalize the incoming path: routes hand us the raw client-supplied path
  // (un-canonicalized — see middleware/projectPath.ts), while the registry
  // stores canonical paths. A naive `e.path === projectPath` would miss on
  // symlinks, trailing slashes and macOS case-folding for inputs that
  // validateProjectPath already accepted.
  const target = await canonicalize(projectPath)
  // In registry order, each entry's root then its central worktrees dir (the
  // verifier, running in the worktree cwd, and the transcript route resolve
  // those back to the owning project). The UUID comes ONLY from the registry
  // entry — never parsed from the incoming path — so a forged
  // `.../projects/<attacker-uuid>/…` cannot self-authorize.
  for (const r of await registryRoots(entries)) {
    if (isAtOrUnder(target, r.root)) return r.id
    if (isAtOrUnder(target, r.worktrees)) return r.id
  }
  throw new Error(
    `projectUUIDFromPath: no registered project owns ${projectPath} (canonical ${target})`,
  )
}

// Batch form of {@link projectUUIDFromPath} for read-only callers that must
// attribute MANY paths at once — the Ground beacon resolves every live claude
// PTY's cwd on a 5s poll. Reads the registry ONCE and canonicalizes each root
// once (projectUUIDFromPath re-reads settings.json and re-realpaths every entry
// per call), and maps an unowned path to `null` instead of throwing: a beacon
// poll routinely sees free shells in ~/ and must not 500 on them.
//
// Ownership follows exactly the same rule as projectUUIDFromPath (registry root
// or that entry's central worktrees dir, both canonical, UUID taken only from
// the registry) — it shares `isAtOrUnder` so the two can't drift. It is NOT a
// security boundary: keep using projectUUIDFromPath / isValidProjectPath there.
export const projectUUIDsForPaths = async (
  paths: readonly string[],
): Promise<Map<string, string | null>> => {
  await ensureProjectsMigrated()
  const settings = await getSettings()
  const roots = await registryRoots(settings.projects ?? [])
  const out = new Map<string, string | null>()
  for (const p of Array.from(new Set(paths))) {
    const target = await canonicalize(p)
    const hit = roots.find((r) => isAtOrUnder(target, r.root) || isAtOrUnder(target, r.worktrees))
    out.set(p, hit?.id ?? null)
  }
  return out
}

// Boolean form of {@link projectUUIDFromPath} for the security boundary. Accepts
// a registered project root/descendant OR a central worktree path; rejects
// everything else — crucially the bare central data root
// (~/.openground/projects/<uuid>/ and its non-worktree subdirs like canvases/),
// so a crafted cwd can't read another project's data files.
export const isValidProjectPath = async (projectPath: string): Promise<boolean> => {
  try {
    await projectUUIDFromPath(projectPath)
    return true
  } catch {
    return false
  }
}

// The central data directory for the project owning `projectPath`
// (~/.openground/projects/<uuid>/). `projectPath` may be the project root or a
// central worktree path — both resolve to the same UUID.
export const projectDataDir = async (projectPath: string): Promise<string> =>
  projectCentralDir(await projectUUIDFromPath(projectPath))

// Absolute path to `rel` (e.g. 'tasks.json', 'canvases/x.json') inside the
// project's central data dir.
export const projectDataFile = async (projectPath: string, rel: string): Promise<string> =>
  join(await projectDataDir(projectPath), rel)

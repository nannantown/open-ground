import { join, sep } from 'path'
import { getSettings } from './store'
import { canonicalize } from './canonicalize'
import { ensureProjectsMigrated } from './registry'
import { projectCentralDir, centralWorktreesDir } from './paths'

// The resolver that maps a project path to its central data directory under
// ~/.openground/projects/<uuid>/. This is the single seam every per-project
// data module routes through (projectData, journal, doc, canvases, images,
// attachments, verify-logs) AND the security boundary (validateProjectPath),
// so the "what counts as this project's storage" rule lives in exactly one
// place.
//
// NOT memoized on purpose: getSettings() reads disk per call (no cache), so the
// registry is always fresh. A process-lifetime path→uuid memo would reconnect
// orphaned central data after a Remove-then-same-folder-Import (a stale entry
// would hand back the dead uuid), breaking the "Import = clean start" contract.

// Is `target` the directory `root` itself, or a descendant of it? Both args
// must already be canonical. The sep-terminated prefix check stops `/a/foobar`
// from matching root `/a/foo` (and `…/worktrees-evil` from matching the
// `…/worktrees` root).
const isAtOrUnder = (target: string, root: string): boolean =>
  target === root || target.startsWith(root + sep)

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
  for (const e of entries) {
    // e.path is stored canonical, but re-canonicalize defensively (a hand-edited
    // settings.json could hold a symlinked path).
    const root = await canonicalize(e.path)
    if (isAtOrUnder(target, root)) return e.id
    // Central worktrees live OUTSIDE the repo at
    // ~/.openground/projects/<uuid>/worktrees/<runId>; the verifier (which runs
    // in the worktree cwd) and the transcript route resolve those back to the
    // owning project. Canonicalize the worktree root too — openGroundHome() is
    // not realpathed, so under a symlinked $HOME/OPENGROUND_HOME (test tmpdirs,
    // macOS /var→/private/var) a lexical root would never match the realpathed
    // target. The UUID comes ONLY from the registry entry (e.id) — never parsed
    // from the incoming path — so a forged `.../projects/<attacker-uuid>/…`
    // cannot self-authorize.
    const wt = await canonicalize(centralWorktreesDir(e.id))
    if (isAtOrUnder(target, wt)) return e.id
  }
  throw new Error(
    `projectUUIDFromPath: no registered project owns ${projectPath} (canonical ${target})`,
  )
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

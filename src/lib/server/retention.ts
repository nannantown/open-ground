import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { readFile, readdir, rm, rmdir, stat, unlink } from 'fs/promises'
import { isAbsolute, join } from 'path'
import { canonicalize } from './canonicalize'
import { isGitRepoRoot } from './gitRepoGuard'
import { centralWorktreesDir, openGroundHome, projectsDataRootDir, runsDir } from './paths'
import { projectDataDir } from './projectDataPath'
import { getSettings } from './store'

// Retention for the EPISODIC layer: the raw run cache (~/.openground/runs/)
// and per-project task attachments are pruned after a retention window.
// (Formerly part of journal.ts; the journal itself is gone — Claude's own
// JSONL transcripts remain the durable record and are never touched here.)

/** Days the raw run cache + attachments are kept before pruning. */
export const RAW_RETENTION_DAYS = 14
const RETENTION_MS = RAW_RETENTION_DAYS * 24 * 60 * 60 * 1000

const olderThanRetention = (iso: string | undefined, mtimeMs: number): boolean => {
  const t = iso ? Date.parse(iso) : NaN
  const age = Date.now() - (Number.isNaN(t) ? mtimeMs : t)
  return age > RETENTION_MS
}

/** Delete run-cache files (~/.openground/runs/*.json) whose run finished more
 *  than RAW_RETENTION_DAYS ago. Claude's own JSONL transcripts are left
 *  untouched (Claude Code owns those). */
export const pruneOldRunFiles = async (): Promise<number> => {
  let removed = 0
  let files: string[]
  try {
    files = (await readdir(runsDir())).filter(f => f.endsWith('.json'))
  } catch {
    return 0
  }
  for (const f of files) {
    const full = join(runsDir(), f)
    try {
      const st = await stat(full)
      let finishedAt: string | undefined
      try {
        // Legacy run-cache shape (the batch runner is gone; this prunes the
        // files it left behind). Only `finishedAt` matters here.
        const s = JSON.parse(await readFile(full, 'utf8')) as { finishedAt?: string }
        finishedAt = s.finishedAt
        if (!finishedAt) continue // never delete an unfinished/in-flight run
      } catch {
        finishedAt = undefined
      }
      if (olderThanRetention(finishedAt, st.mtimeMs)) {
        await unlink(full)
        removed += 1
      }
    } catch {
      /* skip */
    }
  }
  return removed
}

/** Delete attachment files under a project's .openground/task-attachments/ that
 *  are older than the retention window (their paths already lived in past run
 *  instructions). */
export const pruneOldAttachments = async (projectPath: string): Promise<number> => {
  let removed = 0
  let files: string[]
  let dir: string
  try {
    dir = join(await projectDataDir(projectPath), 'task-attachments')
    files = await readdir(dir)
  } catch {
    return 0
  }
  for (const f of files) {
    const full = join(dir, f)
    try {
      const st = await stat(full)
      if (Date.now() - st.mtimeMs > RETENTION_MS) {
        await unlink(full)
        removed += 1
      }
    } catch {
      /* skip */
    }
  }
  return removed
}

// ── Cross-repo residue sweep ──────────────────────────────────────────────────
// Boot-time, repo-agnostic cleanup of swarm leftovers. The per-repo janitor
// (swarmJanitor.ts) only reaches a repo while a cockpit/engine runs THERE — a
// repo whose cockpit never opens again keeps its ghost heartbeats and orphan
// central worktrees forever (observed: 6 days of kickstand residue). This sweep
// walks the whole ~/.openground instead:
//   (a) ~/.openground/swarm/<key>/*.json heartbeats — <key> is a hash, the repo
//       can't be recovered from it, so the heartbeat's own `worktree` field is
//       the only liveness signal. A heartbeat whose worktree still exists is
//       kept regardless of age; one whose worktree is gone is removed only
//       after GHOST_HEARTBEAT_HOURS (safe side: newest of mtime/updatedAt).
//   (b) a <key> dir left empty by (a) is removed (rmdir — refuses non-empty,
//       so a racing writer can never lose a fresh heartbeat).
//   (c) ~/.openground/projects/<uuid>/worktrees/* dirs not listed by the
//       registered repo's `git worktree list` (or whose repo is gone). Live git
//       metadata always shows up in that list, so a true orphan is unreadable
//       by git — "zero uncommitted work" is provable only for an effectively
//       empty dir. Those are deleted; anything else is kept + warned.
//   (d) central data dirs whose uuid is not in the registry: DETECTED and
//       warned (one line), never auto-deleted.

/** Hours a heartbeat whose worktree is GONE is still kept (a worker may be
 *  mid-move or the disk mid-mount; only provably-dead-and-old files go). */
export const GHOST_HEARTBEAT_HOURS = 48
const GHOST_HEARTBEAT_MS = GHOST_HEARTBEAT_HOURS * 60 * 60 * 1000

const execFile = promisify(execFileCb)

// House convention (swarmJanitor / swarmIntegrate / mergedBranches): git never
// hangs on a credential prompt and gets a hard timeout.
const git = async (cwd: string, args: string[]): Promise<string | null> => {
  if (!isGitRepoRoot(cwd)) return null // gitRepoGuard: never spawn git in a non-repo/vanishing cwd
  try {
    const { stdout } = await execFile('git', args, {
      cwd,
      timeout: 60_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    return stdout
  } catch {
    return null
  }
}

const pathExists = async (p: string): Promise<boolean> => {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

export interface GhostHeartbeatSweepReport {
  /** Heartbeat files removed (full paths). */
  removedFiles: string[]
  /** Now-empty <key> dirs removed (full paths). */
  removedDirs: string[]
}

/** (a)+(b) Sweep ghost heartbeats across ALL repos' heartbeat dirs. */
export const pruneGhostHeartbeats = async (
  opts: { now?: number } = {},
): Promise<GhostHeartbeatSweepReport> => {
  const now = opts.now ?? Date.now()
  const report: GhostHeartbeatSweepReport = { removedFiles: [], removedDirs: [] }
  const root = join(openGroundHome(), 'swarm')
  let keys
  try {
    keys = await readdir(root, { withFileTypes: true })
  } catch {
    return report // no swarm dir yet → nothing to sweep
  }
  for (const k of keys) {
    if (!k.isDirectory()) continue
    const dir = join(root, k.name)
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      continue
    }
    for (const f of entries) {
      if (!f.endsWith('.json')) continue // heartbeats only — never other files
      const full = join(dir, f)
      try {
        const st = await stat(full)
        if (!st.isFile()) continue
        let worktree: string | undefined
        let updatedMs = NaN
        try {
          const j = JSON.parse(await readFile(full, 'utf8')) as {
            worktree?: unknown
            updatedAt?: unknown
          }
          // A relative/empty `worktree` is a malformed/foreign file — no
          // liveness signal (the writer always emits `pwd -P`).
          if (typeof j.worktree === 'string' && isAbsolute(j.worktree)) worktree = j.worktree
          if (typeof j.updatedAt === 'string') updatedMs = Date.parse(j.updatedAt)
        } catch {
          /* corrupt → no worktree signal; age alone governs below */
        }
        if (worktree && (await pathExists(worktree))) continue // live workplace → keep
        // Age basis: the NEWEST of file mtime / the heartbeat's own updatedAt,
        // so either signal being fresh protects the file.
        const newest = Math.max(st.mtimeMs, Number.isNaN(updatedMs) ? 0 : updatedMs)
        if (now - newest > GHOST_HEARTBEAT_MS) {
          await unlink(full)
          report.removedFiles.push(full)
        }
      } catch {
        /* skip this file */
      }
    }
    try {
      // Empty apart from Finder droppings (same tolerance as effectivelyEmpty)
      // — sweep those, then rmdir. rmdir refuses non-empty, so a heartbeat
      // written between the check and here survives (the dir just stays).
      const rest = await readdir(dir)
      if (rest.every((e) => e === '.DS_Store')) {
        for (const e of rest) await unlink(join(dir, e))
        await rmdir(dir)
        report.removedDirs.push(dir)
      }
    } catch {
      /* keep — non-empty or racing writer */
    }
  }
  return report
}

export interface OrphanWorktreeSweepReport {
  /** Orphan dirs deleted (provably zero uncommitted work: effectively empty). */
  removed: string[]
  /** Orphan dirs kept — uncommitted work possible or unjudgeable. */
  warned: string[]
}

/** `git worktree list --porcelain` as a set of canonical paths; null when the
 *  repo is gone / not a git repo. */
const worktreeListPaths = async (repoPath: string): Promise<Set<string> | null> => {
  const out = await git(repoPath, ['worktree', 'list', '--porcelain'])
  if (out === null) return null
  const set = new Set<string>()
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) set.add(await canonicalize(line.slice('worktree '.length).trim()))
  }
  return set
}

/** The only state where "zero uncommitted work" is provable WITHOUT git
 *  metadata: nothing beyond the `.git` gitfile and Finder droppings. A `.git`
 *  DIRECTORY is a whole embedded repo (worktrees carry a gitfile, never a
 *  dir) — possibly corrupt-but-real history, so it makes the dir non-empty. */
const effectivelyEmpty = async (dir: string): Promise<boolean> => {
  const entries = await readdir(dir, { withFileTypes: true })
  return entries.every(
    (e) => (e.name === '.git' && !e.isDirectory()) || e.name === '.DS_Store',
  )
}

/** (c) Sweep orphaned central worktree dirs (~/.openground/projects/<uuid>/
 *  worktrees/*). Scoped to REGISTERED uuids only — an unregistered uuid's data
 *  belongs to (d), which never deletes. */
export const pruneOrphanCentralWorktrees = async (): Promise<OrphanWorktreeSweepReport> => {
  const report: OrphanWorktreeSweepReport = { removed: [], warned: [] }
  const settings = await getSettings().catch(() => null)
  if (!settings) return report
  const byId = new Map((settings.projects ?? []).map((p) => [p.id, p.path]))
  let uuids
  try {
    uuids = await readdir(projectsDataRootDir(), { withFileTypes: true })
  } catch {
    return report
  }
  for (const u of uuids) {
    if (!u.isDirectory()) continue
    const repoPath = byId.get(u.name)
    if (!repoPath) continue // unregistered → (d) reports it; contents untouched
    let dirs
    try {
      dirs = await readdir(centralWorktreesDir(u.name), { withFileTypes: true })
    } catch {
      continue // no worktrees dir → nothing to do
    }
    const listed = await worktreeListPaths(repoPath) // null → repo itself is gone
    for (const d of dirs) {
      if (!d.isDirectory()) continue
      const full = join(centralWorktreesDir(u.name), d.name)
      try {
        const canon = await canonicalize(full)
        if (listed?.has(canon)) continue // listed by the repo → live, keep
        // Orphan candidate. If its own git metadata still resolves to THIS dir
        // it is a live worktree of some OTHER repo — unjudgeable, keep. (Live
        // metadata of the registered repo would have been in `listed`; the
        // toplevel comparison also defends against git walking UP out of a
        // metadata-less dir to some ancestor repo.)
        const top = await git(full, ['rev-parse', '--show-toplevel'])
        if (top !== null && (await canonicalize(top.trim())) === canon) {
          report.warned.push(full)
          continue
        }
        // Git metadata is dead — a true orphan. Delete only when zero
        // uncommitted work is PROVABLE (effectively empty); else keep + warn.
        if (await effectivelyEmpty(full)) {
          await rm(full, { recursive: true, force: true })
          report.removed.push(full)
        } else {
          report.warned.push(full)
        }
      } catch {
        report.warned.push(full)
      }
    }
  }
  if (report.warned.length) {
    console.warn(
      `[retention] kept ${report.warned.length} orphan central worktree dir(s) — uncommitted work possible/unjudgeable, remove manually: ${report.warned.join(', ')}`,
    )
  }
  return report
}

/** (d) Central data dirs whose uuid is NOT in the registry: detected and
 *  warned (one line), NEVER auto-deleted — "Remove from canvas" leftovers may
 *  still be wanted by the user. */
export const findOrphanCentralDataDirs = async (): Promise<string[]> => {
  const settings = await getSettings().catch(() => null)
  if (!settings) return []
  const registered = new Set((settings.projects ?? []).map((p) => p.id))
  let uuids
  try {
    uuids = await readdir(projectsDataRootDir(), { withFileTypes: true })
  } catch {
    return []
  }
  const orphans = uuids
    .filter((u) => u.isDirectory() && !registered.has(u.name))
    .map((u) => u.name)
  if (orphans.length) {
    console.warn(
      `[retention] ${orphans.length} central data dir(s) not in the registry (NOT auto-deleted): ${orphans.join(', ')}`,
    )
  }
  return orphans
}

export interface CrossRepoResidueReport {
  heartbeats: GhostHeartbeatSweepReport
  worktrees: OrphanWorktreeSweepReport
  orphanDataDirs: string[]
}

/** The boot-time cross-repo residue sweep. Worktrees first — a workplace
 *  removed by (c) lets (a) reap its already-old heartbeat in the same boot. */
export const sweepCrossRepoResidue = async (
  opts: { now?: number } = {},
): Promise<CrossRepoResidueReport> => {
  const worktrees = await pruneOrphanCentralWorktrees()
  const heartbeats = await pruneGhostHeartbeats(opts)
  const orphanDataDirs = await findOrphanCentralDataDirs()
  return { heartbeats, worktrees, orphanDataDirs }
}

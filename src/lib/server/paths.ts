import { homedir } from 'os'
import { join } from 'path'
import { mkdir, rename, stat, unlink } from 'fs/promises'

// The OPEN GROUND home directory. Defaults to ~/.openground but can be
// redirected via the OPENGROUND_HOME env var. Tests set OPENGROUND_HOME to a
// throwaway tmp dir (see src/test/setup-home.ts) so the suite never reads or
// writes the real ~/.openground — a regression that once let `dismiss all`
// wipe a user's actual run history during a test run.
export const openGroundHome = () => process.env.OPENGROUND_HOME || join(homedir(), '.openground')

export const settingsFile = () => join(openGroundHome(), 'settings.json')
export const canvasFile = () => join(openGroundHome(), 'canvas.json')
// The OPTIONAL app-account session (Supabase Auth tokens). Written 0600 by
// src/lib/server/authStore.ts. This is the APP's own login — NOT the Claude CLI
// subscription token — and it gates nothing today (see docs/BILLING_PLAN.md).
export const authFile = () => join(openGroundHome(), 'auth.json')
export const runsDir = () => join(openGroundHome(), 'runs')
export const runFile = (id: string) => join(runsDir(), `${id}.json`)
// Dismissed runs are *moved* here rather than unlinked, so an accidental
// "dismiss all" is recoverable. Real deletion happens only via explicit purge.
export const runsArchiveDir = () => join(openGroundHome(), 'runs-archive')
export const pasteDir = () => join(openGroundHome(), 'paste')

// ─── Per-project central data store ─────────────────────────────────────────
// Each registered project's OPEN GROUND data (tasks, journal, doc, canvases,
// images, attachments, verify-logs, worktrees) lives centrally under
// ~/.openground/projects/<projectUUID>/ — NOT inside the user's repo, so a
// scanned project's working tree stays free of OPEN GROUND files (mirrors how
// Claude Code keeps per-project state under ~/.claude/projects/, never in the
// repo). The UUID is the registry entry id (stable across rename/move). The
// path→UUID resolution lives in projectDataPath.ts (it needs the registry);
// these are the pure builders shared by that resolver, worktree.ts and the
// security boundary so they cannot drift.
export const projectsDataRootDir = () => join(openGroundHome(), 'projects')
export const projectCentralDir = (uuid: string) => join(projectsDataRootDir(), uuid)
export const centralWorktreesDir = (uuid: string) => join(projectCentralDir(uuid), 'worktrees')

// Launcher / single-instance bootstrap files. The launcher and the Next
// server both read these to coordinate "is a server already up, and is it
// *this* checkout's server?" — see scripts/openground-launch.sh and
// /api/health. Kept here so every reader agrees on the canonical paths.
export const serverStatePath = () => join(openGroundHome(), 'server.json')
export const serverLockDir = () => join(openGroundHome(), 'bootstrap.lock')
export const serverLogPath = () => join(openGroundHome(), 'server.log')

// One-shot migration from old codenames. Runs at most once per process (the
// homeReady promise caches), and only renames if a legacy folder exists *and*
// the new one does not — never clobbers a real ~/.openground. Walks the
// lineage `.pmmap` → `.hove` → `.openground` so users on either earlier
// codename get carried forward in one hop.
let homeReady: Promise<void> | null = null
export const ensureOpenGroundHome = async () => {
  homeReady ??= (async () => {
    const fresh = openGroundHome()
    if (!(await exists(fresh))) {
      // Prefer the most recent codename if both exist.
      for (const legacyName of ['.hove', '.pmmap']) {
        const legacy = join(homedir(), legacyName)
        if (await exists(legacy)) {
          try {
            await rename(legacy, fresh)
            break
          } catch {
            // Fall through to plain mkdir below — the user can move by hand.
          }
        }
      }
    }
    await mkdir(fresh, { recursive: true })
    // The pre-server.json launcher tracked PID and port in separate dotfiles.
    // server.json (atomic, ready-gated) replaces them — sweep the legacy
    // sidecars on every boot so a downgrade-then-upgrade can't leave a stale
    // PID/port floating next to the new state file. Idempotent: ENOENT means
    // "already gone, nothing to do."
    for (const legacy of ['server.pid', 'server.port']) {
      try {
        await unlink(join(fresh, legacy))
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          // Permission or other unexpected error — surface it; if we can't
          // clean these up, the launcher's state model is already corrupt.
          throw err
        }
      }
    }
  })()
  return homeReady
}

export const ensureRunsDir = async () => {
  await ensureOpenGroundHome()
  await mkdir(runsDir(), { recursive: true })
}

export const ensureRunsArchiveDir = async () => {
  await ensureOpenGroundHome()
  await mkdir(runsArchiveDir(), { recursive: true })
}

export const ensurePasteDir = async () => {
  await ensureOpenGroundHome()
  await mkdir(pasteDir(), { recursive: true })
}

const exists = async (p: string) => {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

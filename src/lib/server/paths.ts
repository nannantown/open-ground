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
// In-app notification READ-STATE (the Ground お知らせ bell). A tiny home-cache
// file holding the ids the user has already seen, so unread state survives a
// re-login (server-side, not localStorage). The notification CONTENT comes from
// per-kind sources (today: GET /api/collab/invites); this only tracks read/unread.
export const notificationsFile = () => join(openGroundHome(), 'notifications.json')
// The server-persisted FATAL swarm notifications (the in-app half of the
// escalation safety valve). Kept in its OWN file (not notifications.json, which
// holds only the read-state id set): these are notification CONTENT records the
// bell renders, capped to the newest few. See src/lib/server/swarmNotifications.ts.
export const swarmNotificationsFile = () => join(openGroundHome(), 'swarm-notifications.json')
// The Escalations inbox (C1, docs/OVERSEER_DESIGN.md §8): questions the swarm
// raised to the REAL user (irreversible / insufficient-info), waiting for their
// answer. UNCAPPED — an unanswered irreversible decision must never scroll off
// (fail-closed); resolved records are pruned by the boot retention sweep
// instead. See src/lib/server/swarmEscalations.ts.
export const escalationsFile = () => join(openGroundHome(), 'escalations.json')
// The swarm's model-quota COOLING TABLE (tier → reset epoch ms) — the persisted
// mirror of swarmQuota's in-memory table, so "fable is dry until 15:00" survives
// a restart / self-update instead of being re-learned by BURNING a session on the
// wall every time the app relaunches. Its OWN file, deliberately not a field in
// settings.json: (a) settings.json holds `projects`, the validateProjectPath
// allowlist — the security boundary — and this table is written from the engine's
// hot rate-limit sensor path, so a read-modify-write of that file on every
// sighting is needless blast radius; (b) a cooling mark is app STATE, not a user
// preference (the same rule that keeps notifications.json out of settings);
// (c) store.ts → swarmAllowedModels.ts → swarmQuota.ts already, so swarmQuota
// importing store.ts would be an import CYCLE. See swarmQuotaStore.ts.
export const swarmQuotaFile = () => join(openGroundHome(), 'swarm-quota.json')
// PTY-tail captures attached to escalations ("what the worker's screen showed
// when it got stuck") — one small text file per escalation, referenced by the
// record's screenshotRef and unlinked when the record is pruned.
export const escalationShotsDir = () => join(openGroundHome(), 'escalation-shots')
// The proxy's externalised JUDGMENT AXIS ("あなたの判断軸"). A single,
// self-describing markdown file assembled from CONCEPT.md + the OPEN GROUND
// auto-memory + hand-added judgments, written 0600 — it can be injected at proxy
// startup. PERSONAL data: it lives ONLY here under the app home, never inside a
// git repo (and is defensively gitignored). The growing hand-added judgments are
// kept beside it as a JSON array. See src/lib/server/youCorpus.ts and
// docs/YOU_CORPUS_PLAN.md.
export const youCorpusFile = () => join(openGroundHome(), 'you-corpus.md')
export const youCorpusAdditionsFile = () => join(openGroundHome(), 'you-corpus-additions.json')
export const runsDir = () => join(openGroundHome(), 'runs')
export const runFile = (id: string) => join(runsDir(), `${id}.json`)
// Dismissed runs are *moved* here rather than unlinked, so an accidental
// "dismiss all" is recoverable. Real deletion happens only via explicit purge.
export const runsArchiveDir = () => join(openGroundHome(), 'runs-archive')
export const pasteDir = () => join(openGroundHome(), 'paste')

// ─── Custom modules (user-built tabs) ────────────────────────────────────────
// Global (app-home) store for custom tab modules — one dir per module uuid,
// meta in a single index.json. See docs/CUSTOM_TABS_PLAN.md. Callers MUST
// validate the id (uuid regex + presence in the index) before building a path
// from it — these are pure joiners, not the security boundary.
export const customModulesRootDir = () => join(openGroundHome(), 'custom-modules')
export const customModulesIndexFile = () => join(customModulesRootDir(), 'index.json')
export const customModuleDir = (id: string) => join(customModulesRootDir(), id)
export const customModuleSourceFile = (id: string, framework: 'react' | 'html' = 'react') =>
  join(customModuleDir(id), framework === 'html' ? 'source.html' : 'source.tsx')

export const ensureCustomModulesDir = async () => {
  await ensureOpenGroundHome()
  await mkdir(customModulesRootDir(), { recursive: true })
}

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
// DEAD (kept only so an old build's import still resolves): NOTHING WRITES THIS.
// The deprecated shell launcher used to tee the server here; the Electron path
// pipes the forked server's stdout straight to Electron's own stdout instead
// (electron/main.js). So `~/.openground/server.log` does not exist on a real
// machine, and grepping it is a permanent FALSE NEGATIVE — a 2026-07-13 review
// caught a diagnostic doc doing exactly that. Don't cite it as a log source.
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

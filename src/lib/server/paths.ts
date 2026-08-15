import { homedir } from 'os'
import { join } from 'path'
import { mkdir, rename, stat, unlink } from 'fs/promises'
import { assertTestHomeIsolated } from './testHomeGuard'

// The OPEN GROUND home directory. Defaults to ~/.openground but can be
// redirected via the OPENGROUND_HOME env var. Tests set OPENGROUND_HOME to a
// throwaway tmp dir (see src/test/setup-home.ts) so the suite never reads or
// writes the real ~/.openground — a regression that once let `dismiss all`
// wipe a user's actual run history during a test run.
//
// THIS FUNCTION IS THE CHOKE POINT. Every path below is built from it, so the
// fail-closed fence sits here and nowhere else: under a test process the
// resolved home MUST canonicalize under the OS temp dir, or this throws — reads
// included. It is inert in production (see testHomeGuard.ts for the full
// contract and the 2026-07-18 incident that forced it).
//
// The env var is re-read per call BY DESIGN (tests re-point it per case), which
// is exactly why the check has to live at the resolution seam rather than at
// startup: the value can change between any two calls, and before the fence a
// single `delete process.env.OPENGROUND_HOME` silently retargeted every
// subsequent read AND write at the user's real ~/.openground.
//
// TWO FAILURE MODES, TWO CHECKS — and the second does NOT imply the first.
// An independent fix (M2) landed here first and guarded only the UNSET case:
// `if (!explicit && process.env.VITEST) throw`. Both halves are load-bearing:
//   • UNSET — the ~/.openground fallback aims every write at the user's real
//     data. Not hypothetical: a `npm test` run rewrote the live settings.json
//     with storeSettingsRace.test.ts's literals (archiveDirName '_arc',
//     projectsMigratedAt '2026-01-02T03:04:05.000Z'). Under vitest an unset
//     value can only mean a test cleared it, because src/test/setup-home.ts
//     always pins it — historically an afterEach doing `delete
//     process.env.OPENGROUND_HOME`, whose effect outlives its own file since
//     vitest reuses worker processes. This is also the leading explanation for
//     the 2026-07-18 registry loss: registry.test.ts and collabLink.test.ts
//     write `setSettings({ projects: [] })`, which against the real home empties
//     the registry and leaves only whatever entries that test then creates.
//   • SET, BUT AIMED AT REAL DATA — a non-empty value satisfies an unset-only
//     check while still resolving into ~/.openground (directly, or via a tmp
//     symlink pointing back at it), and so does a relative or whitespace-only
//     value. The destination check catches all of these.
//
// THE MERGE ORIGINALLY GOT THIS WRONG. It dropped the unset branch, reasoning
// that the destination check subsumes it ("unset → ~/.openground → outside tmp
// → throws"). Adversarial review refuted that on 2026-07-19 WITH A REPRODUCTION:
// seven test files re-pin process.env.HOME to a throwaway dir, and inside that
// window `join(homedir(), '.openground')` lands UNDER tmp, so every destination
// condition passes and an unset OPENGROUND_HOME resolved silently. No data was
// at risk (the fake home absorbed it) — but the DETECTION was gone, in exactly
// the configuration the contract claims is covered. `requireExplicitPin` keeps
// M2's half as its own condition instead of deriving it. Do not "simplify" it
// back: the derivation is false, and it reads true.
export const openGroundHome = () => {
  const home = process.env.OPENGROUND_HOME || join(homedir(), '.openground')
  assertTestHomeIsolated(home, 'openGroundHome()', { requireExplicitPin: true })
  return home
}

export const settingsFile = () => join(openGroundHome(), 'settings.json')
export const canvasFile = () => join(openGroundHome(), 'canvas.json')
// GENERATIONAL BACKUPS of the two irreplaceable home files above — the registry
// (settings.json `projects`, which is also the validateProjectPath allowlist)
// and the Ground card layout (canvas.json). One subdir per protected file; see
// src/lib/server/homeBackup.ts for the write hook and the pruning policy.
//
// WHY THIS EXISTS: on 2026-07-18 the registry shrank 45 → 3 entries and the card
// layout was lost. settings.json was recoverable ONLY because an orphaned
// `.settings.json.tmp-27332-1` from a crashed atomic write happened to still be
// lying in the home dir; canvas.json had no such luck and its card positions were
// gone for good. Recovery must not depend on that kind of accident.
export const backupsRootDir = () => join(openGroundHome(), 'backups')
// Integrity watermark — the "what the registry looked like last boot" record the
// startup damage check compares against, plus its already-alerted marker so a
// damaged file re-alerts once, not on every launch. Its OWN file, deliberately
// NOT a field in settings.json: this check must stay readable and writable when
// settings.json is the very thing that looks wrong, and a watermark is app STATE,
// not a user preference (the same rule that keeps notifications.json out of
// settings). See src/lib/server/homeIntegrity.ts.
export const integrityFile = () => join(openGroundHome(), 'integrity.json')
// The OPTIONAL app-account session (Supabase Auth tokens). Written 0600 by
// src/lib/server/authStore.ts. This is the APP's own login — NOT the Claude CLI
// subscription token — and it gates nothing today (see docs/BILLING_PLAN.md).
export const authFile = () => join(openGroundHome(), 'auth.json')
// Research-channel cookies (X auth_token/ct0 — Settings → Research channels).
// Written 0600 by src/lib/server/researchAuth.ts; values are LOCAL-ONLY by
// promise (the status API exposes booleans, never the values).
export const researchAuthFile = () => join(openGroundHome(), 'research-auth.json')
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
// Boot-history RING (card 2, docs/ENGINE_PERSISTENCE_PLAN.md §4-2): the
// crash-loop breaker's memory — {at, appVersion} per server boot, newest last,
// capped small. Global (not per-project): a boot is a process-wide event, and the
// breaker's question ("did THIS version just restart 3× in 10 minutes") is
// process-wide too. See src/lib/server/swarmEnginePersistence.ts.
export const engineBootsFile = () => join(openGroundHome(), 'engine-boots.json')
// PTY-tail captures attached to escalations ("what the worker's screen showed
// when it got stuck") — one small text file per escalation, referenced by the
// record's screenshotRef and unlinked when the record is pruned.
export const escalationShotsDir = () => join(openGroundHome(), 'escalation-shots')
// The daily fuel report's persisted sentinel (card swarm-token-blocked): the
// "already reported today" date, the analysis window's right edge, the previous
// summary (for the 前回比 line) and the open improvement-proposal card ref (the
// dedup guard). App STATE, not a preference — its own file for the same reasons
// as swarm-quota.json above. See src/lib/server/dailyFuelReport.ts.
export const dailyFuelReportFile = () => join(openGroundHome(), 'daily-fuel-report.json')
// The proxy's externalised JUDGMENT AXIS ("あなたの判断軸"). A single,
// self-describing markdown file assembled from CONCEPT.md + the OPEN GROUND
// auto-memory + hand-added judgments, written 0600 — it can be injected at proxy
// startup. PERSONAL data: it lives ONLY here under the app home, never inside a
// git repo (and is defensively gitignored). The growing hand-added judgments are
// kept beside it as a JSON array. See src/lib/server/youCorpus.ts and
// docs/YOU_CORPUS_PLAN.md.
export const youCorpusFile = () => join(openGroundHome(), 'you-corpus.md')
export const youCorpusAdditionsFile = () => join(openGroundHome(), 'you-corpus-additions.json')
// The INTERVIEW LOOP's once-a-day state (ペルソナタブの「今日の1問」). Holds the
// question asked on each local day plus the subject keys already covered, so the
// 1-question-a-day cap and the "never re-ask the same observation" rule both
// survive a restart. PERSONAL like the corpus itself (it quotes the owner's own
// board activity) — app home only, never a repo. The ANSWERS are not stored here:
// they go to the corpus through appendJudgment, which stays the single record.
// See src/lib/server/personaInterview.ts.
export const personaInterviewFile = () => join(openGroundHome(), 'persona-interview.json')
// The PERSONA COURSES store (ペルソナタブの診断コース): the last result per course
// plus the results a retake displaced (capped), written 0600. PERSONAL like the
// corpus and the interview state — app home only, never a repo. The instrument
// and its scoring stay pure in src/lib/persona/instruments.ts; only the outcome
// is stored here, and each finding is ALSO minted into the corpus through
// appendJudgment (one writer). See src/lib/server/personaCourses.ts.
export const personaCoursesFile = () => join(openGroundHome(), 'persona-courses.json')
// The DECISION LEDGER (ペルソナタブの「実際にやったこと」): one record per proxy-you
// decision — the stand-in answered on the owner's behalf, handed the question back
// to them, or abstained — plus the owner's later answer when one of those questions
// came back answered. The COMPLEMENT of persona-courses.json: that file is what the
// owner SAYS about themselves (self-report), this one is what their stand-in DID
// against real work, and the said-vs-did gap only exists because both are kept.
// PERSONAL like the corpus and the courses beside it — app home only, never a repo,
// 0600, and no route hands its free text to a non-loopback caller. CAPPED to the
// newest N (unlike escalations.json, which must never lose an open question): a
// dropped ledger row costs a statistic, not a decision. See
// src/lib/server/personaLedger.ts.
export const personaLedgerFile = () => join(openGroundHome(), 'persona-ledger.json')
// The IMPORT LEDGER for claude.ai data exports (dropping conversations.json onto
// the persona conversation). One record per file that has ALREADY been distilled
// into the corpus, keyed by the sha256 of the file's bytes, written 0600.
// It exists for one reason: ManualJudgment has NO idempotency key, so importing
// the same export twice would append every distilled line a second time —
// doubling the node count and the lit points on the figure, with no way to tell
// the copies apart afterwards in an append-only store. A known sha is REFUSED
// with an explicit message rather than silently merged. PERSONAL like the corpus
// beside it — app home only, never a repo. See src/lib/server/personaImport.ts.
export const personaImportsFile = () => join(openGroundHome(), 'persona-imports.json')
// Working dirs for persona conversation runs — ONE per conversation, reused
// across its turns (`--resume` resolves a session against the dir it started
// in). Under the app home rather than os.tmpdir() so retention can reach them
// and so they stay off macOS's /var/folders realpath. Each dir also earns a
// `hasTrustDialogAccepted` entry in ~/.claude.json, so a leftover here is TWO
// leaks, not one — swept at boot by retention.ts's sweepPersonaScratch.
export const personaScratchRootDir = () => join(openGroundHome(), 'persona-scratch')
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
  // EVICT ON REJECTION (see the .catch below). `??=` alone caches a REJECTED
  // promise forever: one throw — a transient FS error, or the test-home fence
  // firing on the first call — and every later ensureOpenGroundHome() in this
  // process re-rejects with the stale error, wedging every store read/write
  // even after the cause is fixed. registry.ts:39-42 already learned this
  // (it would "wedge GET /api/projects at 500 forever"); paths.ts had not.
  homeReady ??= (async () => {
    const fresh = openGroundHome()
    if (!(await exists(fresh))) {
      // Prefer the most recent codename if both exist.
      for (const legacyName of ['.hove', '.pmmap']) {
        const legacy = join(homedir(), legacyName)
        if (await exists(legacy)) {
          // FENCE THE SOURCE, NOT JUST THE DESTINATION. `fresh` is checked by
          // openGroundHome() above; `legacy` is a SECOND, homedir()-anchored
          // path that OPENGROUND_HOME cannot move — the same "the guard and the
          // writer read different env vars" asymmetry that caused 2026-07-18,
          // sitting inside the choke-point file itself.
          //
          // The failure it prevents: a test pins OPENGROUND_HOME at a tmp path
          // it never creates (swarmJanitor / swarmIntegrationLock /
          // swarmWorkerRegistry all do — this file's own fence comments name
          // them), so `exists(fresh)` is false, and this loop then MOVES the
          // user's real ~/.hove or ~/.pmmap into that tmpdir, where the test's
          // afterEach recursively deletes it. A rename, not a copy: the data is
          // simply gone.
          //
          // Asserted only INSIDE this branch, so the common case (no legacy dir
          // — neither exists on a modern machine) stays a no-op and unpinned
          // tests are not failed for a migration that would never have run. A
          // legitimate migration test that pins HOME to a tmpdir still passes.
          assertTestHomeIsolated(legacy, 'paths legacy migration (homedir()/<legacy>)')
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
  })().catch((err) => {
    homeReady = null // self-heal: the next call retries instead of re-throwing
    throw err
  })
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

import { readFile, copyFile, mkdir, rm } from 'fs/promises'
import { existsSync, realpathSync } from 'fs'
import { dirname, isAbsolute, join, relative, resolve } from 'path'
import { fileURLToPath } from 'url'
import { homedir } from 'os'
import { atomicWriteJson } from './atomicWrite'
import { openGroundHome } from './paths'
import { assertTestHomeIsolated } from './testHomeGuard'

// Idempotently install OPEN GROUND's Claude Code hook entries into the user's
// global ~/.claude/settings.json. The installer is a true upsert:
//
//   - Existing user-authored hooks (e.g. the user's `afplay Glass.aiff` Stop
//     hook) are NEVER touched. We add ours as additional sibling entries.
//   - Our entries are identified by the command path ending with
//     `openground-hook.js` / `openground-guard.js`. If present, the entry is
//     rewritten to the expected command — which also SELF-HEALS a poisoned
//     entry (one pointing at a deleted checkout/worktree) on the next install.
//   - A backup of the prior settings file is written before any change.
//
// Phases we install:
//   SessionStart   — write a "running" marker to ~/.openground/sessions/
//   Stop           — write a "turn-complete" marker + nudge OPEN GROUND
//   PostToolUse    — bump the marker's mtime (heartbeat)
//   PreToolUse     — openground-guard.js: the DETERMINISTIC deny veto (A3/L4)
//                    for guarded WORKER sessions (OPENGROUND_GUARD=1 only; an
//                    instant no-op for every other claude session — including
//                    the trusted SWARM_MANAGER=1 commander/supply). Wired
//                    per-tool (Bash/Write/Edit/MultiEdit/NotebookEdit).
//
// NEITHER script is run from the repo checkout: installHooks copies BOTH to
// stable dirs under the real home (~/.openground/guard/ + ~/.openground/hooks/)
// and wires THOSE paths. Two independent reasons:
//   - guard: the repo copy sits inside a worktree cwd a sandboxed worker may
//     write to; the installed copy is inside the sandbox profile's write-deny
//     (sandbox.ts) and the guard's OWN substrate deny, so a guarded claude
//     cannot rewrite its own veto.
//   - hook: the wired path must survive the SOURCE checkout disappearing. A
//     repo-resident path baked into the global settings breaks every claude
//     session with MODULE_NOT_FOUND the moment that checkout moves or a swarm
//     worktree is janitor-deleted (2026-07-12 and again 2026-07-14). With the
//     copy, whatever root the source resolution lands on, the GLOBAL settings
//     only ever reference the stable installed path — a volatile root can at
//     worst refresh the copy's CONTENT, never the wiring.
//
// The installer is intended to be called once at server start. Run cost is
// trivial (a read, a maybe-write, a backup), so a re-install on every boot
// is fine — and it lets us recover automatically if the user moved the
// project folder.

const PHASES = ['SessionStart', 'Stop', 'PostToolUse'] as const
type Phase = (typeof PHASES)[number]
type InstallSlot = Phase | 'PreToolUse'
const PHASE_TO_ARG: Record<Phase, string> = {
  SessionStart: 'session-start',
  Stop: 'stop',
  PostToolUse: 'post-tool-use',
}

// The tool set the guard vetoes. Bash for commands; the file-mutating tools so
// a guarded session can't write outside its roots (or onto the guard itself).
const GUARD_MATCHERS = ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'] as const

// ─── The homedir() anchor, fenced ────────────────────────────────────────────
// This module writes to the user's GLOBAL ~/.claude/settings.json and to
// ~/.openground/{hooks,guard} — anchored at homedir() ON PURPOSE (see the long
// note at hookInstallDir below), which means paths.openGroundHome()'s
// fail-closed fence does NOT cover them: OPENGROUND_HOME cannot move these.
// So the SAME fence (testHomeGuard.ts, one implementation, no second copy) is
// applied to this anchor too. Under a test process homedir() must be a tmpdir —
// i.e. the test pinned process.env.HOME — or every write target below throws
// before it can be built. Isolation here has always been per-file discipline
// (hooksInstall.test.ts:62 and swarmSafety.test.ts pin HOME; nothing forced
// them to), and installHooks() takes no arguments, so one uncovered caller
// would rewrite the user's real global Claude config. Inert in production.
const guardedHomedir = (): string => {
  const h = homedir()
  assertTestHomeIsolated(h, 'hooksInstall (homedir-anchored)')
  return h
}

const settingsPath = () => join(guardedHomedir(), '.claude', 'settings.json')
const backupPath = () => join(guardedHomedir(), '.claude', 'settings.json.openground.bak')

// ─── Hook source resolution (cwd-INDEPENDENT) ────────────────────────────────
// The wired hook commands carry ABSOLUTE paths into the user's GLOBAL
// ~/.claude/settings.json, so the base they resolve from must never be
// process.cwd(): a server booted with its cwd inside a swarm worker's
// worktree (~/.openground/projects/<uuid>/worktrees/<x> — e.g. a `npm run
// dev:alt` started there for verification) used to bake that worktree's
// path into the global settings, and the janitor deleting the worktree later
// broke EVERY claude session's Stop hook with MODULE_NOT_FOUND (observed
// 2026-07-12). Resolution is anchored at THIS MODULE's location instead,
// walking up to the first dir that holds both hook scripts — the app
// checkout in dev/vitest (src/lib/server → root) and the packaged app root
// in prod (server/dist → root; scripts/ ships via electron-builder `files`).
//
// Belt-and-braces: even a module-anchored root is REFUSED when it sits under
// the OPEN GROUND data home — an engine running FROM a swarm worktree must
// degrade to "hooks not (re)installed" (installHooks reports via
// result.errors and writes NOTHING; verifyGuardWiring stays NOT-ok so worker
// spawns refuse) rather than wire a global path the janitor deletes.
//
// The refusal checks BOTH homes: openGroundHome() (honours the
// OPENGROUND_HOME redirect) AND the literal ~/.openground under the real
// homedir(). They differ exactly when a process redirects OPENGROUND_HOME —
// e.g. a worker verifying its branch with `OPENGROUND_HOME=$(mktemp -d) node
// server/dist/index.cjs` from its worktree (observed 2026-07-14). That
// redirect moved the refusal prefix to /tmp while settingsPath() (homedir-
// based) kept pointing at the REAL ~/.claude/settings.json, so the worktree
// root sailed past the check and got wired globally. The guard prefix must
// live in the same homedir()-anchored world as the file it protects.

// This module's dir under both module systems it runs in: CJS (tsx dev on
// this type-less package, and the esbuild CJS bundle) has __dirname; ESM
// (vitest's transform) has import.meta.url. In the CJS bundle the
// import.meta branch is dead code behind the __dirname guard (esbuild lowers
// it to undefined — warning silenced in scripts/build-server.js).
const realModuleDir = (): string => {
  if (typeof __dirname !== 'undefined') return __dirname
  return dirname(fileURLToPath(import.meta.url))
}

// Test seam: aims the resolver at a fake "engine running inside a worktree"
// layout. null = use the real module location.
let moduleDirOverride: string | null = null
export const __setHookSourceModuleDirForTests = (dir: string | null): void => {
  moduleDirOverride = dir
}

// realpath when the path exists (symlinks must not defeat the prefix check
// below), plain resolve otherwise.
const canonical = (p: string): string => {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

const isUnder = (child: string, parent: string): boolean => {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export interface HookSourceRoot {
  /** App root holding scripts/openground-hook.js + openground-guard.js, or null. */
  root: string | null
  /** Why root is null; null iff root is set. */
  problem: string | null
}

export const resolveHookSourceRoot = (): HookSourceRoot => {
  const start = moduleDirOverride ?? realModuleDir()
  let dir = canonical(start)
  for (;;) {
    if (
      existsSync(join(dir, 'scripts', 'openground-hook.js')) &&
      existsSync(join(dir, 'scripts', 'openground-guard.js'))
    ) {
      // Canonicalize the HIT itself (it exists, so realpath always resolves) —
      // not just the walk start: a symlinked path (e.g. macOS /var →
      // /private/var) must not slip past the volatile-home prefix check.
      const root = canonical(dir)
      const volatileHomes = [canonical(openGroundHome()), canonical(join(homedir(), '.openground'))]
      for (const home of volatileHomes) {
        if (isUnder(root, home)) {
          return {
            root: null,
            problem:
              `refusing hook source root ${root}: it sits under the OPEN GROUND data home (${home}) — ` +
              'swarm worktrees there are transient (the janitor deletes them), and a global hook wired ' +
              'to such a path breaks every claude session once it is gone',
          }
        }
      }
      return { root, problem: null }
    }
    const parent = dirname(dir)
    if (parent === dir) {
      return {
        root: null,
        problem: `scripts/openground-hook.js + openground-guard.js not found in any dir at or above ${start}`,
      }
    }
    dir = parent
  }
}

// Install dirs are ANCHORED AT homedir() ON PURPOSE — not openGroundHome().
// settings.json lives under homedir() (~/.claude), so the scripts its hook
// commands point at must resolve from the SAME anchor: an OPENGROUND_HOME
// redirect (tests, isolated verification servers) must never move where the
// REAL global settings' hook targets live. Do not "unify" these onto
// openGroundHome() — that asymmetry is what the 2026-07-14 incident exploited
// in the opposite direction (refusal prefix moved, write target didn't).
const hookSourcePath = (root: string): string => join(root, 'scripts', 'openground-hook.js')
const guardSourcePath = (root: string): string => join(root, 'scripts', 'openground-guard.js')
const hookInstallDir = (): string => join(guardedHomedir(), '.openground', 'hooks')
const hookInstalledPath = (): string => join(hookInstallDir(), 'openground-hook.js')
const guardInstallDir = (): string => join(guardedHomedir(), '.openground', 'guard')
const guardInstalledPath = (): string => join(guardInstallDir(), 'openground-guard.js')

const isOurEntry = (entry: any): boolean => {
  if (!entry || typeof entry !== 'object') return false
  const hs = entry.hooks
  if (!Array.isArray(hs)) return false
  return hs.some((h: any) => typeof h?.command === 'string' && h.command.includes('openground-hook.js'))
}

const isOurGuardEntry = (entry: any): boolean => {
  if (!entry || typeof entry !== 'object') return false
  const hs = entry.hooks
  if (!Array.isArray(hs)) return false
  return hs.some((h: any) => typeof h?.command === 'string' && h.command.includes('openground-guard.js'))
}

const buildEntry = (phase: Phase, scriptAbsPath: string) => ({
  matcher: '',
  hooks: [
    {
      type: 'command',
      // Invoke node explicitly rather than relying on the script's unix
      // shebang + exec bit. Windows has no shebang, so a bare
      // `<path>/openground-hook.js stop` command would silently never fire
      // (cmd.exe / PowerShell can't execute a .js as a program). `node
      // "<path>" <arg>` works identically on macOS/Linux (the shebang line is
      // just a `// ` comment to node) and on Windows. The path is quoted so it
      // survives spaces. `node` is on PATH wherever the user's `claude` CLI
      // runs, which is the only environment these hooks ever execute in.
      command: `node ${quoteForShell(scriptAbsPath)} ${PHASE_TO_ARG[phase]}`,
    },
  ],
})

const buildGuardEntry = (matcher: string, guardAbsPath: string) => ({
  matcher,
  hooks: [
    {
      type: 'command',
      // Same explicit-`node` reasoning as buildEntry. No argv argument: the
      // guard reads the tool payload from stdin and dispatches on tool_name.
      command: `node ${quoteForShell(guardAbsPath)}`,
    },
  ],
})

// Shell-quote a path for use in a settings.json command string. The hook
// runner evaluates the command via a shell (/bin/sh on POSIX, cmd.exe on
// Windows) per Claude Code's hook spec, so spaces in the absolute path need to
// be quoted. The installing machine is the machine that will run the hook, so
// we quote for the host shell:
//   - POSIX: single quotes (no expansion), `'\''` idiom for embedded quotes.
//   - Windows: double quotes (cmd.exe / PowerShell don't honour single quotes
//     as string delimiters for argv), with embedded `"` escaped as `""`.
//     Windows paths can't contain `"` in practice, so this is belt-and-braces.
const quoteForShell = (p: string): string => {
  if (process.platform === 'win32') {
    if (/^[A-Za-z0-9_\-\\:.]+$/.test(p)) return p
    return `"${p.replace(/"/g, '""')}"`
  }
  if (/^[A-Za-z0-9_\-\/.]+$/.test(p)) return p
  return `'${p.replace(/'/g, "'\\''")}'`
}

export interface InstallResult {
  installed: InstallSlot[] // phases where we added a new entry this run
  refreshed: InstallSlot[] // phases where our existing entry was rewritten
  unchanged: InstallSlot[] // phases that were already correct
  backupPath: string | null
  errors: string[]
}

export const installHooks = async (): Promise<InstallResult> => {
  const result: InstallResult = {
    installed: [],
    refreshed: [],
    unchanged: [],
    backupPath: null,
    errors: [],
  }

  // Resolve (and safety-check) the hook source BEFORE touching anything: a
  // null root means there is nothing safe to wire, so the installer must
  // write NOTHING — neither settings.json nor the guard copy.
  const source = resolveHookSourceRoot()
  if (source.root === null) {
    result.errors.push(source.problem ?? 'hook source root unresolved')
    return result
  }

  const settingsFile = settingsPath()
  let raw = '{}'
  try {
    if (existsSync(settingsFile)) {
      raw = await readFile(settingsFile, 'utf8')
    }
  } catch (e: any) {
    result.errors.push(`read settings: ${e?.message ?? e}`)
    return result
  }

  let settings: any
  try {
    settings = JSON.parse(raw)
  } catch (e: any) {
    result.errors.push(`parse settings: ${e?.message ?? e}`)
    return result
  }
  if (!settings || typeof settings !== 'object') settings = {}
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {}

  const hookSrc = hookSourcePath(source.root)
  if (!existsSync(hookSrc)) {
    result.errors.push(`hook script not found at ${hookSrc}`)
    return result
  }

  // Copy the hook OUT of the checkout before wiring anything — the wired
  // command must point at the stable ~/.openground/hooks/ copy, never at the
  // resolved source root (see the header: a checkout/worktree path baked into
  // the GLOBAL settings dies with its checkout). Wire only if the copy landed:
  // fail-closed like the guard, so settings.json never references a path that
  // is not known to exist. On copy failure existing entries are left alone —
  // a stale-but-present target beats a freshly wired missing one.
  let dirty = false
  try {
    await mkdir(hookInstallDir(), { recursive: true })
    await copyFile(hookSrc, hookInstalledPath())
  } catch (e: any) {
    result.errors.push(`hook copy failed: ${e?.message ?? e}`)
    return result
  }

  // Decide changes per phase WITHOUT touching the file yet, so we can write
  // backup + new settings atomically. This is also the SELF-HEAL path: any
  // existing entry of ours whose command differs from the expected one — e.g.
  // a poisoned entry still pointing into a deleted worktree (2026-07-14), or
  // a user's manual repair pointing at a repo checkout — is rewritten to the
  // stable installed path, and accidental duplicates are collapsed to one.
  for (const phase of PHASES) {
    const arr: any[] = Array.isArray(settings.hooks[phase]) ? settings.hooks[phase] : []
    const ourIdxs = arr.reduce<number[]>((acc, e, i) => (isOurEntry(e) ? [...acc, i] : acc), [])
    const desired = buildEntry(phase, hookInstalledPath())
    if (ourIdxs.length === 0) {
      arr.push(desired)
      settings.hooks[phase] = arr
      result.installed.push(phase)
      dirty = true
    } else {
      let touched = false
      const desiredCommand = desired.hooks[0].command
      const actualCommand = arr[ourIdxs[0]]?.hooks?.[0]?.command
      if (actualCommand !== desiredCommand) {
        arr[ourIdxs[0]] = desired
        touched = true
      }
      for (const i of ourIdxs.slice(1).reverse()) {
        arr.splice(i, 1)
        touched = true
      }
      if (touched) {
        settings.hooks[phase] = arr
        result.refreshed.push(phase)
        dirty = true
      } else {
        result.unchanged.push(phase)
      }
    }
  }

  // PreToolUse guard (A3/L4). Copy the guard OUT of the repo first — the wired
  // command must point at ~/.openground/guard/, which the sandbox profile
  // write-denies (a repo/worktree copy would be writable by the very session
  // the guard is vetoing). Wire only if the copy landed: a wired-but-missing
  // script would make the hook fail as a NON-blocking error — i.e. silently
  // stop vetoing — which is the exit-1 trap this guard exists to avoid.
  const guardSrc = guardSourcePath(source.root)
  if (!existsSync(guardSrc)) {
    result.errors.push(`guard script not found at ${guardSrc}`)
  } else {
    let guardCopied = false
    try {
      await mkdir(guardInstallDir(), { recursive: true })
      await copyFile(guardSrc, guardInstalledPath())
      guardCopied = true
    } catch (e: any) {
      result.errors.push(`guard copy failed: ${e?.message ?? e}`)
    }
    if (guardCopied) {
      const arr: any[] = Array.isArray(settings.hooks.PreToolUse) ? settings.hooks.PreToolUse : []
      let slotTouched: 'installed' | 'refreshed' | null = null
      for (const matcher of GUARD_MATCHERS) {
        const desired = buildGuardEntry(matcher, guardInstalledPath())
        const ourIdx = arr.findIndex((e: any) => isOurGuardEntry(e) && e?.matcher === matcher)
        if (ourIdx < 0) {
          arr.push(desired)
          slotTouched = 'installed'
          dirty = true
        } else if (arr[ourIdx]?.hooks?.[0]?.command !== desired.hooks[0].command) {
          arr[ourIdx] = desired
          if (slotTouched !== 'installed') slotTouched = 'refreshed'
          dirty = true
        }
      }
      settings.hooks.PreToolUse = arr
      if (slotTouched) result[slotTouched].push('PreToolUse')
      else result.unchanged.push('PreToolUse')
    }
  }

  if (!dirty) return result

  // Ensure ~/.claude exists before the atomic write — on a fresh machine (or the
  // boot install running before the user has ever launched `claude`) the dir may
  // not exist yet, and atomicWriteJson does not create the parent. Without this
  // the write ENOENTs and the guard silently never installs.
  try {
    await mkdir(join(guardedHomedir(), '.claude'), { recursive: true })
  } catch (e: any) {
    result.errors.push(`ensure ~/.claude: ${e?.message ?? e}`)
  }

  // Backup, then write.
  try {
    if (existsSync(settingsFile)) {
      await copyFile(settingsFile, backupPath())
      result.backupPath = backupPath()
    }
  } catch (e: any) {
    result.errors.push(`backup failed: ${e?.message ?? e}`)
    // Continue anyway — a missing backup is preferable to leaving the user
    // stuck without our hooks. The original content is still in their
    // file system journal.
  }

  try {
    await atomicWriteJson(settingsFile, settings)
  } catch (e: any) {
    result.errors.push(`write settings: ${e?.message ?? e}`)
  }

  return result
}

// ─── L4 wiring verification (GAP-2: the spawn-time fail-closed gate) ─────────
// Claude Code fails a MISSING PreToolUse hook OPEN (a non-exit-2 hook is
// non-blocking), so "the guard exists in the repo" proves nothing about a live
// session — only the WIRING does: the settings.json entries AND the installed
// guard body they point at. verifyGuardWiring re-derives both from disk and
// compares against what installHooks would write, so installer and verifier can
// never drift apart (same buildGuardEntry / same paths).
//
// STRICT READER — deliberately the opposite of this codebase's tolerant-read
// convention: ANY failure (ENOENT, EACCES, JSON parse, a matcher's entry
// missing, a byte mismatch against the expected guard version) is a problem,
// never a silent default. A fail-closed gate built on a tolerant reader is
// fail-open in disguise (the catch "recovers" exactly the state the gate exists
// to refuse), so nothing here may grow a `.catch(() => ok)`.

export interface GuardWiringCheck {
  ok: boolean
  /** Human-readable wiring problems; empty iff `ok`. */
  problems: string[]
}

export const verifyGuardWiring = async (): Promise<GuardWiringCheck> => {
  const problems: string[] = []

  // (1) The EXPECTED guard version = the repo/app copy under <appRoot>/scripts/,
  //     resolved module-anchored + volatile-root-refused exactly like the
  //     installer (same resolveHookSourceRoot — installer and verifier cannot
  //     drift, and a worktree-resident source is never accepted as "expected").
  //     Unresolvable/unreadable ⇒ "expected" is undefined ⇒ NOT verified.
  let source: Buffer | null = null
  const sourceRoot = resolveHookSourceRoot()
  if (sourceRoot.root === null) {
    problems.push(sourceRoot.problem ?? 'hook source root unresolved')
  } else {
    try {
      source = await readFile(guardSourcePath(sourceRoot.root))
    } catch (e: any) {
      problems.push(
        `guard source unreadable at ${guardSourcePath(sourceRoot.root)}: ${e?.message ?? e}`,
      )
    }
  }

  // (2) The INSTALLED guard body (~/.openground/guard/ — what the hook command
  //     actually executes) must exist and byte-match the expected version.
  try {
    const installed = await readFile(guardInstalledPath())
    if (source && !installed.equals(source)) {
      problems.push(
        `installed guard at ${guardInstalledPath()} differs from the expected version`,
      )
    }
  } catch (e: any) {
    problems.push(`installed guard unreadable at ${guardInstalledPath()}: ${e?.message ?? e}`)
  }

  // (3) settings.json must exist, parse, and carry our PreToolUse entry with the
  //     EXACT expected command for EVERY guarded tool — a partial wiring (say,
  //     Bash guarded but Write not) is still an escape hatch, so it fails whole.
  try {
    const raw = await readFile(settingsPath(), 'utf8')
    const settings = JSON.parse(raw)
    const arr = settings?.hooks?.PreToolUse
    for (const matcher of GUARD_MATCHERS) {
      const desired = buildGuardEntry(matcher, guardInstalledPath()).hooks[0].command
      const entry = Array.isArray(arr)
        ? arr.find((e: any) => isOurGuardEntry(e) && e?.matcher === matcher)
        : undefined
      if (!entry) {
        problems.push(`PreToolUse[${matcher}]: guard hook entry missing from settings.json`)
      } else if (entry?.hooks?.[0]?.command !== desired) {
        problems.push(`PreToolUse[${matcher}]: guard hook command differs from the expected wiring`)
      }
    }
  } catch (e: any) {
    problems.push(`settings.json unreadable/unparsable at ${settingsPath()}: ${e?.message ?? e}`)
  }

  return { ok: problems.length === 0, problems }
}

/** Verify the L4 wiring, self-healing ONCE through the idempotent installHooks()
 *  when it doesn't hold (covers "the user deleted the guard dir / boot install
 *  raced" without a restart). The verdict is always a fresh READ-BACK — the
 *  install's own result is never trusted as proof. Callers gate on `ok` and must
 *  refuse their spawn when it is false. */
export const ensureGuardWiring = async (): Promise<GuardWiringCheck> => {
  const first = await verifyGuardWiring()
  if (first.ok) return first
  try {
    await installHooks()
  } catch {
    // installHooks reports failures via result.errors rather than throwing;
    // belt-and-braces — the re-verify below is what decides either way.
  }
  return verifyGuardWiring()
}

// Uninstall — removes OPEN GROUND's hook entries while preserving siblings.
// Provided so users can opt out cleanly from a Settings panel toggle.
export const uninstallHooks = async (): Promise<InstallResult> => {
  const result: InstallResult = {
    installed: [],
    refreshed: [],
    unchanged: [],
    backupPath: null,
    errors: [],
  }
  const settingsFile = settingsPath()
  if (!existsSync(settingsFile)) return result

  let raw = ''
  try { raw = await readFile(settingsFile, 'utf8') } catch (e: any) {
    result.errors.push(`read: ${e?.message ?? e}`)
    return result
  }
  let settings: any
  try { settings = JSON.parse(raw) } catch (e: any) {
    result.errors.push(`parse: ${e?.message ?? e}`)
    return result
  }
  if (!settings?.hooks) return result

  let dirty = false
  for (const phase of PHASES) {
    const arr: any[] = settings.hooks[phase]
    if (!Array.isArray(arr)) continue
    const filtered = arr.filter((e) => !isOurEntry(e))
    if (filtered.length !== arr.length) {
      if (filtered.length === 0) delete settings.hooks[phase]
      else settings.hooks[phase] = filtered
      dirty = true
    }
  }
  // PreToolUse guard entries + the installed guard/hook copies.
  {
    const arr: any[] = settings.hooks.PreToolUse
    if (Array.isArray(arr)) {
      const filtered = arr.filter((e) => !isOurGuardEntry(e))
      if (filtered.length !== arr.length) {
        if (filtered.length === 0) delete settings.hooks.PreToolUse
        else settings.hooks.PreToolUse = filtered
        dirty = true
      }
    }
    try {
      await rm(guardInstalledPath(), { force: true })
    } catch (e: any) {
      result.errors.push(`guard remove failed: ${e?.message ?? e}`)
    }
    try {
      await rm(hookInstalledPath(), { force: true })
    } catch (e: any) {
      result.errors.push(`hook remove failed: ${e?.message ?? e}`)
    }
  }
  if (!dirty) return result

  try {
    await copyFile(settingsFile, backupPath())
    result.backupPath = backupPath()
  } catch {}
  try {
    await atomicWriteJson(settingsFile, settings)
  } catch (e: any) {
    result.errors.push(`write: ${e?.message ?? e}`)
  }
  return result
}

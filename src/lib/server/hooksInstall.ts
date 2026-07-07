import { readFile, copyFile, mkdir, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { atomicWriteJson } from './atomicWrite'

// Idempotently install OPEN GROUND's Claude Code hook entries into the user's
// global ~/.claude/settings.json. The installer is a true upsert:
//
//   - Existing user-authored hooks (e.g. the user's `afplay Glass.aiff` Stop
//     hook) are NEVER touched. We add ours as additional sibling entries.
//   - Our entries are identified by the command path ending with
//     `openground-hook.js` / `openground-guard.js`. If present, the entry is
//     rewritten so the absolute path stays correct after the project folder is
//     moved.
//   - A backup of the prior settings file is written before any change.
//
// Phases we install:
//   SessionStart   — write a "running" marker to ~/.openground/sessions/
//   Stop           — write a "turn-complete" marker + nudge OPEN GROUND
//   PostToolUse    — bump the marker's mtime (heartbeat)
//   PreToolUse     — openground-guard.js: the DETERMINISTIC deny veto (A3/L4)
//                    for guarded sessions (OPENGROUND_GUARD=1 / SWARM_MANAGER=1;
//                    an instant no-op for every other claude session). Wired
//                    per-tool (Bash/Write/Edit/MultiEdit/NotebookEdit).
//
// The guard is NOT run from the repo checkout: installHooks copies it to
// ~/.openground/guard/ first and wires THAT path. The repo copy sits inside a
// worktree cwd a sandboxed worker may write to; the installed copy is inside
// the sandbox profile's write-deny (sandbox.ts) and the guard's OWN substrate
// deny, so a guarded claude cannot rewrite its own veto.
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

const settingsPath = () => join(homedir(), '.claude', 'settings.json')
const backupPath = () => join(homedir(), '.claude', 'settings.json.openground.bak')

const hookScriptPath = (): string => {
  // process.cwd() is the OPEN GROUND project root when running via
  // `npm run dev` or the bundled OPEN GROUND.app launcher. The script lives
  // alongside other dev scripts under <root>/scripts/.
  return join(process.cwd(), 'scripts', 'openground-hook.js')
}

const guardSourcePath = (): string => join(process.cwd(), 'scripts', 'openground-guard.js')
const guardInstallDir = (): string => join(homedir(), '.openground', 'guard')
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

  const scriptAbs = hookScriptPath()
  if (!existsSync(scriptAbs)) {
    result.errors.push(`hook script not found at ${scriptAbs}`)
    return result
  }

  // Decide changes per phase WITHOUT touching the file yet, so we can write
  // backup + new settings atomically.
  let dirty = false
  for (const phase of PHASES) {
    const arr: any[] = Array.isArray(settings.hooks[phase]) ? settings.hooks[phase] : []
    const ourIdx = arr.findIndex(isOurEntry)
    const desired = buildEntry(phase, scriptAbs)
    if (ourIdx < 0) {
      arr.push(desired)
      settings.hooks[phase] = arr
      result.installed.push(phase)
      dirty = true
    } else {
      // Check whether the resolved path still matches; if not, rewrite.
      const existing = arr[ourIdx]
      const desiredCommand = desired.hooks[0].command
      const actualCommand = existing?.hooks?.[0]?.command
      if (actualCommand !== desiredCommand) {
        arr[ourIdx] = desired
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
  const guardSrc = guardSourcePath()
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
    await mkdir(join(homedir(), '.claude'), { recursive: true })
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
  // PreToolUse guard entries + the installed guard copy.
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

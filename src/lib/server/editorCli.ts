// editorCli.ts — "Open in editor" for a project folder (POST
// /api/project/open-editor). Finds the user's code editor and spawns it
// DETACHED on the project dir — the editor's lifetime is never tied to ours.
//
// RESOLUTION ORDER:
//   1. env OPENGROUND_EDITOR_CMD — the explicit override. Whitespace-split
//      argv; first token = command. Trusted as-is, never probed.
//   2. CLI detection, cursor → code → windsurf → zed, each candidate tried
//      against (a) the server process's own PATH, (b) a fresh login shell
//      (the boot-time-PATH-snapshot trap — see cliResolve.ts/claudeCli.ts;
//      ONE shell spawn resolves all four names), (c) well-known install
//      locations (brew prefixes, ~/.local/bin, the .app-bundle CLI shims).
//      Candidate order is strict: cursor found ANYWHERE beats code found
//      anywhere.
//   3. macOS last resort: `open -a Cursor` → `open -a "Visual Studio Code"`.
//
// All gone → EditorNotFoundError (route maps it to 503 with the message).

import { execFile as execFileCb, spawn, type SpawnOptions } from 'child_process'
import { promisify } from 'util'
import { access } from 'fs/promises'
import { constants } from 'fs'
import { homedir } from 'os'
import { join, win32 as winPath } from 'path'
import { resolveViaLoginShell } from './cliResolve'
import type { OpenApp } from '../types'

const execFile = promisify(execFileCb)

/** "No editor anywhere" — the route maps this to a 503 with the message. */
export class EditorNotFoundError extends Error {
  constructor() {
    super(
      'No code editor found — install Cursor, VS Code, Windsurf or Zed ' +
        '(with its shell command), or set OPENGROUND_EDITOR_CMD to your ' +
        'editor command.',
    )
    this.name = 'EditorNotFoundError'
  }
}

/** CLI candidates in strict priority order. */
export const EDITOR_CANDIDATES = ['cursor', 'code', 'windsurf', 'zed'] as const

/** OPENGROUND_EDITOR_CMD → argv. Whitespace-split; first token = command.
 *  Exported for unit tests. */
export const parseEditorCmd = (raw: string): string[] =>
  raw.trim().split(/\s+/).filter(Boolean)

/** Windows well-known CLI shim locations per candidate: VS Code and its forks
 *  install a `<name>.cmd` under their program dir's `bin/`. Both the user-scoped
 *  (`%LOCALAPPDATA%\Programs`) and machine-scoped (`%ProgramFiles%`) installers
 *  are covered. PATHEXT resolution of a bare name happens in the process-PATH /
 *  `where` stages; these absolute `.cmd` shims are the no-shell last resort.
 *  (zed has no stable Windows CLI shim path yet — it rides the PATH/`where`
 *  stages.) Built with `win32` path joins so the shape is correct regardless of
 *  the host the resolver/tests run on. */
const windowsEditorLocations = (name: string): string[] => {
  const localApp = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
  const userPrograms = winPath.join(localApp, 'Programs')
  const shim = `${name}.cmd`
  if (name === 'code') {
    return [
      winPath.join(userPrograms, 'Microsoft VS Code', 'bin', shim),
      winPath.join(programFiles, 'Microsoft VS Code', 'bin', shim),
    ]
  }
  // Cursor & Windsurf are VS Code forks: their CLI shim lives under
  // resources\app\bin (NOT a root-level bin\ as VS Code's own user setup uses).
  if (name === 'cursor') {
    return [winPath.join(userPrograms, 'cursor', 'resources', 'app', 'bin', shim)]
  }
  if (name === 'windsurf') {
    return [winPath.join(userPrograms, 'Windsurf', 'resources', 'app', 'bin', shim)]
  }
  return []
}

/** Well-known install targets per candidate, tried last (no shell involved).
 *  macOS/Linux: brew on Apple Silicon and Intel, the official installers'
 *  ~/.local/bin, and the .app bundles' embedded CLI shims for VS Code / Cursor.
 *  Windows: the VS Code-family `.cmd` shims (see windowsEditorLocations).
 *  Exported for unit tests. */
export const knownEditorLocations = (name: string): string[] => {
  if (process.platform === 'win32') return windowsEditorLocations(name)
  const locs = [
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    join(homedir(), '.local', 'bin', name),
  ]
  if (name === 'code') {
    locs.push('/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code')
  }
  if (name === 'cursor') {
    locs.push('/Applications/Cursor.app/Contents/Resources/app/bin/cursor')
  }
  return locs
}

// Detection cache: probing spawns processes (worst case a login shell), so a
// double-click / re-click shouldn't pay twice. A miss is cached too — 10s is
// short enough that "install the editor, click again" feels live.
let cached: { at: number; argv: string[] | null } | null = null
const CACHE_MS = 10_000

/** Test seam: drop the detection cache. */
export const __resetEditorCacheForTests = (): void => {
  cached = null
}

/** Is this bare name runnable on the server process's own PATH?
 *  `--version` because every candidate (VS Code family + zed) answers it
 *  quickly without opening a window. shell:true on Windows so a `.cmd`/`.bat`
 *  shim (the usual VS Code-family CLI form, which Node can't exec directly)
 *  resolves through PATHEXT and runs — mirrors claudeConnection's probe. */
const onProcessPath = async (name: string): Promise<boolean> => {
  try {
    await execFile(name, ['--version'], { timeout: 5000, shell: process.platform === 'win32' })
    return true
  } catch {
    return false
  }
}

const executable = async (bin: string): Promise<boolean> => {
  try {
    await access(bin, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Resolve the editor launch argv (without the project path appended), or
 *  null when nothing was found. The env override bypasses the cache — it's
 *  explicit user intent and costs nothing to honour. */
export const resolveEditorArgv = async (): Promise<string[] | null> => {
  const envCmd = process.env.OPENGROUND_EDITOR_CMD
  if (envCmd && envCmd.trim()) {
    const argv = parseEditorCmd(envCmd)
    if (argv.length > 0) return argv
  }
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.argv

  let argv: string[] | null = null
  // Fresh-login-shell map, resolved lazily AT MOST ONCE for the whole pass
  // (one shell spawn covers all four candidates).
  let shellMap: Record<string, string> | null = null
  for (const name of EDITOR_CANDIDATES) {
    if (await onProcessPath(name)) {
      argv = [name]
      break
    }
    shellMap ??= await resolveViaLoginShell([...EDITOR_CANDIDATES])
    if (shellMap[name]) {
      argv = [shellMap[name]]
      break
    }
    const known = await Promise.all(
      knownEditorLocations(name).map(async (loc) => ((await executable(loc)) ? loc : null)),
    )
    const hit = known.find((l): l is string => l !== null)
    if (hit) {
      argv = [hit]
      break
    }
  }
  cached = { at: Date.now(), argv }
  return argv
}

/** Build the (command, args, options) for spawning the editor on `projectPath`,
 *  detached. On Windows the editor CLI is almost always a `.cmd`/`.bat` shim,
 *  which Node (v20+) can only spawn through a shell (`shell:true`); with the
 *  shell on, each argument is wrapped in quotes and `windowsVerbatimArguments`
 *  stops Node re-quoting, so a path containing spaces ("C:\Program Files\…" or a
 *  project dir with a space) survives intact. POSIX spawns the binary directly,
 *  exactly as before. Exported for unit tests. */
export const buildEditorSpawn = (
  argv: string[],
  projectPath: string,
): { command: string; args: string[]; options: SpawnOptions } => {
  const rest = [...argv.slice(1), projectPath]
  if (process.platform === 'win32') {
    return {
      command: `"${argv[0]}"`,
      args: rest.map((a) => `"${a}"`),
      options: {
        cwd: projectPath,
        detached: true,
        stdio: 'ignore',
        shell: true,
        windowsVerbatimArguments: true,
      },
    }
  }
  return {
    command: argv[0],
    args: rest,
    options: { cwd: projectPath, detached: true, stdio: 'ignore' },
  }
}

/** Spawn the editor on the project dir, detached (the editor outlives us and
 *  we never wait on it). */
const spawnDetached = (argv: string[], projectPath: string): void => {
  const { command, args, options } = buildEditorSpawn(argv, projectPath)
  const child = spawn(command, args, options)
  // The binary was probed moments ago, but it can still vanish in between —
  // swallow the async 'error' so it can't crash the server process.
  child.on('error', () => {})
  child.unref()
}

/** Open `projectPath` in the best available editor. Throws
 *  EditorNotFoundError when every strategy missed. */
export const openInEditor = async (projectPath: string): Promise<void> => {
  const argv = await resolveEditorArgv()
  if (argv) {
    spawnDetached(argv, projectPath)
    return
  }
  // macOS last resort: the .app may exist without its CLI shim installed.
  if (process.platform === 'darwin') {
    for (const app of ['Cursor', 'Visual Studio Code']) {
      try {
        await execFile('open', ['-a', app, projectPath], { timeout: 8000 })
        return
      } catch {
        /* not installed — next */
      }
    }
  }
  throw new EditorNotFoundError()
}

/** Open `projectPath` in a SPECIFIC editor the user chose — a detected bundle
 *  (editorDetect.ts) or a Finder-picked `.app`. Launches via macOS
 *  `open -a <target>`. NOTE: `open -a` DOES run the chosen bundle's embedded
 *  binary, so the route MUST validate `editor` through resolveAllowedEditorBundle
 *  (confined to the Applications dirs) before calling this — never pass an
 *  unvalidated client path here. Prefers the explicit bundle path (robust when
 *  two apps share a display name) and falls back to the display name. */
export const editorLaunchTarget = (editor: OpenApp): string =>
  editor.path && editor.path.trim() ? editor.path : editor.name

export const openWithApp = async (projectPath: string, editor: OpenApp): Promise<void> => {
  await execFile('open', ['-a', editorLaunchTarget(editor), projectPath], { timeout: 8000 })
}

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

import { execFile as execFileCb, spawn } from 'child_process'
import { promisify } from 'util'
import { access } from 'fs/promises'
import { constants } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { resolveViaLoginShell } from './cliResolve'

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

/** Well-known install targets per candidate, tried last (no shell involved):
 *  brew on Apple Silicon and Intel, the official installers' ~/.local/bin,
 *  and the .app bundles' embedded CLI shims for VS Code / Cursor.
 *  Exported for unit tests. */
export const knownEditorLocations = (name: string): string[] => {
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
 *  quickly without opening a window. */
const onProcessPath = async (name: string): Promise<boolean> => {
  try {
    await execFile(name, ['--version'], { timeout: 5000 })
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

/** Spawn the editor on the project dir, detached (the editor outlives us and
 *  we never wait on it). */
const spawnDetached = (argv: string[], projectPath: string): void => {
  const child = spawn(argv[0], [...argv.slice(1), projectPath], {
    cwd: projectPath,
    detached: true,
    stdio: 'ignore',
  })
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

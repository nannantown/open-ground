// editorDetect.ts — enumerate the code editors ACTUALLY installed on this
// machine so the "Open in editor" (`<>`) button can offer a CHOICE (and a
// rememberable default) instead of auto-picking one editor.
//
// Discovery is macOS-only: it scans the Applications directories for known
// editor `.app` bundles. On other platforms it returns [] and the caller falls
// back to editorCli's CLI auto-detection (cursor/code/windsurf/zed). Launch is
// always `open -a <bundle>` (editorCli.openWithApp) — never an arbitrary
// binary — so a detected entry is safe to spawn.

import { readdir, realpath } from 'fs/promises'
import { homedir } from 'os'
import { dirname, join } from 'path'
import type { OpenApp } from '../types'

/** Known macOS code-editor `.app` bundle base names, in a sensible default
 *  order (AI-first, then the VS Code family, native/lightweight editors, then
 *  the JetBrains IDEs). `name` doubles as the display label AND the bundle base
 *  name we match on disk. `aliases` are alternate bundle names that map to the
 *  same display name (e.g. the JetBrains "CE" community editions). Exported so
 *  the unit test can assert the catalogue shape. */
export interface KnownEditor {
  name: string
  aliases?: string[]
}

export const KNOWN_EDITORS: KnownEditor[] = [
  { name: 'Cursor' },
  { name: 'Visual Studio Code', aliases: ['Visual Studio Code - Insiders'] },
  { name: 'VSCodium' },
  { name: 'Windsurf' },
  { name: 'Zed', aliases: ['Zed Preview'] },
  { name: 'Trae' },
  { name: 'Sublime Text' },
  { name: 'Nova' },
  { name: 'BBEdit' },
  { name: 'TextMate' },
  { name: 'CotEditor' },
  { name: 'Atom' },
  { name: 'Fleet' },
  { name: 'IntelliJ IDEA', aliases: ['IntelliJ IDEA CE'] },
  { name: 'WebStorm' },
  { name: 'PyCharm', aliases: ['PyCharm CE'] },
  { name: 'GoLand' },
  { name: 'PhpStorm' },
  { name: 'RubyMine' },
  { name: 'CLion' },
  { name: 'RustRover' },
  { name: 'Rider' },
  { name: 'DataGrip' },
  { name: 'Android Studio' },
  { name: 'Xcode' },
]

/** Directories scanned for `.app` bundles — and the allowlist for launching a
 *  client-supplied editor (resolveAllowedEditorBundle). First match wins on
 *  duplicate bundle names, so the system locations come before the per-user
 *  one. Exported for the security check and its tests. */
export const appDirs = (): string[] => [
  '/Applications',
  '/System/Applications',
  join(homedir(), 'Applications'),
]

/** Map every `*.app` present across the scanned dirs to its full path
 *  (bundle base name → absolute path; first dir wins). One readdir per dir
 *  instead of an `access()` per candidate. */
const scanInstalledBundles = async (): Promise<Map<string, string>> => {
  const present = new Map<string, string>()
  for (const dir of appDirs()) {
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      continue // dir absent / unreadable — skip
    }
    for (const e of entries) {
      if (!e.endsWith('.app')) continue
      const base = e.slice(0, -'.app'.length)
      if (!present.has(base)) present.set(base, join(dir, e))
    }
  }
  return present
}

/** The installed code editors, in KNOWN_EDITORS priority order. Each is an
 *  {name, path, mode:'open'} OpenApp ready for editorCli.openWithApp. Empty on
 *  non-macOS (the caller then uses CLI auto-detection). */
export const detectInstalledEditors = async (): Promise<OpenApp[]> => {
  if (process.platform !== 'darwin') return []
  const present = await scanInstalledBundles()
  const out: OpenApp[] = []
  for (const ed of KNOWN_EDITORS) {
    for (const candidate of [ed.name, ...(ed.aliases ?? [])]) {
      const full = present.get(candidate)
      if (full) {
        out.push({ name: ed.name, path: full, mode: 'open' })
        break // one entry per known editor, even if several variants exist
      }
    }
  }
  return out
}

/** Resolve a client-supplied editor bundle path to its canonical location IFF
 *  it's a real `.app` sitting DIRECTLY in one of the scanned Applications dirs;
 *  null otherwise.
 *
 *  SECURITY: `open -a <path>` launches an arbitrary `.app` bundle and runs its
 *  embedded `Contents/MacOS/<binary>` — it is NOT restricted to "known" apps.
 *  The server is loopback-bound but has no CSRF guard, so a launch from a
 *  client-supplied path MUST be confined to the same directories
 *  detectInstalledEditors enumerates. realpath collapses symlinks first, so a
 *  link planted inside /Applications can't redirect the launch to a bundle
 *  outside the allowlist. (Finder-picked apps land here too — fine, since a
 *  normal install lives in one of these dirs.) */
export const resolveAllowedEditorBundle = async (appPath: string): Promise<string | null> => {
  if (typeof appPath !== 'string' || !appPath.endsWith('.app')) return null
  let real: string
  try {
    real = await realpath(appPath)
  } catch {
    return null // does not exist
  }
  if (!real.endsWith('.app')) return null // symlink pointing off a .app bundle
  const parent = dirname(real)
  const allowedDirs = await Promise.all(
    appDirs().map((d) => realpath(d).then((r) => r as string | null, () => null)),
  )
  return allowedDirs.some((d) => d !== null && d === parent) ? real : null
}

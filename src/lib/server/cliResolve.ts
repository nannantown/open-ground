// cliResolve.ts — shared "find a CLI binary the server's stale PATH can't see"
// helpers, factored out of claudeCli.ts so other resolvers (editorCli.ts) can
// reuse the exact same login-shell trick.
//
// THE TRAP (claudeCli.ts has the full story): the server process's PATH is a
// snapshot from app boot. Anything installed after boot — or only reachable
// through a PATH line in the user's shell profile — is invisible to a bare
// execFile('<name>') even though every PTY (a fresh login shell) sees it. So
// when the direct lookup misses, re-resolve through a fresh login shell, the
// same source of truth a real terminal uses.

import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'

const execFile = promisify(execFileCb)

// Command names are interpolated into a `command -v …` shell string, so they
// must be plain words — never user input. This guard makes that structural.
const SAFE_NAME = /^[A-Za-z0-9._-]+$/

/** argv for "resolve `commands` through a fresh login shell". zsh gets -i too
 *  so PATH lines a user (or an installer) appended to .zshrc — not just
 *  .zprofile — are honoured; bash/other POSIX shells read their profile with
 *  -l alone (interactive bash can block on rc prompts, so no -i there).
 *  `command -v a b c` prints one path line per FOUND name (missing ones are
 *  simply absent), so several candidates cost a single shell spawn. */
export const loginShellResolveArgv = (
  shell: string,
  commands: string[],
): [string, string[]] => {
  for (const c of commands) {
    if (!SAFE_NAME.test(c)) throw new Error(`unsafe command name: ${c}`)
  }
  const args = shell.endsWith('zsh') ? ['-lic'] : ['-lc']
  return [shell, [...args, `command -v ${commands.join(' ')}`]]
}

/** All absolute-path lines in `command -v` output, in order. Profile noise
 *  (echoes, motd) rides along — only lines that look like absolute paths are
 *  binary candidates. */
export const pathsFromShellOutput = (stdout: string): string[] =>
  stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('/'))

/** The single-command form claudeCli historically used: the LAST absolute-path
 *  line (the real answer comes after any profile noise). */
export const pathFromShellOutput = (stdout: string): string | null => {
  const paths = pathsFromShellOutput(stdout)
  return paths.length > 0 ? paths[paths.length - 1] : null
}

/** Resolve several command names through ONE fresh login shell. Returns a
 *  basename → absolute-path map of the ones the shell found; {} on any
 *  failure (shell missing, profile error, timeout). */
export const resolveViaLoginShell = async (
  commands: string[],
): Promise<Record<string, string>> => {
  try {
    const [shell, args] = loginShellResolveArgv(process.env.SHELL || '/bin/zsh', commands)
    const { stdout } = await execFile(shell, args, { timeout: 8000 })
    const out: Record<string, string> = {}
    for (const p of pathsFromShellOutput(stdout)) {
      const base = p.slice(p.lastIndexOf('/') + 1)
      // First hit per name wins (`command -v` prints in PATH-priority order).
      if (commands.includes(base) && !(base in out)) out[base] = p
    }
    return out
  } catch {
    return {}
  }
}

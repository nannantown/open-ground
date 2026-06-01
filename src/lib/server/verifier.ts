import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'

const execFile = promisify(execFileCb)

// Per-command wall-clock cap. A 5-minute budget is generous enough for
// `npm install` style commands but still short enough that a runaway
// process gets SIGKILL'd before the auto-loop's retry cascade balloons
// the user's claude session token spend.
const TIMEOUT_MS = 5 * 60 * 1000

// stdout / stderr buffer cap per command. Anything larger than 16 MB is
// almost certainly a runaway log dump.
const MAX_BUFFER_BYTES = 16 * 1024 * 1024

// Tail size kept per command in the in-memory `outputs` array — the rest
// goes to the on-disk full log under `.openground/verify-logs/`. 4 KB is
// enough for "the last error stack" and is small enough that round-tripping
// VerifyResult through JSON / SSE stays cheap even across 10+ commands.
const OUTPUT_TAIL_BYTES = 4 * 1024

export interface VerifyResult {
  passed: boolean
  commands: string[]
  /** Per-command tails of stdout+stderr (≤ OUTPUT_TAIL_BYTES). For commands
   *  not yet run (we fail-fast on the first non-zero exit), the entry is
   *  the empty string. Indexes line up with `commands`. */
  outputs: string[]
  fullLogPath: string
  finishedAt: string
  /** Wall-clock duration in milliseconds for the whole pass. */
  durationMs: number
}

const tail = (s: string, n: number): string =>
  s.length > n ? '…' + s.slice(s.length - n) : s

const LOG_SUBDIR = '.openground/verify-logs'

// The shell used to evaluate each verify command so npm scripts / pipes /
// `&&` / redirection just work. `/bin/sh -c <cmd>` on POSIX; on Windows there
// is no /bin/sh, so use the comspec (cmd.exe) with `/d /s /c`. NOTE: command
// strings written for sh (e.g. `FOO=bar npm test`, `a && b`) are NOT all
// cmd.exe-compatible — `&&` works in cmd.exe but inline env-prefix and many
// POSIX idioms do not. UNTESTED ON WINDOWS.
const shellInvocation = (cmd: string): { file: string; args: string[] } =>
  process.platform === 'win32'
    ? { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', cmd] }
    : { file: '/bin/sh', args: ['-c', cmd] }

/**
 * Run a milestone's `verifyCommands` in order under the project's cwd.
 * - Each command is `/bin/sh -c <cmd>`, so npm scripts / pipes / `&&` /
 *   redirection all just work.
 * - Fail-fast: on the first non-zero exit, remaining commands are recorded
 *   as empty strings and we return `passed: false`.
 * - The complete stdout+stderr stream for every command runs through
 *   `.openground/verify-logs/<milestoneId>-<timestamp>.txt`, which the UI
 *   can link to from the milestone row.
 */
export const runVerifyCommands = async (
  projectPath: string,
  milestoneId: string,
  commands: string[],
): Promise<VerifyResult> => {
  const startedAt = Date.now()
  const logDir = join(projectPath, LOG_SUBDIR)
  await mkdir(logDir, { recursive: true })
  const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, '-')
  const fullLogPath = join(logDir, `${milestoneId}-${stamp}.txt`)

  const fullParts: string[] = []
  const outputs: string[] = []
  let passed = true

  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i]
    if (!passed) {
      // Earlier command failed — record the skip so the UI can show the
      // user which commands didn't even get a chance to run.
      outputs.push('')
      fullParts.push(`\n=== [skipped — earlier command failed] ${cmd} ===\n`)
      continue
    }
    fullParts.push(`\n=== ${cmd} ===\n`)
    try {
      const inv = shellInvocation(cmd)
      const { stdout, stderr } = await execFile(inv.file, inv.args, {
        cwd: projectPath,
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER_BYTES,
      })
      fullParts.push(stdout, stderr)
      outputs.push(tail((stdout ?? '') + (stderr ?? ''), OUTPUT_TAIL_BYTES))
    } catch (e: unknown) {
      // execFile rejects on non-zero exit, timeout, or signal. `e` carries
      // stdout / stderr / code / signal — extract defensively because the
      // exact shape depends on the failure mode.
      const err = e as {
        stdout?: string
        stderr?: string
        code?: number | string
        signal?: string
        killed?: boolean
        message?: string
      }
      const out = (err.stdout ?? '') + (err.stderr ?? '')
      const suffix = err.killed
        ? `\n[killed${err.signal ? ` ${err.signal}` : ''} after timeout]\n`
        : `\n[exit ${err.code ?? '?'}]\n`
      fullParts.push(out, suffix)
      outputs.push(tail(out + suffix, OUTPUT_TAIL_BYTES))
      passed = false
    }
  }

  try {
    await writeFile(fullLogPath, fullParts.join(''), 'utf8')
  } catch {
    // Disk full / perm error — UI still gets the tails in `outputs`.
  }

  return {
    passed,
    commands,
    outputs,
    fullLogPath,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
  }
}

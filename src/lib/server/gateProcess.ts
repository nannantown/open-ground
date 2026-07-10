// gateProcess — the fork-pool-safe child-process runner shared by every engine
// stage that spawns a tool which itself FORKS a worker pool (vitest, eslint).
//
// It lives in its own module — rather than inside swarmOrchestrator, where it was
// born — because swarmSelfSupply needs the same reaper and swarmOrchestrator
// already imports swarmSelfSupply. A back-import would close an import cycle the
// self-supply module's header explicitly rules out; a leaf module both can import
// keeps the graph acyclic. swarmOrchestrator re-exports `runGateProcess` so its
// existing importers (and tests) keep their path.

import { spawn } from 'child_process'
import { basename } from 'path'

/** A child-process runner for any engine stage that spawns a tool which itself FORKS a
 *  worker pool — the merge gate's two vitest suites + eslint, and the self-supply
 *  scanners (vitest / eslint / tsc). It differs from `execFile` in exactly
 *  one way that matters: the child is spawned DETACHED (its own process-group leader) and, on
 *  EVERY exit path (timeout, spawn error, OR a normal close), the WHOLE group is SIGKILLed via a
 *  negative-pid signal — reaping the tool AND its forks together.
 *
 *  WHY: vitest with no explicit pool uses the default FORK pool (child_process workers).
 *  execFile's `timeout` SIGTERMs ONLY the direct pid, so on a wedged-suite timeout — precisely
 *  when the suite is stuck and the forks are live — the fork workers ORPHAN, each spinning a
 *  core to machine saturation. That is this repo's own documented hazard
 *  (feedback_vitest_no_midrun_kill: killing only the parent orphans the forks worker), and the
 *  very orphan the engine's self-update path already group-kills (electron/selfUpdate.js
 *  killProcessTree). A negative-pid SIGKILL reaches the group leader and every fork in it. The
 *  forks share the leader's group (vitest/eslint never re-group the way playwright's webServer
 *  does), so an IMMEDIATE group SIGKILL — not the SIGINT-then-escalate gracefulGroupKill — is the
 *  correct reaper here. We do NOT `unref()` the child: the caller still awaits it; `detached`
 *  only changes its process group, not the parent's wait.
 *
 *  FAIL-CLOSED is preserved exactly: resolves `{ stdout, stderr }` on a clean exit 0, and REJECTS
 *  with an Error carrying `stdout`/`stderr` (so the existing `errMsg`/tail catch keeps working) on
 *  non-zero exit, spawn error, OR timeout — so each check turns a timeout into RED, never a silent
 *  pass. The `stdout` on the rejection is what lets a *scanner* (which reads a tool's output
 *  precisely when it exits non-zero) keep its payload; see swarmSelfSupply's runCapture.
 *  (tscCheck's own gate and the git helper keep using execFile: a single process with no worker
 *  pool has no fork to orphan, so the negative-pid machinery would buy nothing.) */
export const runGateProcess = (
  bin: string,
  args: readonly string[],
  opts: { cwd: string; timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolvePromise, rejectPromise) => {
    // detached → the child leads its own process group (pgid == pid on POSIX), so a later kill
    // of -pid reaches the WHOLE group (the child + its vitest/eslint forks).
    const child = spawn(bin, [...args], { cwd: opts.cwd, env: opts.env, detached: true })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    // A const holder (not a reassigned `let`) so the timeout handle is referenced by
    // `settle` AND assigned below without any forward reference between the two.
    const timerRef: { id?: ReturnType<typeof setTimeout> } = {}

    // SIGKILL the child's whole process group; on POSIX a negative pid hits every member
    // (forks included). A group already gone (ESRCH — e.g. just after a clean exit) is a
    // harmless no-op; non-POSIX / non-leader falls back to a direct child kill.
    const reapGroup = () => {
      if (process.platform !== 'win32' && typeof child.pid === 'number') {
        try {
          process.kill(-child.pid, 'SIGKILL')
          return
        } catch {
          /* not a group leader / already gone — fall through to a direct kill */
        }
      }
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }

    const settle = (emit: () => void) => {
      if (settled) return
      settled = true
      if (timerRef.id) clearTimeout(timerRef.id)
      // Reap on the way out on EVERY path. After a clean close vitest has already reaped its
      // own forks (this is then a no-op), but the defensive group kill guarantees no straggler
      // fork survives the gate regardless of how the run ended.
      reapGroup()
      emit()
    }

    // Cap captured output like execFile's maxBuffer (guard against a runaway suite eating
    // memory) but keep DRAINING the pipes so the child never blocks on a full buffer; the
    // captured prefix is enough for the RED tail.
    const append = (cur: string, chunk: string): string =>
      cur.length >= opts.maxBuffer ? cur : (cur + chunk).slice(0, opts.maxBuffer)
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = append(stdout, String(chunk))
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = append(stderr, String(chunk))
    })

    timerRef.id = setTimeout(() => {
      timedOut = true
      settle(() => {
        const e = new Error(`${basename(bin)} timed out after ${opts.timeout}ms`) as Error & {
          stdout?: string
          stderr?: string
          killed?: boolean
        }
        e.stdout = stdout
        e.stderr = stderr
        e.killed = true
        rejectPromise(e)
      })
    }, opts.timeout)

    child.on('error', (err: Error) => {
      settle(() => {
        const e = err as Error & { stdout?: string; stderr?: string }
        e.stdout = stdout
        e.stderr = stderr
        rejectPromise(e)
      })
    })
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (timedOut) return // the timer already settled (and reaped) this run
      settle(() => {
        if (code === 0) {
          resolvePromise({ stdout, stderr })
          return
        }
        const e = new Error(
          `${basename(bin)} exited ${code != null ? `with code ${code}` : `via signal ${signal ?? 'unknown'}`}`,
        ) as Error & { stdout?: string; stderr?: string; code?: number | null }
        e.stdout = stdout
        e.stderr = stderr
        e.code = code
        rejectPromise(e)
      })
    })
  })

// INVARIANT F, dash-form extension — the worker push ban cannot be evaded by
// calling git's DASH-FORM binaries directly.
//
// Background: INVARIANT F (swarmGuardPushBan.test.ts) blanket-denies the
// `push` / `send-pack` / `http-push` subcommands and git-svn's outbound writes
// for a policed worker. But every `git <sub>` is equally callable as
// `git-<sub>` — the spellings live in git's libexec/git-core and run by
// absolute path (`/usr/libexec/git-core/git-push origin main`) with no `git`
// driver word. The guard resolves a command by BASENAME, so `git-push` used to
// read as an unknown command and fall through to the default ALLOW,
// sidestepping analyzeGit entirely. The fix routes every `git-*` basename back
// through the git analysis, so dash-form and driver-form yield identical
// verdicts — the push ban included.
//
// DELIVERY WINDOW: same mechanism as INVARIANT F — a confined worker cannot
// edit scripts/openground-guard.js (the guard's substrate rule blocks writes
// to its own source, by design), so the fixed build ships in
// deliverables/guard-push-followup/ and the commander swaps it in via
// apply.sh. While that directory exists this suite SKIPS; apply.sh deletes the
// directory as its last step, which arms this suite permanently. If the
// delivery is merged but never applied, deleting the deliverables dir without
// swapping the guard turns this suite RED — the apply-forgotten detector.
import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'
import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'

const require_ = createRequire(import.meta.url)
const guardPath = join(process.cwd(), 'scripts', 'openground-guard.js')
const deliveryPending = existsSync(join(process.cwd(), 'deliverables', 'guard-push-followup'))

describe.skipIf(deliveryPending)('INVARIANT F (dash-form) — git-push/git-send-pack/git-http-push/git-svn binaries are denied like their driver forms', () => {
  const { evaluate } = require_(guardPath) as {
    evaluate: (
      payload: unknown,
      env: Record<string, string | undefined>,
    ) => { decision: 'allow' | 'deny'; reason?: string }
  }

  const HOME = '/Users/tester'
  const WT = '/Users/tester/.openground/projects/uuid1/worktrees/wt1'
  const workerEnv = { OPENGROUND_GUARD: '1', OPENGROUND_GUARD_WRITE_ROOTS: WT, HOME }
  const offEnv = { HOME }
  const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command }, cwd: WT })

  it('F3 — every dash-form push spelling is denied; read dash-forms and third-party git-* stay allowed', () => {
    const failures: string[] = []
    const T = (env: Record<string, string | undefined>, cmd: string, expected: 'allow' | 'deny', label: string) => {
      const got = evaluate(bash(cmd), env).decision
      if (got !== expected) failures.push(`${label}: expected ${expected}, got ${got}`)
    }
    // the four spellings, bare and by absolute libexec path
    T(workerEnv, 'git-push origin main', 'deny', 'git-push')
    T(workerEnv, 'git-push origin HEAD:main', 'deny', 'git-push refspec (the 2e7beb2 shape, dash-form)')
    T(workerEnv, '/usr/libexec/git-core/git-push origin HEAD:main', 'deny', 'absolute libexec git-push')
    T(workerEnv, '/Library/Developer/CommandLineTools/usr/libexec/git-core/git-push origin main', 'deny', 'CLT libexec git-push')
    T(workerEnv, 'git-send-pack origin main', 'deny', 'git-send-pack')
    T(workerEnv, 'git-http-push https://x/r main', 'deny', 'git-http-push')
    T(workerEnv, 'git-svn dcommit', 'deny', 'git-svn dcommit')
    T(workerEnv, 'npm test && /usr/libexec/git-core/git-push origin HEAD:main', 'deny', 'chained absolute-path push')
    // dash-form inherits every OTHER git rule too (one verdict per subcommand)
    T(workerEnv, 'git-reset --hard', 'deny', 'git-reset --hard')
    T(workerEnv, 'git-branch -D swarm/x', 'deny', 'git-branch -D')
    T(workerEnv, 'git-clean -fd', 'deny', 'git-clean -fd')
    // non-regression: read spellings, third-party git-* tools, the local flow
    T(workerEnv, 'git-status', 'allow', 'git-status')
    T(workerEnv, 'git-log --oneline -5', 'allow', 'git-log')
    T(workerEnv, 'git-diff --name-only', 'allow', 'git-diff')
    T(workerEnv, 'git-svn fetch', 'allow', 'git-svn read')
    T(workerEnv, 'git-lfs pull', 'allow', 'third-party git-lfs (same verdict as `git lfs`)')
    T(workerEnv, 'git add -A && git commit -m fix', 'allow', 'driver add+commit')
    T(workerEnv, 'echo git-push', 'allow', 'dash-form as an argument, not a command')
    // unmarked sessions stay unpoliced (gate no-op)
    T(offEnv, 'git-push origin main', 'allow', 'plain session no-op')
    T(offEnv, '/usr/libexec/git-core/git-push origin main', 'allow', 'plain session absolute-path no-op')
    expect(failures).toEqual([])
  })

  it('F4 — process contract: a dash-form push exits 2 with the rule on stderr', () => {
    const childEnv: NodeJS.ProcessEnv = { ...process.env }
    delete childEnv.OPENGROUND_GUARD
    delete childEnv.SWARM_MANAGER
    delete childEnv.OPENGROUND_GUARD_WRITE_ROOTS
    Object.assign(childEnv, workerEnv)
    let code = -99
    let stderr = ''
    try {
      execFileSync(process.execPath, [guardPath], {
        input: JSON.stringify(bash('/usr/libexec/git-core/git-push origin HEAD:main')),
        env: childEnv,
        encoding: 'utf8',
      })
      code = 0
    } catch (e: any) {
      code = typeof e.status === 'number' ? e.status : -1
      stderr = String(e.stderr ?? '')
    }
    expect(code).toBe(2)
    expect(stderr).toMatch(/forbidden in a worker session/)
  })
})

// While the delivery is pending, keep ONE always-on breadcrumb so `vitest run`
// output shows WHY the invariant suite is skipped instead of silently green.
describe.runIf(deliveryPending)('INVARIANT F (dash-form) — delivery pending', () => {
  it('deliverables/guard-push-followup exists — commander must run apply.sh (see its README); the dash-form suite arms itself once applied', () => {
    expect(deliveryPending).toBe(true)
  })
})

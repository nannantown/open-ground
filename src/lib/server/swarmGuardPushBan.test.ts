// INVARIANT F — a WORKER can never `git push` (the 2e7beb2 bypass, closed).
//
// 2026-07-07: an in-app worker with ZERO heartbeats ran `git push origin
// HEAD:main` and integrated itself past the commander's re-verify and
// adversarial review. The guard's push vetting only denied the DESTRUCTIVE
// shapes (force / --mirror / ref-deletion / non-origin remotes) — inherited
// from the manager-era guard where a plain FF push was the legitimate
// integration step — so a plain push to origin sailed through. The fix makes
// the `push` subcommand (and its plumbing spellings send-pack / http-push,
// plus git-svn's outbound writes) a BLANKET deny for policed sessions:
// integration belongs to the commander; a worker commits locally, beats
// ready, and stops.
//
// DELIVERY WINDOW: a confined worker cannot edit scripts/openground-guard.js
// itself (the guard's substrate rule blocks writes to its own source — by
// design), so the fixed build ships in deliverables/guard-push-ban/ and the
// commander swaps it in via apply.sh. While that directory exists this suite
// SKIPS (the installed source is knowingly pre-fix); apply.sh deletes the
// directory as its last step, which arms this suite permanently. If the
// delivery is merged but never applied, deleting/losing the deliverables dir
// without swapping the guard turns this suite RED — the apply-forgotten
// detector. After apply it pins the push-ban against any future regression.
import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'
import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'

const require_ = createRequire(import.meta.url)
const guardPath = join(process.cwd(), 'scripts', 'openground-guard.js')
const deliveryPending = existsSync(join(process.cwd(), 'deliverables', 'guard-push-ban'))

describe.skipIf(deliveryPending)('INVARIANT F — worker push ban (guard blanket-denies git push)', () => {
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

  it('F1 — every push spelling is denied for a worker; the local flow stays allowed', () => {
    const failures: string[] = []
    const T = (env: Record<string, string | undefined>, cmd: string, expected: 'allow' | 'deny', label: string) => {
      const got = evaluate(bash(cmd), env).decision
      if (got !== expected) failures.push(`${label}: expected ${expected}, got ${got}`)
    }
    T(workerEnv, 'git push origin HEAD:main', 'deny', 'the 2e7beb2 shape')
    T(workerEnv, 'git push origin main', 'deny', 'plain push')
    T(workerEnv, 'git push', 'deny', 'bare push')
    T(workerEnv, 'git push origin swarm/x', 'deny', 'own swarm branch')
    T(workerEnv, 'git push --force origin main', 'deny', 'force')
    T(workerEnv, 'git send-pack origin main', 'deny', 'send-pack plumbing')
    T(workerEnv, 'git http-push https://x/r main', 'deny', 'http-push plumbing')
    T(workerEnv, 'git svn dcommit', 'deny', 'git-svn dcommit')
    T(workerEnv, 'npm test && git push origin HEAD:main', 'deny', 'chained push')
    // the worker's legitimate local flow is untouched
    T(workerEnv, 'git add -A && git commit -m fix', 'allow', 'add+commit')
    T(workerEnv, 'git fetch origin main && git rebase origin/main', 'allow', 'fetch+rebase')
    T(workerEnv, 'git status --short', 'allow', 'status')
    T(workerEnv, 'git merge-base --is-ancestor origin/main HEAD', 'allow', 'merge-base')
    T(workerEnv, 'git svn fetch', 'allow', 'git-svn read')
    T(workerEnv, 'echo "git push origin HEAD:main"', 'allow', 'echo mentioning push')
    // unmarked sessions stay unpoliced (gate no-op)
    T(offEnv, 'git push origin HEAD:main', 'allow', 'plain session no-op')
    expect(failures).toEqual([])
  })

  it('F2 — process contract: a worker push exits 2 with the rule on stderr (what Claude Code enforces)', () => {
    const childEnv: NodeJS.ProcessEnv = { ...process.env }
    delete childEnv.OPENGROUND_GUARD
    delete childEnv.SWARM_MANAGER
    delete childEnv.OPENGROUND_GUARD_WRITE_ROOTS
    Object.assign(childEnv, workerEnv)
    let code = -99
    let stderr = ''
    try {
      execFileSync(process.execPath, [guardPath], {
        input: JSON.stringify(bash('git push origin HEAD:main')),
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
describe.runIf(deliveryPending)('INVARIANT F — delivery pending', () => {
  it('deliverables/guard-push-ban exists — commander must run apply.sh (see its README); the push-ban suite arms itself once applied', () => {
    expect(deliveryPending).toBe(true)
  })
})

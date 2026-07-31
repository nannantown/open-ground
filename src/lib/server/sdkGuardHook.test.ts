import { describe, it, expect, vi } from 'vitest'
import {
  makeSdkGuardHook,
  verifySdkGuard,
  loadGuardEvaluate,
  resolveGuardModulePath,
  __resetGuardCacheForTests,
  type GuardEvaluate,
} from './sdkGuardHook'

const HOME = '/Users/tester'
const WT = '/Users/tester/.openground/projects/uuid1/worktrees/wt1'
const base = { writeRoots: [WT], home: HOME }

const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command }, cwd: WT })

const decisionOf = (out: Awaited<ReturnType<ReturnType<typeof makeSdkGuardHook>>>) =>
  out.hookSpecificOutput.permissionDecision

describe('makeSdkGuardHook — fail-closed on every failure mode', () => {
  // This is the whole reason the file exists. Measured 2026-07-30: a
  // programmatic PreToolUse hook that THROWS fails OPEN — the tool ran. So the
  // adapter must absorb every error into a denial.
  it('DENIES when the rule engine throws', async () => {
    const hook = makeSdkGuardHook({
      ...base,
      evaluateFn: () => {
        throw new Error('engine exploded')
      },
    })
    const out = await hook(bash('rm -rf /'))
    expect(decisionOf(out)).toBe('deny')
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('engine exploded')
  })

  it('DENIES when the engine returns a malformed verdict', async () => {
    const hook = makeSdkGuardHook({ ...base, evaluateFn: (() => ({ nope: true })) as unknown as GuardEvaluate })
    expect(decisionOf(await hook(bash('git status')))).toBe('deny')
  })

  it('DENIES when the engine returns nothing at all', async () => {
    const hook = makeSdkGuardHook({ ...base, evaluateFn: (() => undefined) as unknown as GuardEvaluate })
    expect(decisionOf(await hook(bash('git status')))).toBe('deny')
  })

  it('DENIES when the guard source cannot be loaded', async () => {
    __resetGuardCacheForTests()
    const hook = makeSdkGuardHook({ ...base, guardPath: '/nonexistent/openground-guard.js' })
    const out = await hook(bash('git status'))
    expect(decisionOf(out)).toBe('deny')
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/guard error/)
  })

  it('never throws and never returns undefined, whatever the engine does', async () => {
    for (const bad of [
      () => {
        throw new Error('x')
      },
      () => null,
      () => ({ decision: 'maybe' }),
    ]) {
      const hook = makeSdkGuardHook({ ...base, evaluateFn: bad as unknown as GuardEvaluate })
      const out = await hook(bash('anything'))
      expect(out?.hookSpecificOutput?.permissionDecision).toBe('deny')
    }
  })
})

describe('makeSdkGuardHook — verdict pass-through', () => {
  it('allows what the engine allows', async () => {
    const hook = makeSdkGuardHook({ ...base, evaluateFn: () => ({ decision: 'allow' }) })
    expect(decisionOf(await hook(bash('git status')))).toBe('allow')
  })

  it('denies what the engine denies and surfaces its reason to the model', async () => {
    const hook = makeSdkGuardHook({
      ...base,
      evaluateFn: () => ({ decision: 'deny', reason: 'git push is forbidden in a worker session' }),
    })
    const out = await hook(bash('git push'))
    expect(decisionOf(out)).toBe('deny')
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('git push is forbidden')
  })

  it('hands the engine the worker env — arming it WITHOUT touching process.env', () => {
    // The server process is not a guarded worker; arming the veto by mutating
    // its own environment would police every other in-process consumer.
    const seen: Record<string, string | undefined>[] = []
    const hook = makeSdkGuardHook({
      ...base,
      evaluateFn: (_p, env) => {
        seen.push(env)
        return { decision: 'allow' }
      },
    })
    return hook(bash('git status')).then(() => {
      expect(seen[0]).toMatchObject({
        OPENGROUND_GUARD: '1',
        OPENGROUND_GUARD_WRITE_ROOTS: WT,
        HOME,
      })
      expect(process.env.OPENGROUND_GUARD).toBeUndefined()
    })
  })

  it('joins multiple write roots the way the PTY path does', async () => {
    const seen: Record<string, string | undefined>[] = []
    const hook = makeSdkGuardHook({
      writeRoots: ['/a', '/b'],
      home: HOME,
      evaluateFn: (_p, env) => {
        seen.push(env)
        return { decision: 'allow' }
      },
    })
    await hook(bash('git status'))
    expect(seen[0].OPENGROUND_GUARD_WRITE_ROOTS).toBe('/a:/b')
  })

  it('forwards the payload shape the rule engine expects', async () => {
    const seen: unknown[] = []
    const hook = makeSdkGuardHook({
      ...base,
      evaluateFn: (p) => {
        seen.push(p)
        return { decision: 'allow' }
      },
    })
    await hook({ tool_name: 'Write', tool_input: { file_path: '/x' }, cwd: WT, agent_id: 'a1' })
    expect(seen[0]).toEqual({ tool_name: 'Write', tool_input: { file_path: '/x' }, cwd: WT })
  })
})

describe('makeSdkGuardHook — the denial record', () => {
  it('reports every denial through onDeny, including a SUB-AGENT one', async () => {
    // Measured 2026-07-30: denying a sub-agent's tool blocked the call but left
    // result.permission_denials EMPTY. The hook is the only complete record, so
    // the engine must be able to see denials from here.
    const denials: { toolName: string; agentId?: string }[] = []
    const hook = makeSdkGuardHook({
      ...base,
      evaluateFn: () => ({ decision: 'deny', reason: 'nope' }),
      onDeny: (d) => denials.push({ toolName: d.toolName, agentId: d.agentId }),
    })
    await hook({ tool_name: 'Write', tool_input: {}, cwd: WT, agent_id: 'agent-77' })
    expect(denials).toEqual([{ toolName: 'Write', agentId: 'agent-77' }])
  })

  it('reports fail-closed denials too, so a broken guard is visible not silent', async () => {
    const denials: string[] = []
    const hook = makeSdkGuardHook({
      ...base,
      evaluateFn: () => {
        throw new Error('boom')
      },
      onDeny: (d) => denials.push(d.reason),
    })
    await hook(bash('x'))
    expect(denials[0]).toContain('boom')
  })
})

describe('verifySdkGuard — the spawn gate', () => {
  it('passes only when the guard both DENIES a push and ALLOWS ordinary work', () => {
    const good: GuardEvaluate = (p) => {
      const cmd = String((p as { tool_input?: { command?: string } }).tool_input?.command ?? '')
      return cmd.includes('push') ? { decision: 'deny', reason: 'push ban' } : { decision: 'allow' }
    }
    expect(verifySdkGuard({ ...base, evaluateFn: good })).toEqual({ ok: true, problems: [] })
  })

  it('FAILS a guard that loads but no longer denies — the silent-regression case', () => {
    const toothless: GuardEvaluate = () => ({ decision: 'allow' })
    const r = verifySdkGuard({ ...base, evaluateFn: toothless })
    expect(r.ok).toBe(false)
    expect(r.problems.join(' ')).toMatch(/did not deny/)
  })

  it('FAILS a guard that denies everything — that is a broken worker, not a veto', () => {
    const paranoid: GuardEvaluate = () => ({ decision: 'deny', reason: 'no' })
    const r = verifySdkGuard({ ...base, evaluateFn: paranoid })
    expect(r.ok).toBe(false)
    expect(r.problems.join(' ')).toMatch(/git status/)
  })

  it('FAILS when the guard cannot be loaded at all', () => {
    __resetGuardCacheForTests()
    const r = verifySdkGuard({ ...base, guardPath: '/nonexistent/guard.js' })
    expect(r.ok).toBe(false)
    expect(r.problems.join(' ')).toMatch(/could not be loaded/)
  })
})

describe('the REAL guard, loaded from the repo', () => {
  // Not a mock: this pins that the in-process veto reaches the SAME rule engine
  // the PTY path uses. If openground-guard.js stops exporting evaluate, or its
  // worker rules change shape, this is where it surfaces.
  it('resolves and exports evaluate()', () => {
    __resetGuardCacheForTests()
    const { path, problem } = resolveGuardModulePath()
    expect(problem).toBeNull()
    expect(path).toMatch(/openground-guard\.js$/)
    expect(typeof loadGuardEvaluate(path!)).toBe('function')
  })

  it('denies a worker `git push` and allows `git status` through the adapter', async () => {
    __resetGuardCacheForTests()
    const hook = makeSdkGuardHook(base)
    expect(decisionOf(await hook(bash('git push origin main')))).toBe('deny')
    expect(decisionOf(await hook(bash('git status')))).toBe('allow')
  })

  it('denies a Write outside the worker write roots', async () => {
    __resetGuardCacheForTests()
    const hook = makeSdkGuardHook(base)
    const out = await hook({
      tool_name: 'Write',
      tool_input: { file_path: '/Users/tester/somewhere-else.txt', content: 'x' },
      cwd: WT,
    })
    expect(decisionOf(out)).toBe('deny')
  })

  it('passes verifySdkGuard against the real engine', () => {
    __resetGuardCacheForTests()
    expect(verifySdkGuard(base).ok).toBe(true)
  })
})

describe('resolveGuardModulePath', () => {
  it('reports a problem rather than returning a path it did not find', () => {
    // Sanity: the shape callers rely on to fail closed.
    const r = resolveGuardModulePath()
    expect(r.path === null ? typeof r.problem : r.problem).toBeTruthy
    expect(vi.isMockFunction(resolveGuardModulePath)).toBe(false)
  })
})

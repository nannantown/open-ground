import { describe, it, expect } from 'vitest'
import {
  sdkWorkerLaunchPlan,
  sdkWorkerPreflight,
  sdkSessionEnv,
  SDK_WORKER_MIN_CLI_VERSION,
} from './swarmWorkerSdk'
import type { GuardEvaluate } from './sdkGuardHook'
import { WORKER_TRIAL_DIRECTIVE } from './swarmWorker'

const WT = '/Users/tester/.openground/projects/uuid1/worktrees/wt1'
const SID = '11111111-2222-3333-4444-555555555555'
const HOME = '/Users/tester'
const BIN = '/Users/tester/.local/bin/claude'

// A rule engine with the shape the real one has, so these tests never load the
// guard from disk (that is sdkGuardHook.test.ts's job).
const okGuard: GuardEvaluate = (p) => {
  const cmd = String((p as { tool_input?: { command?: string } }).tool_input?.command ?? '')
  return cmd.includes('push') ? { decision: 'deny', reason: 'push ban' } : { decision: 'allow' }
}

// `lang` is a REQUIRED field on SdkWorkerOptsInput (2026-08-13 rework) — the
// default fixture fixes it to 'en' so tests unrelated to language don't have
// to think about it; the dedicated describe block below exercises 'en'/'ja'.
const plan = (over: Partial<Parameters<typeof sdkWorkerLaunchPlan>[0]> = {}) =>
  sdkWorkerLaunchPlan({
    worktree: WT,
    agentSessionId: SID,
    title: 'do the thing',
    home: HOME,
    claudeBin: BIN,
    evaluateFn: okGuard,
    env: { PATH: '/usr/bin', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDECODE: '1', FOO: 'bar' } as NodeJS.ProcessEnv,
    lang: 'en',
    // `me` is required (2026-09-16); the default here is what an ORDINARY card's
    // worker resolves to under the default `optimize` mode (a HEAVY card would
    // resolve to fable — the one slot that still may). `...over` can pin another.
    me: { model: 'opus', effort: 'medium' },
    ...over,
  })

describe('sdkWorkerLaunchPlan — the worker launch contract (SDK-only since 2026-08-13)', () => {
  it('runs in the worktree and drives the USER\'S claude, not the SDK\'s bundled one', () => {
    const o = plan().options
    expect(o.cwd).toBe(WT)
    // §4 #11: the whole subscription-only claim rests on this.
    expect(o.pathToClaudeCodeExecutable).toBe(BIN)
  })

  it('is unattended: bypassPermissions — a worker must never sit on an approval prompt', () => {
    expect(plan().options.permissionMode).toBe('bypassPermissions')
  })

  it('loads NO mcp servers — mcp__* tools sit outside the veto', () => {
    const o = plan().options
    expect(o.strictMcpConfig).toBe(true)
    expect(o.mcpServers).toEqual({})
  })

  it('arms a PreToolUse hook (the SDK loads no filesystem settings, so this is the only veto)', () => {
    const hooks = plan().options.hooks as { PreToolUse: { hooks: unknown[] }[] }
    expect(hooks.PreToolUse).toHaveLength(1)
    expect(hooks.PreToolUse[0].hooks).toHaveLength(1)
    expect(typeof hooks.PreToolUse[0].hooks[0]).toBe('function')
  })

  it('the armed hook actually denies a worker push', async () => {
    const hooks = plan().options.hooks as {
      PreToolUse: { hooks: ((i: unknown) => Promise<{ hookSpecificOutput: { permissionDecision: string } }>)[] }[]
    }
    const out = await hooks.PreToolUse[0].hooks[0]({
      tool_name: 'Bash',
      tool_input: { command: 'git push origin main' },
      cwd: WT,
    })
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
  })

  it('carries the model/effort the shared swarm defaults resolve', () => {
    const o = plan({ me: { model: 'opus', effort: 'max' } }).options
    expect(o.model).toBe('opus')
    expect(o.effort).toBe('max')
  })

  it('starts a FRESH session by id, or resumes the recorded one', () => {
    expect(plan().options.sessionId).toBe(SID)
    expect(plan().options.resume).toBeUndefined()

    const r = plan({ resume: true }).options
    expect(r.resume).toBe(SID)
    expect(r.sessionId).toBeUndefined()
  })

  it('sends the /order goal as the first turn, or the resume injection', () => {
    expect(plan().initialPrompt).toContain('do the thing')
    expect(plan({ resume: true }).initialPrompt).toBe(
      sdkWorkerLaunchPlan({
        worktree: WT,
        agentSessionId: SID,
        title: 'x',
        resume: true,
        home: HOME,
        claudeBin: BIN,
        evaluateFn: okGuard,
        lang: 'en',
        me: { model: 'opus', effort: 'medium' },
      }).initialPrompt,
    )
  })

  it('hands the worker the difficulty DIRECTIVE for its EFFECTIVE tier (card 1c5f66e3, 2026-09-22)', () => {
    // Stored tier → its policy clause in the /order text.
    expect(plan({ tier: 'touch' }).initialPrompt).toContain('【難易度: touch')
    expect(plan({ tier: 'ultra' }).initialPrompt).toContain('【難易度: ultra')
    // No stored tier ⇒ the estimator's tier (an ordinary title is 'standard') —
    // every SDK worker gets a directive, never the skill's silent max-effort default.
    expect(plan().initialPrompt).toContain('【難易度: standard')
    // The SAFETY FLOOR applies to the directive too: a touch card that names a
    // heavy concern is told the design policy (one mandatory adversarial review),
    // matching the model/effort the same floor would have raised it to.
    expect(plan({ title: 'delete the auth token migration', tier: 'touch' }).initialPrompt).toContain('【難易度: design')
    expect(plan({ title: 'delete the auth token migration', tier: 'touch' }).initialPrompt).not.toContain('【難易度: touch')
    // A RESUMED worker re-reads its original goal (directive included) from
    // history; the resume injection carries none.
    expect(plan({ tier: 'touch', resume: true }).initialPrompt).not.toContain('難易度')
  })

  it('threads Settings.language into the SDK initial prompt (opts.lang, literal marker)', () => {
    expect(plan({ lang: 'en' }).initialPrompt).toContain('[Reply language]')
    expect(plan({ lang: 'en' }).initialPrompt).not.toContain('【返答言語】')
    expect(plan({ resume: true, lang: 'ja' }).initialPrompt).toContain('【返答言語】')
    expect(plan({ resume: true, lang: 'ja' }).initialPrompt).not.toContain('[Reply language]')
  })

  it('passes extra read dirs only when there are some', () => {
    expect(plan().options.additionalDirectories).toBeUndefined()
    expect(plan({ additionalDirectories: ['/x'] }).options.additionalDirectories).toEqual(['/x'])
  })

  it('does NOT set remoteControl — the flag is inert outside an interactive REPL', () => {
    // Measured three ways (initialize reports it off; --debug shows no bridge;
    // extraArgs makes no difference). The owner's phone window is the supply
    // desk, which stays on a PTY.
    const o = plan().options
    expect(o.remoteControl).toBeUndefined()
    expect('remoteControl' in o).toBe(false)
  })

  it('WARNS instead of silently dropping the sandbox request', () => {
    const p = plan({ sandbox: true })
    expect(p.warnings.join(' ')).toMatch(/sandbox/i)
    expect(p.warnings.join(' ')).toMatch(/WITHOUT/)
    // …and the plan is still usable; the guard still applies.
    expect(p.options.hooks).toBeDefined()
  })

  it('emits no sandbox warning when none was asked for', () => {
    expect(plan().warnings).toEqual([])
  })
})

describe('sdkSessionEnv', () => {
  it('strips the child-session markers a nested claude would inherit', () => {
    const e = sdkSessionEnv({
      PATH: '/usr/bin',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_SESSION_ID: 'abc',
      CLAUDECODE: '1',
      KEEP: 'yes',
    } as NodeJS.ProcessEnv)
    expect(e).toEqual({ PATH: '/usr/bin', KEEP: 'yes' })
  })

  it('drops undefined values rather than passing them through', () => {
    expect(sdkSessionEnv({ A: undefined, B: 'b' } as NodeJS.ProcessEnv)).toEqual({ B: 'b' })
  })

  it('is what the launch plan uses', () => {
    expect(plan().options.env).toEqual({ PATH: '/usr/bin', FOO: 'bar' })
  })
})

describe('sdkWorkerPreflight — fails CLOSED', () => {
  const ver = (v: string) => () => `${v} (Claude Code)`

  it('passes when the binary, its version and the veto all check out', () => {
    const r = sdkWorkerPreflight({
      writeRoots: [WT],
      home: HOME,
      claudeBin: BIN,
      readVersion: ver('2.1.220'),
      evaluateFn: okGuard,
    })
    expect(r).toMatchObject({ ok: true, problems: [], claudeBin: BIN, cliVersion: '2.1.220' })
  })

  it('refuses when the user\'s claude cannot be located', () => {
    const r = sdkWorkerPreflight({ writeRoots: [WT], home: HOME, claudeBin: null, evaluateFn: okGuard })
    expect(r.ok).toBe(false)
    expect(r.problems.join(' ')).toMatch(/could not be located/)
  })

  it('refuses a CLI older than the measured floor', () => {
    const r = sdkWorkerPreflight({
      writeRoots: [WT],
      home: HOME,
      claudeBin: BIN,
      readVersion: ver('2.1.207'),
      evaluateFn: okGuard,
    })
    expect(r.ok).toBe(false)
    expect(r.problems.join(' ')).toContain(SDK_WORKER_MIN_CLI_VERSION)
  })

  it('accepts a NEWER CLI (the floor is a floor, not a pin)', () => {
    const r = sdkWorkerPreflight({
      writeRoots: [WT],
      home: HOME,
      claudeBin: BIN,
      readVersion: ver('2.2.0'),
      evaluateFn: okGuard,
    })
    expect(r.ok).toBe(true)
  })

  it('refuses when --version cannot be read', () => {
    const r = sdkWorkerPreflight({
      writeRoots: [WT],
      home: HOME,
      claudeBin: BIN,
      readVersion: () => {
        throw new Error('ENOENT')
      },
      evaluateFn: okGuard,
    })
    expect(r.ok).toBe(false)
    expect(r.problems.join(' ')).toMatch(/--version` failed/)
  })

  it('refuses a guard that loads but no longer denies — the silent-regression case', () => {
    const toothless: GuardEvaluate = () => ({ decision: 'allow' })
    const r = sdkWorkerPreflight({
      writeRoots: [WT],
      home: HOME,
      claudeBin: BIN,
      readVersion: ver('2.1.220'),
      evaluateFn: toothless,
    })
    expect(r.ok).toBe(false)
    expect(r.problems.join(' ')).toMatch(/did not deny/)
  })

  it('reports EVERY problem at once, not just the first', () => {
    const r = sdkWorkerPreflight({
      writeRoots: [WT],
      home: HOME,
      claudeBin: null,
      evaluateFn: () => ({ decision: 'allow' }),
    })
    expect(r.problems.length).toBeGreaterThan(1)
  })
})

// ── the trial flags reach the worker, and only when set ──────────────────────
//
// The flags are read at the SPAWN site (swarmWorker.ts) and handed in here.
// A launch plan that accepted them and dropped them would leave the owner
// toggling a Settings switch that changes nothing — the failure mode that makes
// a trial unmeasurable rather than merely ineffective, so it is asserted on the
// initialPrompt (what the worker actually receives), not on the options object.
describe('sdkWorkerLaunchPlan — worker-directive trials', () => {
  it('omits every trial clause when no flags are passed', () => {
    const p = plan({ title: 'small fix', tier: 'touch' })
    expect(p.initialPrompt).not.toContain(WORKER_TRIAL_DIRECTIVE.brevity)
    expect(p.initialPrompt).not.toContain(WORKER_TRIAL_DIRECTIVE.thinkInCode)
  })

  it('is byte-identical with trials absent and with an empty object', () => {
    const a = plan({ title: 'small fix', tier: 'touch' }).initialPrompt
    const b = plan({ title: 'small fix', tier: 'touch', trials: {} }).initialPrompt
    expect(b).toBe(a)
  })

  it('carries the clauses through when the flags are on', () => {
    const p = plan({ title: 'small fix', tier: 'touch', trials: { brevity: true, thinkInCode: true } })
    expect(p.initialPrompt).toContain(WORKER_TRIAL_DIRECTIVE.brevity)
    expect(p.initialPrompt).toContain(WORKER_TRIAL_DIRECTIVE.thinkInCode)
  })

  it('resolves brevity against the EFFECTIVE tier, so the safety floor still wins', () => {
    // A card whose text trips the floor resolves to `design`, where brevity is
    // withheld — reading the STORED tier instead would hand it a brevity clause
    // the policy refuses.
    const p = plan({
      // 認証 is a HEAVY_SIGNALS keyword (cardTier.ts), so the floor raises this
      // card from the stored `touch` to `design`.
      title: '認証の経路を作り直す',
      tier: 'touch',
      trials: { brevity: true, thinkInCode: true },
    })
    expect(p.initialPrompt).toContain(WORKER_TRIAL_DIRECTIVE.thinkInCode)
    expect(p.initialPrompt).not.toContain(WORKER_TRIAL_DIRECTIVE.brevity)
  })
})

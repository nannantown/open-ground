// The SDK commander's launch contract, and the ways it deliberately DIFFERS
// from the SDK worker's.
//
// A difference here is a behaviour difference nothing downstream knows about —
// the engine, the Board and the integration protocol are identical whichever
// runtime carries the desk — so each one is pinned with the reason it exists.

import { describe, it, expect } from 'vitest'
import { sdkManagerLaunchPlan, sdkManagerPreflight } from './swarmManagerSdk'
import { MANAGER_INJECTION, MANAGER_RESUME_INJECTION } from './swarmManager'
import { SDK_WORKER_MIN_CLI_VERSION } from './swarmWorkerSdk'
import { languageDirective } from './promptLang'

// `lang` is a REQUIRED field on SdkManagerOptsInput (2026-08-13 rework) — the
// default fixture fixes it to 'en' so tests unrelated to language don't have
// to think about it; the dedicated describe block below exercises 'en'/'ja'.
const plan = (over: Partial<Parameters<typeof sdkManagerLaunchPlan>[0]> = {}) =>
  sdkManagerLaunchPlan({
    projectPath: '/repo',
    agentSessionId: 'sess-1',
    claudeBin: '/usr/local/bin/claude',
    port: 47776,
    env: { PATH: '/bin', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDECODE: '1' },
    lang: 'en',
    ...over,
  })

describe('sdkManagerLaunchPlan', () => {
  it('drives the USER\'S claude — never the SDK\'s bundled copy', () => {
    // Subscription-only is the product's claim about itself; the SDK's default
    // is its OWN binary, so this option is mandatory, not a preference.
    expect(plan().options.pathToClaudeCodeExecutable).toBe('/usr/local/bin/claude')
  })

  it('runs in the PRIMARY checkout — the commander never gets a worktree', () => {
    expect(plan().options.cwd).toBe('/repo')
  })

  it('arms NO PreToolUse veto — the commander is a trusted desk, unlike a worker', () => {
    // Worker-only guard scoping. A veto here would make the SDK commander
    // STRICTER than the PTY one and block the `git push origin HEAD:main` that
    // integration IS.
    expect(plan().options.hooks).toBeUndefined()
  })

  it('runs bypass and loads no MCP servers (parity with managerLaunchOpts)', () => {
    const o = plan().options
    expect(o.permissionMode).toBe('bypassPermissions')
    expect(o.strictMcpConfig).toBe(true)
    expect(o.mcpServers).toEqual({})
  })

  it('tags the session SWARM_MANAGER=1 and strips inherited child-session markers', () => {
    const env = plan().options.env as Record<string, string>
    expect(env.SWARM_MANAGER).toBe('1')
    expect(env.PATH).toBe('/bin')
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined()
    expect(env.CLAUDECODE).toBeUndefined()
  })

  it('APPENDS the app-context card — without it /og-manage has no API base URL', () => {
    // Measured 2026-07-31: `append` reaches the model, and an SDK session does
    // NOT otherwise carry Claude Code's system prompt. The commander's entire
    // toolbox is `curl $OG/api/...`, so this is load-bearing, not decoration.
    const sp = plan().options.systemPrompt as { type: string; preset: string; append: string }
    expect(sp.type).toBe('preset')
    expect(sp.preset).toBe('claude_code')
    expect(sp.append).toContain('http://127.0.0.1:47776')
    expect(sp.append).toContain('/repo')
  })

  it('passes NO remoteControl, and SAYS so — the capability is spent, not lost quietly', () => {
    const p = plan()
    expect(p.options.remoteControl).toBeUndefined()
    expect(p.warnings.join(' ')).toMatch(/Remote Control/i)
    expect(p.warnings.join(' ')).toMatch(/supply|タスク窓口/i)
  })

  it('fresh ⇒ sessionId + /og-manage; resume ⇒ resume + the re-read-the-Board order', () => {
    const fresh = plan()
    expect(fresh.options.sessionId).toBe('sess-1')
    expect(fresh.options.resume).toBeUndefined()
    expect(fresh.initialPrompt).toBe(MANAGER_INJECTION + languageDirective('en'))

    const cont = plan({ resume: true })
    expect(cont.options.resume).toBe('sess-1')
    expect(cont.options.sessionId).toBeUndefined()
    expect(cont.initialPrompt).toBe(MANAGER_RESUME_INJECTION + languageDirective('en'))
  })

  it('threads Settings.language into the SDK initial prompt (opts.lang, literal marker)', () => {
    expect(plan({ lang: 'en' }).initialPrompt).toContain('[Reply language]')
    expect(plan({ lang: 'en' }).initialPrompt).not.toContain('【返答言語】')
    expect(plan({ resume: true, lang: 'ja' }).initialPrompt).toContain('【返答言語】')
    expect(plan({ resume: true, lang: 'ja' }).initialPrompt).not.toContain('[Reply language]')
  })

  it('carries the mode-resolved model/effort', () => {
    const o = plan({ me: { model: 'sonnet', effort: 'low' } }).options
    expect(o.model).toBe('sonnet')
    expect(o.effort).toBe('low')
  })
})

describe('sdkManagerPreflight', () => {
  it('refuses when the user\'s claude cannot be located', () => {
    const r = sdkManagerPreflight({ claudeBin: null })
    expect(r.ok).toBe(false)
    expect(r.problems.join(' ')).toMatch(/could not be located/)
  })

  it('refuses a CLI older than the measured stream-json floor', () => {
    const r = sdkManagerPreflight({ claudeBin: '/c', readVersion: () => '2.1.100 (Claude Code)' })
    expect(r.ok).toBe(false)
    expect(r.problems.join(' ')).toContain(SDK_WORKER_MIN_CLI_VERSION)
  })

  it('passes on a good binary WITHOUT demanding a guard', () => {
    // The worker preflight also proves the A3/L4 veto has teeth. Requiring that
    // here would refuse to launch over the absence of something the PTY
    // commander does not have either.
    const r = sdkManagerPreflight({ claudeBin: '/c', readVersion: () => '2.1.220 (Claude Code)' })
    expect(r.ok).toBe(true)
    expect(r.problems).toEqual([])
  })
})

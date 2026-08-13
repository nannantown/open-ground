import { SWARM_LAUNCH_MODEL } from './swarmLaunch'
import { describe, it, expect } from 'vitest'
import { buildClaudeArgv } from './claudeTerminal'
import { supplyLaunchOpts, SUPPLY_INJECTION, SUPPLY_RESUME_INJECTION } from './swarmSupply'
import { languageDirective } from './promptLang'

// spawnSwarmSupply spawns a real PTY (needs the `claude` CLI), so it is
// curl-verified on the real machine. Here we pin the PURE launch contract —
// the exact LaunchClaudeOpts the supply officer runs with — which encodes the
// security-relevant decisions (bypass IN THE REAL CHECKOUT, tagged
// SWARM_MANAGER=1 — a TRUSTED session the worker-only PreToolUse veto does not
// police; the /supply skill as the positional prompt).

describe('supplyLaunchOpts (supply launch contract)', () => {
  // `lang` is a REQUIRED argument (2026-08-13 rework) — fixed to 'en' here so
  // the OTHER assertions stay independent of the language describe block below.
  const base = supplyLaunchOpts('/repo', 'sid-1', { lang: 'en' })

  it('runs in the project PRIMARY checkout (cwd), not a worktree', () => {
    expect(base.cwd).toBe('/repo')
    expect(base.agentSessionId).toBe('sid-1')
  })

  it('bypasses permissions so board writes are not gated on every turn', () => {
    expect(base.permissionMode).toBe('bypass')
  })

  it('is TAGGED as the supply officer (SWARM_MANAGER=1) — a role tag, NOT a guard opt-in', () => {
    // Under WORKER-ONLY guard scoping (2026-07) the PreToolUse veto polices only
    // the confined worker (OPENGROUND_GUARD=1 + write roots); the supply desk is
    // TRUSTED (it reads the repo + writes the recoverable Board), so
    // SWARM_MANAGER=1 only TAGS the session for tooling — same as the commander.
    expect(base.env).toEqual({ SWARM_MANAGER: '1' })
  })

  it('blocks MCP inheritance (strictMcpConfig) — defense-in-depth for an unpoliced trusted session', () => {
    // Supply is NOT policed by the PreToolUse veto (worker-only scoping), so this
    // is defense-in-depth, not veto-pairing: boot with only the explicit MCP
    // config (none) instead of inheriting user-scope servers. (See supplyLaunchOpts.)
    expect(base.strictMcpConfig).toBe(true)
  })

  it('keeps the app-context card ON (supply writes Board cards — on-mission)', () => {
    // The worker turns appContext OFF for leanness; supply's whole job is
    // writing the Board, so the board-API usage card is exactly on-mission.
    expect(base.appContext).toBe(true)
  })

  it('runs at the shared top tier (SWARM_LAUNCH_MODEL) / max', () => {
    expect(base.model).toBe(SWARM_LAUNCH_MODEL)
    expect(base.effort).toBe('max')
  })

  it('starts with Remote Control ON — legacy fixed name when no remoteName resolved', () => {
    // remoteName absent (legacy caller / resolution failed) ⇒ the historical
    // fixed 'supply', so Remote Control is never silently OFF.
    expect(base.remoteControl).toBe('supply')
  })

  it('threads the resolved IDENTIFIABLE Remote Control name through (opts.remoteName)', () => {
    // spawnSwarmSupply resolves 「タスク窓口 <プロジェクト表示名>」/ "Supply officer
    // <project>" via resolveSwarmRemoteName so the claude.ai / mobile list reads
    // WHICH project's supply desk this is (owner feedback 2026-07-18).
    const named = supplyLaunchOpts('/proj', 'sid-rc', { remoteName: 'タスク窓口 受注管理', lang: 'en' })
    expect(named.remoteControl).toBe('タスク窓口 受注管理')
  })

  it('delivers /supply as the positional prompt (claude runs the skill on startup)', () => {
    expect(base.initialPrompt).toBe('/supply' + languageDirective('en'))
    expect(SUPPLY_INJECTION).toBe('/supply')
  })

  it('forwards cols/rows when given', () => {
    const o = supplyLaunchOpts('/repo', 'sid-2', { cols: 100, rows: 30, lang: 'en' })
    expect(o.cols).toBe(100)
    expect(o.rows).toBe(30)
  })

  it('leaves cols/rows undefined when omitted (launchClaude defaults apply)', () => {
    expect(base.cols).toBeUndefined()
    expect(base.rows).toBeUndefined()
  })

  describe('lang (Settings.language ⇒ the supply officer replies in that language)', () => {
    // `lang` is REQUIRED (2026-08-13 rework) — "omitted" no longer compiles.
    // Literal markers, not `toBe(X + languageDirective(lang))`, so a mutation
    // that silently drops the directive on one branch still shows as red
    // (see swarmWorker.test.ts for the same pattern).
    it('en ⇒ appends the English reply-language directive (literal marker)', () => {
      const o = supplyLaunchOpts('/repo', 'sid-lang-en', { lang: 'en' })
      expect(o.initialPrompt!.startsWith(SUPPLY_INJECTION)).toBe(true)
      expect(o.initialPrompt).toContain('[Reply language]')
      expect(o.initialPrompt).not.toContain('【返答言語】')
    })
    it('ja ⇒ appends the Japanese reply-language directive (literal marker)', () => {
      const o = supplyLaunchOpts('/repo', 'sid-lang-ja', { lang: 'ja' })
      expect(o.initialPrompt!.startsWith(SUPPLY_INJECTION)).toBe(true)
      expect(o.initialPrompt).toContain('【返答言語】')
      expect(o.initialPrompt).not.toContain('[Reply language]')
    })
    it('resume + lang ⇒ directive rides the resume prompt too (literal marker)', () => {
      const o = supplyLaunchOpts('/repo', 'sid-lang-resume', { resume: true, lang: 'ja' })
      expect(o.initialPrompt!.startsWith(SUPPLY_RESUME_INJECTION)).toBe(true)
      expect(o.initialPrompt).toContain('【返答言語】')
    })
  })

  // ── RESUME (swarmSessions.ts): the desk survives an app restart ───────────
  describe('resume', () => {
    const resumed = supplyLaunchOpts('/repo', 'sid-old', { resume: true, lang: 'en' })

    it('a FRESH launch is byte-identical to the pre-resume contract (no `resume` flag)', () => {
      // The old behaviour must be untouched when there is nothing to resume — this is
      // the branch every first launch (and every fail-open fallback) still takes.
      expect(base.resume).toBeUndefined()
      expect(base.initialPrompt).toBe(SUPPLY_INJECTION + languageDirective('en'))
    })

    it('a RESUMED launch reaches `claude --resume <id>` — never `--session-id`', () => {
      // The end of the wire: buildClaudeArgv's long-dormant --resume branch is finally
      // fed. Getting this wrong (both flags, or the wrong one) silently starts a NEW
      // conversation, which is the exact bug this feature exists to kill.
      expect(resumed.resume).toBe(true)
      const argv = buildClaudeArgv(resumed, null, null, null, 'darwin')
      expect(argv).toContain('--resume')
      expect(argv[argv.indexOf('--resume') + 1]).toBe('sid-old')
      expect(argv).not.toContain('--session-id')
    })

    it('tells the restored desk its Board memory is STALE — re-read before filing', () => {
      // A supply officer resuming from a pre-restart memory files duplicates of cards
      // the commander already merged. The injection must order a re-read of the live
      // Board (the standing 積む前に必ず現状調査 rule), not just re-run the skill.
      expect(resumed.initialPrompt).toBe(SUPPLY_RESUME_INJECTION + languageDirective('en'))
      expect(SUPPLY_RESUME_INJECTION).toMatch(/^\/supply /)
      expect(SUPPLY_RESUME_INJECTION).toContain('Board')
      expect(SUPPLY_RESUME_INJECTION).toContain('todo/doing/review')
    })

    it('keeps the injection to ONE line (the slash-command delivery contract)', () => {
      // Same rule buildOrderInjection (swarmWorker.ts) is built around: a multi-line
      // positional risks being split, or collapsed into a `[Pasted text]` chip where
      // `/supply` is never parsed as a command at all.
      expect(SUPPLY_RESUME_INJECTION).not.toContain('\n')
      expect(SUPPLY_INJECTION).not.toContain('\n')
    })

    it('changes NOTHING else about the launch (bypass / tag / model / remote control)', () => {
      expect(resumed.permissionMode).toBe('bypass')
      expect(resumed.env).toEqual({ SWARM_MANAGER: '1' })
      expect(resumed.strictMcpConfig).toBe(true)
      expect(resumed.appContext).toBe(true)
      expect(resumed.remoteControl).toBe('supply')
      expect(resumed.model).toBe(SWARM_LAUNCH_MODEL)
    })
  })
})

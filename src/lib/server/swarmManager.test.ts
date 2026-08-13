import { SWARM_LAUNCH_MODEL } from './swarmLaunch'
import { describe, it, expect, beforeEach } from 'vitest'
import { buildClaudeArgv } from './claudeTerminal'
import {
  managerLaunchOpts,
  MANAGER_INJECTION,
  MANAGER_RESUME_INJECTION,
  watchDeskForDeathOnArrival,
  DESK_DOA_WINDOW_MS,
} from './swarmManager'
import { isTierCooling, __resetQuotaForTest } from './swarmQuota'
import { languageDirective } from './promptLang'
import type { TerminalInfo } from './terminal'

// spawnSwarmManager spawns a real PTY (needs the `claude` CLI), so it is
// curl-verified on the real machine. Here we pin the PURE launch contract —
// the exact LaunchClaudeOpts the commander conversation runs with — which
// encodes the security-relevant decisions (bypass IN THE REAL CHECKOUT, tagged
// SWARM_MANAGER=1 — a TRUSTED session the worker-only PreToolUse veto does not
// police; the /og-manage skill as the positional prompt).
// Mirrors swarmSupply.test.ts: the commander is the supply officer's sibling —
// same no-worktree, real-tree, tagged-bypass shape, different skill + role.

describe('managerLaunchOpts (commander launch contract)', () => {
  // `lang` is a REQUIRED argument (2026-08-13 rework — see swarmWorker.ts
  // buildOrderInjection's doc comment): every fixture below fixes it to 'en'
  // so the OTHER assertions (bypass/tag/model/…) stay independent of the
  // language describe block further down, which exercises 'en' vs 'ja' itself.
  const base = managerLaunchOpts('/repo', 'sid-1', { lang: 'en' })

  it('runs in the project PRIMARY checkout (cwd), not a worktree', () => {
    expect(base.cwd).toBe('/repo')
    expect(base.agentSessionId).toBe('sid-1')
  })

  it('bypasses permissions so git + Board moves are not gated on every turn', () => {
    expect(base.permissionMode).toBe('bypass')
  })

  it('is TAGGED as the commander (SWARM_MANAGER=1) — a role tag, NOT a guard opt-in', () => {
    // Under WORKER-ONLY guard scoping (2026-07) the PreToolUse veto polices only
    // the confined worker (OPENGROUND_GUARD=1 + write roots); the commander is
    // the TRUSTED human-in-the-loop integration desk, so SWARM_MANAGER=1 only
    // TAGS the session for tooling/skills — the same tag supply carries.
    expect(base.env).toEqual({ SWARM_MANAGER: '1' })
  })

  it('blocks MCP inheritance (strictMcpConfig) — defense-in-depth for an unpoliced trusted session', () => {
    // The commander is NOT policed by the PreToolUse veto (worker-only scoping),
    // so this is no longer a veto-pairing requirement — kept as defense-in-depth
    // so the bypass session boots with only its explicit MCP config (none)
    // instead of inheriting user-scope MCP servers. (See managerLaunchOpts.)
    expect(base.strictMcpConfig).toBe(true)
  })

  it('keeps the app-context card ON (the commander drives the Board — on-mission)', () => {
    // The worker turns appContext OFF for leanness; the commander moves Board
    // cards (todo → review → done) through the app API, so the board-API usage
    // card is exactly on-mission (same call supply makes).
    expect(base.appContext).toBe(true)
  })

  it('runs at the shared top tier (SWARM_LAUNCH_MODEL) / max', () => {
    expect(base.model).toBe(SWARM_LAUNCH_MODEL)
    expect(base.effort).toBe('max')
  })

  it('starts with Remote Control ON — legacy fixed name when no remoteName resolved', () => {
    // remoteName absent (legacy caller / resolution failed) ⇒ the historical
    // fixed 'manager', so Remote Control is never silently OFF.
    expect(base.remoteControl).toBe('manager')
  })

  it('threads the resolved IDENTIFIABLE Remote Control name through (opts.remoteName)', () => {
    // spawnSwarmManager resolves 「マネージャー <プロジェクト表示名>」/ "Manager
    // <project>" via resolveSwarmRemoteName (language = Settings.language) so the
    // claude.ai / mobile session list reads WHICH project's commander this is —
    // the fix for the wall of identical 'manager' rows (owner feedback 2026-07-18).
    const named = managerLaunchOpts('/proj', 'sid-rc', { remoteName: 'マネージャー 受注管理', lang: 'en' })
    expect(named.remoteControl).toBe('マネージャー 受注管理')
  })

  it('delivers /og-manage (the tmux-free commander skill) as the positional prompt', () => {
    // NOT the shell cockpit's /manage: that skill drives tmux panes
    // (swarm-pane.sh dispatch / respawn / swarm-watch), none of which exist
    // inside the app's PTY. The in-app commander runs the app-native sibling,
    // which speaks the app's own HTTP API (POST /api/swarm/worker, GET
    // /api/swarm/workers, …) and never mentions tmux.
    expect(base.initialPrompt).toBe('/og-manage' + languageDirective('en'))
    expect(MANAGER_INJECTION).toBe('/og-manage')
  })

  it('forwards cols/rows when given', () => {
    const o = managerLaunchOpts('/repo', 'sid-2', { cols: 100, rows: 30, lang: 'en' })
    expect(o.cols).toBe(100)
    expect(o.rows).toBe(30)
  })

  it('leaves cols/rows undefined when omitted (launchClaude defaults apply)', () => {
    expect(base.cols).toBeUndefined()
    expect(base.rows).toBeUndefined()
  })

  describe('lang (Settings.language ⇒ the commander replies in that language)', () => {
    // `lang` is REQUIRED (2026-08-13 rework), so "omitted" no longer exists as
    // a call shape — TS refuses to compile it. What is left to prove is that
    // 'en' and 'ja' each carry their OWN literal marker and never the other's
    // (a mutation that swapped `languageDirective('en')` for a blank string on
    // one branch would still satisfy `toBe(X + languageDirective(lang))` if
    // the test derives its expectation from the same function under test —
    // so these check LITERAL substrings instead, matching the worker test's
    // pattern in swarmWorker.test.ts).
    it('en ⇒ appends the English reply-language directive (literal marker)', () => {
      const o = managerLaunchOpts('/repo', 'sid-lang-en', { lang: 'en' })
      expect(o.initialPrompt!.startsWith(MANAGER_INJECTION)).toBe(true)
      expect(o.initialPrompt).toContain('[Reply language]')
      expect(o.initialPrompt).not.toContain('【返答言語】')
    })
    it('ja ⇒ appends the Japanese reply-language directive (literal marker)', () => {
      const o = managerLaunchOpts('/repo', 'sid-lang-ja', { lang: 'ja' })
      expect(o.initialPrompt!.startsWith(MANAGER_INJECTION)).toBe(true)
      expect(o.initialPrompt).toContain('【返答言語】')
      expect(o.initialPrompt).not.toContain('[Reply language]')
    })
    it('resume + lang ⇒ directive rides the resume prompt too (literal marker)', () => {
      const o = managerLaunchOpts('/repo', 'sid-lang-resume', { resume: true, lang: 'ja' })
      expect(o.initialPrompt!.startsWith(MANAGER_RESUME_INJECTION)).toBe(true)
      expect(o.initialPrompt).toContain('【返答言語】')
    })
  })

  // ── RESUME (swarmSessions.ts): the commander survives an app restart ──────
  describe('resume', () => {
    const resumed = managerLaunchOpts('/repo', 'sid-old', { resume: true, lang: 'en' })

    it('a FRESH launch is byte-identical to the pre-resume contract (no `resume` flag)', () => {
      expect(base.resume).toBeUndefined()
      expect(base.initialPrompt).toBe(MANAGER_INJECTION + languageDirective('en'))
    })

    it('a RESUMED launch reaches `claude --resume <id>` — never `--session-id`', () => {
      // buildClaudeArgv's --resume branch existed for months with no caller; this is
      // the wire that finally feeds it. Emitting both flags (or the wrong one) would
      // silently open a NEW conversation — the exact amnesia this feature kills.
      expect(resumed.resume).toBe(true)
      const argv = buildClaudeArgv(resumed, null, null, null, 'darwin')
      expect(argv).toContain('--resume')
      expect(argv[argv.indexOf('--resume') + 1]).toBe('sid-old')
      expect(argv).not.toContain('--session-id')
    })

    it('ORDERS the restored commander to re-read the Board before it speaks', () => {
      // The asymmetry that makes this mandatory: the CONVERSATION survives the restart,
      // the ENGINE's in-memory roster/reviews/quota do NOT — and the restart is usually
      // a RELEASE, so the code moved too. A commander answering from memory describes a
      // world that no longer exists. It must run 「状況」 (the skill's own read-the-world
      // routine: workers + orchestrator + git + Board) and report from what it FINDS.
      expect(resumed.initialPrompt).toBe(MANAGER_RESUME_INJECTION + languageDirective('en'))
      expect(MANAGER_RESUME_INJECTION).toMatch(/^\/og-manage /)
      expect(MANAGER_RESUME_INJECTION).toContain('状況')
      expect(MANAGER_RESUME_INJECTION).toContain('todo/doing/review')
    })

    it('keeps the injection to ONE line (the slash-command delivery contract)', () => {
      // Same rule buildOrderInjection (swarmWorker.ts) is built around: a multi-line
      // positional risks being split, or collapsed into a `[Pasted text]` chip where
      // `/og-manage` is never parsed as a command at all.
      expect(MANAGER_RESUME_INJECTION).not.toContain('\n')
      expect(MANAGER_INJECTION).not.toContain('\n')
    })

    it('changes NOTHING else about the launch (bypass / tag / model / remote control)', () => {
      expect(resumed.permissionMode).toBe('bypass')
      expect(resumed.env).toEqual({ SWARM_MANAGER: '1' })
      expect(resumed.strictMcpConfig).toBe(true)
      expect(resumed.appContext).toBe(true)
      expect(resumed.remoteControl).toBe('manager')
      expect(resumed.model).toBe(SWARM_LAUNCH_MODEL)
    })
  })
})

// ── watchDeskForDeathOnArrival — learn the tier wall from the CORPSE (2026-07-19) ─────
//
// The pre-launch probe is a PREDICTION with a fail-open path; when it misses, the desk
// spawns on a spent tier and prints "You've reached your Fable 5 limit." seconds later.
// This second防壁 turns that death into evidence: a desk that dies ON ARRIVAL saying its
// tier is spent cools the tier so the next spawn doesn't repeat it. The polarity rule is
// strict — ONLY the CLI's quota-refusal wording cools anything, because a mark here is 20
// persisted minutes across every spawn path, so a crash / ^D / transient fault must NOT
// drag a healthy tier down. The exit-watch is injected (deps.watch/screen/now), so no PTY
// is spawned and the whole thing is deterministic. HOME is isolated suite-wide, so the
// markRateLimited disk mirror lands in a throwaway tmp dir.
describe('watchDeskForDeathOnArrival — learn the tier wall from a desk that died on arrival', () => {
  const NOW = Date.parse('2026-07-19T20:28:00Z')
  const FABLE_NOTICE =
    "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model."

  // A fake exit-watch: captures the desk's exit callback so a test FIRES the death when it
  // chooses, and hands back a no-op unsubscribe (onTerminalExit's shape).
  const captureWatch = () => {
    let cb: ((info: TerminalInfo) => void) | null = null
    return {
      watch: (_id: string, onExit: (info: TerminalInfo) => void) => {
        cb = onExit
        return () => {}
      },
      // The real callback ignores its info arg; a bare cast keeps the exit shape honest.
      fire: () => cb?.({} as TerminalInfo),
      registered: () => cb !== null,
    }
  }

  const noForget = async () => false
  const FRESH = false // wasResumed
  const RESUMED = true

  beforeEach(() => __resetQuotaForTest())

  it('a desk that dies INSIDE the window saying its tier is spent COOLS that tier', () => {
    const w = captureWatch()
    let clock = NOW
    watchDeskForDeathOnArrival('t1', 'fable', '/repo', 'sid-1', FRESH, {
      watch: w.watch,
      screen: () => FABLE_NOTICE,
      now: () => clock,
      forget: noForget,
    })
    clock = NOW + 2_000 // refused ~2s after opening (measured 1.4–3.8s)
    w.fire()
    expect(isTierCooling('fable', clock)).toBe(true)
  })

  it('a desk that dies of something OTHER than quota does NOT cool the tier (a crash ≠ a wall)', () => {
    const w = captureWatch()
    let clock = NOW
    watchDeskForDeathOnArrival('t1', 'fable', '/repo', 'sid-1', FRESH, {
      watch: w.watch,
      screen: () => 'panic: runtime out of memory',
      now: () => clock,
      forget: noForget,
    })
    clock = NOW + 2_000
    w.fire()
    expect(isTierCooling('fable', clock)).toBe(false)
  })

  it('a desk that OUTLIVED the window says nothing about its tier — its later death is not a wall', () => {
    const w = captureWatch()
    let clock = NOW
    watchDeskForDeathOnArrival('t1', 'fable', '/repo', 'sid-1', FRESH, {
      watch: w.watch,
      screen: () => FABLE_NOTICE,
      now: () => clock,
      forget: noForget,
    })
    clock = NOW + DESK_DOA_WINDOW_MS + 1 // it did real work, THEN exited
    w.fire()
    expect(isTierCooling('fable', clock)).toBe(false)
  })

  it('a missing screen cools nothing (best-effort — learned nothing, never a throw)', () => {
    const w = captureWatch()
    let clock = NOW
    watchDeskForDeathOnArrival('t1', 'fable', '/repo', 'sid-1', FRESH, {
      watch: w.watch,
      screen: () => null,
      now: () => clock,
      forget: noForget,
    })
    clock = NOW + 2_000
    w.fire()
    expect(isTierCooling('fable', clock)).toBe(false)
  })

  it('a non-ladder model string is never watched nor cooled (only real tiers cool)', () => {
    const w = captureWatch()
    watchDeskForDeathOnArrival('t1', 'gpt-5', '/repo', 'sid-1', FRESH, {
      watch: w.watch,
      screen: () => FABLE_NOTICE,
      now: () => NOW,
      forget: noForget,
    })
    expect(w.registered()).toBe(false) // returned before ever arming the watch
  })

  it('a FRESH desk that dies quoting a spent tier forgets its stale (refusal-only) session pointer', () => {
    const w = captureWatch()
    let clock = NOW
    let forgotten: [string, string, string] | null = null
    watchDeskForDeathOnArrival('t1', 'fable', '/repo', 'sid-quota-death', FRESH, {
      watch: w.watch,
      screen: () => FABLE_NOTICE,
      now: () => clock,
      forget: async (projectPath, role, sessionId) => {
        forgotten = [projectPath, role, sessionId]
        return true
      },
    })
    clock = NOW + 2_000
    w.fire()
    expect(forgotten).toEqual(['/repo', 'manager', 'sid-quota-death'])
  })

  it('a RESUMED desk that dies quoting a spent tier does NOT forget its session — its transcript is real history, not just a refusal', () => {
    const w = captureWatch()
    let clock = NOW
    let forgetCalled = false
    watchDeskForDeathOnArrival('t1', 'fable', '/repo', 'sid-days-of-history', RESUMED, {
      watch: w.watch,
      screen: () => FABLE_NOTICE,
      now: () => clock,
      forget: async () => {
        forgetCalled = true
        return true
      },
    })
    clock = NOW + 2_000
    w.fire()
    // The tier still cools (that part is unconditional)…
    expect(isTierCooling('fable', clock)).toBe(true)
    // …but the days of accumulated conversation the session id points at must
    // survive so the NEXT launch can still `--resume` it.
    expect(forgetCalled).toBe(false)
  })

  it('a desk that dies of something other than quota does NOT touch the session pointer', () => {
    const w = captureWatch()
    let clock = NOW
    let forgetCalled = false
    watchDeskForDeathOnArrival('t1', 'fable', '/repo', 'sid-1', FRESH, {
      watch: w.watch,
      screen: () => 'panic: runtime out of memory',
      now: () => clock,
      forget: async () => {
        forgetCalled = true
        return true
      },
    })
    clock = NOW + 2_000
    w.fire()
    expect(forgetCalled).toBe(false)
  })
})

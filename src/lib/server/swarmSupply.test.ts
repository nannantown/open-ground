import { SWARM_LAUNCH_MODEL } from './swarmLaunch'
import { describe, it, expect } from 'vitest'
import { supplyLaunchOpts, SUPPLY_INJECTION } from './swarmSupply'

// spawnSwarmSupply spawns a real PTY (needs the `claude` CLI), so it is
// curl-verified on the real machine. Here we pin the PURE launch contract —
// the exact LaunchClaudeOpts the supply officer runs with — which encodes the
// security-relevant decisions (bypass IN THE REAL CHECKOUT, tagged
// SWARM_MANAGER=1 — a TRUSTED session the worker-only PreToolUse veto does not
// police; the /supply skill as the positional prompt).

describe('supplyLaunchOpts (supply launch contract)', () => {
  const base = supplyLaunchOpts('/repo', 'sid-1')

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

  it('starts with Remote Control ON, named "supply" (mirrors --remote-control supply)', () => {
    // swarm-supply.sh runs `… --remote-control supply "/supply"`; the in-app
    // supply officer must match so it is controllable from claude.ai / mobile
    // with no manual toggle.
    expect(base.remoteControl).toBe('supply')
  })

  it('delivers /supply as the positional prompt (claude runs the skill on startup)', () => {
    expect(base.initialPrompt).toBe('/supply')
    expect(SUPPLY_INJECTION).toBe('/supply')
  })

  it('forwards cols/rows when given', () => {
    const o = supplyLaunchOpts('/repo', 'sid-2', { cols: 100, rows: 30 })
    expect(o.cols).toBe(100)
    expect(o.rows).toBe(30)
  })

  it('leaves cols/rows undefined when omitted (launchClaude defaults apply)', () => {
    expect(base.cols).toBeUndefined()
    expect(base.rows).toBeUndefined()
  })
})

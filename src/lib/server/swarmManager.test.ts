import { SWARM_LAUNCH_MODEL } from './swarmLaunch'
import { describe, it, expect } from 'vitest'
import { managerLaunchOpts, MANAGER_INJECTION } from './swarmManager'

// spawnSwarmManager spawns a real PTY (needs the `claude` CLI), so it is
// curl-verified on the real machine. Here we pin the PURE launch contract —
// the exact LaunchClaudeOpts the commander conversation runs with — which
// encodes the security-relevant decisions (bypass IN THE REAL CHECKOUT, tagged
// SWARM_MANAGER=1 — a TRUSTED session the worker-only PreToolUse veto does not
// police; the /og-manage skill as the positional prompt).
// Mirrors swarmSupply.test.ts: the commander is the supply officer's sibling —
// same no-worktree, real-tree, tagged-bypass shape, different skill + role.

describe('managerLaunchOpts (commander launch contract)', () => {
  const base = managerLaunchOpts('/repo', 'sid-1')

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

  it('starts with Remote Control ON, named "manager" (mirrors --remote-control manager)', () => {
    // The shell cockpit runs the commander `… --remote-control manager "/manage"`;
    // the in-app commander must match so it is controllable from claude.ai /
    // mobile with no manual toggle.
    expect(base.remoteControl).toBe('manager')
  })

  it('delivers /og-manage (the tmux-free commander skill) as the positional prompt', () => {
    // NOT the shell cockpit's /manage: that skill drives tmux panes
    // (swarm-pane.sh dispatch / respawn / swarm-watch), none of which exist
    // inside the app's PTY. The in-app commander runs the app-native sibling,
    // which speaks the app's own HTTP API (POST /api/swarm/worker, GET
    // /api/swarm/workers, …) and never mentions tmux.
    expect(base.initialPrompt).toBe('/og-manage')
    expect(MANAGER_INJECTION).toBe('/og-manage')
  })

  it('forwards cols/rows when given', () => {
    const o = managerLaunchOpts('/repo', 'sid-2', { cols: 100, rows: 30 })
    expect(o.cols).toBe(100)
    expect(o.rows).toBe(30)
  })

  it('leaves cols/rows undefined when omitted (launchClaude defaults apply)', () => {
    expect(base.cols).toBeUndefined()
    expect(base.rows).toBeUndefined()
  })
})

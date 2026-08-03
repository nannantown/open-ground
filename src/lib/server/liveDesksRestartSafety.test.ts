import { describe, it, expect } from 'vitest'
import { computeRestartSafety } from './liveDesks'

// The pure core of "may the app restart itself to apply an update?"
// (liveDesks.computeRestartSafety — file named liveDesks* so the swarm self-modification gate (SWARM_CODE_PATHS) covers it by convention; served as GET /api/update/restart-safety,
// consumed fail-closed by electron/main.js). The pinned policy:
//   blocks — claude mid-generation (either pool), any visible user PTY pane
//   allows — resting desks, engine-owned worktree PTYs, hidden utility
//            sessions at rest, waiting/quota-parked SDK sessions
// Each case states the OPERATIONAL consequence a flip would cause.

const pty = (p: Partial<{ desk: boolean; hidden: boolean; engine: boolean; claudeWorking: boolean }>) => ({
  desk: false,
  hidden: false,
  engine: false,
  claudeWorking: false,
  ...p,
})

describe('computeRestartSafety', () => {
  it('empty pools ⇒ safe', () => {
    expect(computeRestartSafety([], [])).toEqual({ safe: true, generating: 0, userPtys: 0 })
  })

  it('a resting desk PTY (補給官 at the prompt) does NOT block — it resumes by design', () => {
    expect(computeRestartSafety([pty({ desk: true })], []).safe).toBe(true)
  })

  it('a desk PTY mid-generation blocks — cutting the turn loses it', () => {
    const r = computeRestartSafety([pty({ desk: true, claudeWorking: true })], [])
    expect(r.safe).toBe(false)
    expect(r.generating).toBe(1)
  })

  it('a visible user PTY pane blocks even at rest — user state with no resume machinery', () => {
    const r = computeRestartSafety([pty({})], [])
    expect(r.safe).toBe(false)
    expect(r.userPtys).toBe(1)
  })

  it('an engine-owned worktree PTY (swarm worker) at rest does NOT block — roster recovery owns it', () => {
    expect(computeRestartSafety([pty({ engine: true })], []).safe).toBe(true)
  })

  it('an engine-owned worktree PTY mid-generation still blocks', () => {
    expect(computeRestartSafety([pty({ engine: true, claudeWorking: true })], []).safe).toBe(false)
  })

  it('a hidden utility session at rest does NOT block; mid-generation it does', () => {
    expect(computeRestartSafety([pty({ hidden: true })], []).safe).toBe(true)
    expect(computeRestartSafety([pty({ hidden: true, claudeWorking: true })], []).safe).toBe(false)
  })

  it('SDK working/starting block; waiting and quota-parked do not (resume + repark by design)', () => {
    expect(computeRestartSafety([], ['working']).safe).toBe(false)
    expect(computeRestartSafety([], ['starting']).safe).toBe(false)
    expect(computeRestartSafety([], ['waiting']).safe).toBe(true)
    expect(computeRestartSafety([], ['quota-parked']).safe).toBe(true)
  })

  it('counts add up across pools (the log line the owner reads)', () => {
    const r = computeRestartSafety(
      [pty({ claudeWorking: true }), pty({}), pty({ desk: true })],
      ['working', 'waiting'],
    )
    // pty#1: generating AND a user pane (both true — it is a user claude mid-turn)
    expect(r).toEqual({ safe: false, generating: 2, userPtys: 2 })
  })
})

import { describe, it, expect } from 'vitest'
import { computeRestartSafety, IDLE_PANE_MS } from './liveDesks'

// The pure core of "may the app restart itself to apply an update?"
// (liveDesks.computeRestartSafety — file named liveDesks* so the swarm self-modification gate (SWARM_CODE_PATHS) covers it by convention; served as GET /api/update/restart-safety,
// consumed fail-closed by electron/main.js). The pinned policy:
//   blocks — claude mid-generation (either pool), any visible user PTY pane
//   allows — resting desks, engine-owned worktree PTYs, hidden utility
//            sessions at rest, waiting/quota-parked SDK sessions
// Each case states the OPERATIONAL consequence a flip would cause.

// A pane defaults to WORKING: foreground is something other than a shell, and it
// painted just now. Tests opt in to "abandoned" explicitly, so the dangerous
// direction (a busy pane read as idle) cannot be reached by forgetting a field.
const NOW = 1_700_000_000_000
const pty = (
  p: Partial<{
    desk: boolean
    hidden: boolean
    engine: boolean
    claudeWorking: boolean
    foreground: string
    lastOutputAt: number
    hasChildren: boolean
  }>,
) => ({
  desk: false,
  hidden: false,
  engine: false,
  claudeWorking: false,
  foreground: 'claude',
  lastOutputAt: NOW,
  hasChildren: true,
  ...p,
})
/** A pane with nothing in it — no foreground command, no background job, and
 *  untouched for longer than the idle window. All three, deliberately. */
const abandoned = () =>
  pty({ foreground: 'zsh', lastOutputAt: NOW - IDLE_PANE_MS - 1, hasChildren: false })

describe('computeRestartSafety', () => {
  it('empty pools ⇒ safe', () => {
    expect(computeRestartSafety([], [], NOW)).toEqual({ safe: true, generating: 0, userPtys: 0 })
  })

  it('a resting desk PTY (補給官 at the prompt) does NOT block — it resumes by design', () => {
    expect(computeRestartSafety([pty({ desk: true })], [], NOW).safe).toBe(true)
  })

  it('a desk PTY mid-generation blocks — cutting the turn loses it', () => {
    const r = computeRestartSafety([pty({ desk: true, claudeWorking: true })], [], NOW)
    expect(r.safe).toBe(false)
    expect(r.generating).toBe(1)
  })

  // ⚠ RE-AIMED 2026-08-04. This used to read "a visible user PTY pane blocks even
  // at rest", and that sentence is why hands-free updates never fired ONCE. It
  // treated "a pane is open" as "work is happening". Measured on the owner's own
  // machine: the two panes holding the gate shut were `/bin/zsh -l` with zero
  // child processes, open and untouched for 1h23m. A gate that never opens is a
  // disabled feature wearing the word "safety".
  //
  // What blocks is now WORK, and it takes two signals to say there is none.
  it('a user pane running something blocks, however quiet it has been', () => {
    // The trap on the other side: a foreground `claude` can think for minutes
    // without painting. Silence alone must never mean idle.
    const r = computeRestartSafety(
      [pty({ foreground: 'claude', lastOutputAt: NOW - 60 * 60 * 1000 })],
      [],
      NOW,
    )
    expect(r.safe).toBe(false)
    expect(r.userPtys).toBe(1)
  })

  it('a bare shell that painted a moment ago still blocks — between two commands', () => {
    const r = computeRestartSafety([pty({ foreground: 'zsh', lastOutputAt: NOW - 1000 })], [], NOW)
    expect(r.safe).toBe(false)
    expect(r.userPtys).toBe(1)
  })

  it('an EMPTY, long-untouched pane does not block — there is nothing to destroy', () => {
    const r = computeRestartSafety([abandoned()], [], NOW)
    expect(r.safe).toBe(true)
    expect(r.userPtys).toBe(0)
  })

  it('the owner\u2019s actual blocked state now clears', () => {
    // Reproduces GET /api/update/restart-safety as measured on 2026-08-04:
    // {"safe":false,"generating":0,"userPtys":2}, both panes empty login shells
    // open for 1h23m. This is the case the whole change exists for.
    const r = computeRestartSafety([abandoned(), abandoned()], [], NOW)
    expect(r).toEqual({ safe: true, generating: 0, userPtys: 0 })
  })

  it('a shell with a BACKGROUND job blocks — the hole the foreground check alone left', () => {
    // Measured 2026-08-04 with a throwaway node-pty: after `sleep 300 &` the
    // prompt returns and `.process` reports "zsh". Nothing is in front, nothing
    // is painting — and a build or a test run is very much alive. Two signals
    // said "abandoned" here; the third is the one that knows.
    const r = computeRestartSafety(
      [pty({ foreground: 'zsh', lastOutputAt: NOW - 60 * 60 * 1000, hasChildren: true })],
      [],
      NOW,
    )
    expect(r.safe).toBe(false)
    expect(r.userPtys).toBe(1)
  })

  it('an unknown child-process answer counts as work — fail closed', () => {
    // The probe cannot run (no pid, Windows, spawn error, timeout). Undefined
    // must never read as "no children".
    const r = computeRestartSafety(
      [pty({ foreground: 'zsh', lastOutputAt: NOW - 60 * 60 * 1000, hasChildren: undefined })],
      [],
      NOW,
    )
    expect(r.safe).toBe(false)
  })

  it('an unreadable foreground counts as work — fail closed', () => {
    // `.process` can throw on a pty that died mid-probe; terminal.ts yields ''.
    // The empty string must not look like a shell.
    const r = computeRestartSafety([pty({ foreground: '', lastOutputAt: 0 })], [], NOW)
    expect(r.safe).toBe(false)
  })

  it('an engine-owned worktree PTY (swarm worker) at rest does NOT block — roster recovery owns it', () => {
    expect(computeRestartSafety([pty({ engine: true })], [], NOW).safe).toBe(true)
  })

  it('an engine-owned worktree PTY mid-generation still blocks', () => {
    expect(computeRestartSafety([pty({ engine: true, claudeWorking: true })], [], NOW).safe).toBe(false)
  })

  it('a hidden utility session at rest does NOT block; mid-generation it does', () => {
    expect(computeRestartSafety([pty({ hidden: true })], [], NOW).safe).toBe(true)
    expect(computeRestartSafety([pty({ hidden: true, claudeWorking: true })], [], NOW).safe).toBe(false)
  })

  it('SDK working/starting block; waiting and quota-parked do not (resume + repark by design)', () => {
    expect(computeRestartSafety([], ['working'], NOW).safe).toBe(false)
    expect(computeRestartSafety([], ['starting'], NOW).safe).toBe(false)
    expect(computeRestartSafety([], ['waiting'], NOW).safe).toBe(true)
    expect(computeRestartSafety([], ['quota-parked'], NOW).safe).toBe(true)
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

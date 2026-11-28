import { describe, it, expect, beforeEach } from 'vitest'
import {
  recycleDeskSessionIfOverCap,
  deskRecycledLogLine,
  deskCompactedLogLine,
  MANAGER_CONTEXT_CAP,
  managerContextCapTokens,
} from './deskContextCap'
import { idleManagerDeskOverCap, managerDeskIdle } from './swarmManager'
import { BG_TASK_GRACE_MS } from './swarmOrchestrator'
import { setSettings, setUserSettings, getDeskContextCapTokens } from './store'
import type { ManagerDeskHandle } from './swarmManagerRuntime'
import type { SdkSessionInfo } from './sdkSession'

// The commander's recycle decision (owner decision 2026-09-18). Fail-OPEN is the
// contract: any doubt ⇒ resume exactly as before — a conversation is only ever
// dropped on a MEASURED fill at or over a POSITIVE cap.
describe('recycleDeskSessionIfOverCap', () => {
  const RESUME = { agentSessionId: 'old-sid', resume: true }
  const deps = (tokens: number | null, cap = 300_000) => ({
    contextTokens: async () => tokens,
    cap: async () => cap,
    newId: () => 'new-sid',
  })

  it('under the cap ⇒ resumes the SAME conversation (the historical behaviour)', async () => {
    const r = await recycleDeskSessionIfOverCap(RESUME, deps(299_999))
    expect(r).toEqual({ session: RESUME, recycledFromTokens: null })
  })

  it('at/over the cap ⇒ a NEW conversation, not resumed, and says what it dropped', async () => {
    for (const t of [300_000, 346_076]) {
      const r = await recycleDeskSessionIfOverCap(RESUME, deps(t))
      expect(r.session).toEqual({ agentSessionId: 'new-sid', resume: false })
      expect(r.recycledFromTokens).toBe(t)
    }
  })

  it('an unmeasurable fill ⇒ resume (never drop a conversation on a guess)', async () => {
    expect((await recycleDeskSessionIfOverCap(RESUME, deps(null))).session).toBe(RESUME)
    const throwing = { ...deps(999_999), contextTokens: async () => Promise.reject(new Error('io')) }
    expect((await recycleDeskSessionIfOverCap(RESUME, throwing)).session).toBe(RESUME)
    const badCap = { ...deps(999_999), cap: async () => Promise.reject(new Error('settings')) }
    expect((await recycleDeskSessionIfOverCap(RESUME, badCap)).session).toBe(RESUME)
  })

  it('cap 0 = off ⇒ always resume', async () => {
    expect((await recycleDeskSessionIfOverCap(RESUME, deps(900_000, 0))).recycledFromTokens).toBeNull()
  })

  it('a FRESH session is left alone and not even measured', async () => {
    let measured = false
    const fresh = { agentSessionId: 'f', resume: false }
    const r = await recycleDeskSessionIfOverCap(fresh, {
      ...deps(900_000),
      contextTokens: async () => {
        measured = true
        return 900_000
      },
    })
    expect(r.session).toBe(fresh)
    expect(measured).toBe(false)
  })
})

// ── The commander's own cap (docs/AUTONOMY-SPEC.md R-D3b, 2026-11-28) ─────────
// Measured: 237k average context per commander call against the shared 300k cap,
// and a commander that stays up was never measured at all. The commander now has
// its own, lower default; the owner's Settings value still overrides both desks.
describe('MANAGER_CONTEXT_CAP — the commander default', () => {
  beforeEach(async () => {
    await setSettings({ deskContextCapTokens: undefined })
  })

  it('is 120,000 and applies when the owner set nothing (the supply desk keeps its 300,000)', async () => {
    expect(MANAGER_CONTEXT_CAP).toBe(120_000)
    expect(await managerContextCapTokens()).toBe(120_000)
    expect(await getDeskContextCapTokens()).toBe(300_000)
  })

  it('Settings.deskContextCapTokens still overrides it — read back through the production reader', async () => {
    await setUserSettings({ deskContextCapTokens: 200_000 })
    expect(await managerContextCapTokens()).toBe(200_000)
    await setUserSettings({ deskContextCapTokens: 0 })
    expect(await managerContextCapTokens()).toBe(0)
  })

  it('the spawn-time recycle uses it by default: a 150k conversation opens fresh (it resumed under 300k)', async () => {
    const r = await recycleDeskSessionIfOverCap(
      { agentSessionId: 'old', resume: true },
      { contextTokens: async () => 150_000, newId: () => 'new' },
    )
    expect(r).toEqual({ session: { agentSessionId: 'new', resume: false }, recycledFromTokens: 150_000 })
  })
})

describe('idleManagerDeskOverCap — the measurement behind the cap at wake', () => {
  const desk = (over: Partial<ManagerDeskHandle> = {}): ManagerDeskHandle => ({
    runtime: 'sdk',
    handleId: 'sdk-m1',
    cwd: '/repo',
    agentSessionId: 'sid-m1',
    lastOutputAt: 1,
    startedAt: 1,
    stopping: false,
    ...over,
  })
  const session = (over: Partial<SdkSessionInfo> = {}): SdkSessionInfo =>
    ({ id: 'sdk-m1', cwd: '/repo', role: 'manager', status: 'waiting', startedAt: 1, lastEventAt: 1, seq: 3, ...over }) as SdkSessionInfo
  const deps = (over: Record<string, unknown> = {}) => ({
    desks: () => [desk()],
    session: () => session(),
    paused: () => false,
    backgroundTaskAt: async () => null,
    contextTokens: async () => 150_000,
    cap: async () => 120_000,
    ...over,
  })

  it('an IDLE SDK desk at or over the cap ⇒ its conversation and fill', async () => {
    expect(await idleManagerDeskOverCap('/repo', deps())).toEqual({ agentSessionId: 'sid-m1', tokens: 150_000 })
    expect(await idleManagerDeskOverCap('/repo', deps({ contextTokens: async () => 120_000 }))).toEqual({
      agentSessionId: 'sid-m1',
      tokens: 120_000,
    })
  })

  it('a BUSY desk is never reported — mid-turn, a command running, paused on a limit, a background task', async () => {
    for (const status of ['working', 'starting', 'quota-parked', 'exited'] as const) {
      expect(await idleManagerDeskOverCap('/repo', deps({ session: () => session({ status }) })), status).toBeNull()
    }
    expect(await idleManagerDeskOverCap('/repo', deps({ session: () => session({ toolCallsInFlight: 1 }) }))).toBeNull()
    expect(await idleManagerDeskOverCap('/repo', deps({ paused: () => true }))).toBeNull()
    expect(await idleManagerDeskOverCap('/repo', deps({ backgroundTaskAt: async () => Date.now() - 60_000 }))).toBeNull()
  })

  it('a background command older than the run grace is an orphan, not a busy desk (review R2-M2)', async () => {
    // One start whose end record never landed (an app restart mid-run, a lost
    // notification) used to refuse the recycle for the rest of the conversation.
    const orphan = deps({ backgroundTaskAt: async () => Date.now() - BG_TASK_GRACE_MS - 60_000 })
    expect(await idleManagerDeskOverCap('/repo', orphan)).toEqual({ agentSessionId: 'sid-m1', tokens: 150_000 })
  })

  it('nothing to close: under the cap, cap off, unreadable fill, a PTY desk, a stopping desk, no desk', async () => {
    expect(await idleManagerDeskOverCap('/repo', deps({ contextTokens: async () => 119_999 }))).toBeNull()
    expect(await idleManagerDeskOverCap('/repo', deps({ cap: async () => 0 }))).toBeNull()
    expect(await idleManagerDeskOverCap('/repo', deps({ contextTokens: async () => null }))).toBeNull()
    expect(await idleManagerDeskOverCap('/repo', deps({ desks: () => [desk({ runtime: 'pty' })] }))).toBeNull()
    expect(await idleManagerDeskOverCap('/repo', deps({ desks: () => [desk({ stopping: true })] }))).toBeNull()
    expect(await idleManagerDeskOverCap('/repo', deps({ desks: () => [] }))).toBeNull()
  })

  it('managerDeskIdle — the synchronous re-check the teardown runs right before it closes', () => {
    expect(managerDeskIdle('sdk-m1', { session: () => session(), paused: () => false })).toBe(true)
    expect(managerDeskIdle('sdk-m1', { session: () => session({ status: 'working' }), paused: () => false })).toBe(false)
    expect(managerDeskIdle('sdk-m1', { session: () => null, paused: () => false })).toBe(false)
  })
})

describe('engine-log lines', () => {
  it('say what happened in the owner’s words, with the numbers', () => {
    expect(deskRecycledLogLine('司令官', 346_076)).toContain('司令官の卓を作り直した(文脈 346,076 から 0 へ)')
    expect(deskCompactedLogLine('補給官', 965_390, 170_458)).toBe('補給官の卓を圧縮した(文脈 965,390 から 170,458 へ)')
    expect(deskCompactedLogLine('補給官', 400_000, null)).toContain('から 不明 へ')
  })
})

// The commander runtime seam: "is there a desk, and can I speak to it?" across
// BOTH pools.
//
// What these tests are really protecting is the one-desk-per-project invariant.
// Eleven commander desks once accumulated in three hours because existence was
// decided from a store that could desync; the fix was to decide it from the
// pool. Stage 3 adds a SECOND pool, and a probe that only asks the first one
// reproduces the incident by construction — it would call a healthy SDK desk
// absent and ask for a replacement every pass.

import { describe, it, expect, vi } from 'vitest'
import {
  listManagerDesks,
  isManagerDeskAlive,
  managerDeskForSession,
  sayToManagerDesk,
  managerDeskScreen,
  managerDeskSummary,
  type ManagerDeskHandle,
} from './swarmManagerRuntime'
import type { SdkSessionInfo } from './sdkSession'
import type { OwnerDeskTerminal } from './terminal'

const ptyDesk = (over: Partial<OwnerDeskTerminal> = {}): OwnerDeskTerminal =>
  ({
    id: 'term-1',
    cwd: '/repo',
    agentSessionId: 'sess-pty',
    deskLabel: '司令官',
    lastOutputAt: 1_000,
    startedAtMs: 500,
    ...over,
  }) as OwnerDeskTerminal

const sdkDesk = (over: Partial<SdkSessionInfo> = {}): SdkSessionInfo => ({
  id: 'sdk-1',
  cwd: '/repo',
  role: 'manager',
  agentSessionId: 'sess-sdk',
  status: 'working',
  startedAt: 900,
  lastEventAt: 2_000,
  seq: 3,
  ...over,
})

describe('listManagerDesks', () => {
  it('finds a desk in EITHER pool', () => {
    expect(
      listManagerDesks('/repo', {
        ptyDesks: () => [ptyDesk()],
        ptyAlive: () => true,
        sdkDesks: () => [],
      }),
    ).toHaveLength(1)
    expect(
      listManagerDesks('/repo', {
        ptyDesks: () => [],
        ptyAlive: () => true,
        sdkDesks: () => [sdkDesk()],
      })[0],
    ).toMatchObject({ runtime: 'sdk', handleId: 'sdk-1', agentSessionId: 'sess-sdk' })
  })

  it('an SDK desk alone is NOT "no desk" — the twin-spawn trigger must not fire', () => {
    // The whole point: with a PTY-only sweep this returned [], the engine read
    // 'absent', and it would have seated a second commander every five minutes.
    const desks = listManagerDesks('/repo', {
      ptyDesks: () => [],
      ptyAlive: () => true,
      sdkDesks: () => [sdkDesk()],
    })
    expect(desks.length).toBeGreaterThan(0)
  })

  it('drops a PTY entry the OS already reaped (finishedAt lands asynchronously)', () => {
    expect(
      listManagerDesks('/repo', {
        ptyDesks: () => [ptyDesk()],
        ptyAlive: () => false,
        sdkDesks: () => [],
      }),
    ).toEqual([])
  })

  it('reports both when a project somehow holds one of each, newest first', () => {
    const all = listManagerDesks('/repo', {
      ptyDesks: () => [ptyDesk({ startedAtMs: 500 })],
      ptyAlive: () => true,
      sdkDesks: () => [sdkDesk({ startedAt: 900 })],
    })
    expect(all.map((d) => d.runtime)).toEqual(['sdk', 'pty'])
  })

  it('a live-but-silent SDK desk reports no output rather than "painted at spawn"', () => {
    const [d] = listManagerDesks('/repo', {
      ptyDesks: () => [],
      ptyAlive: () => true,
      sdkDesks: () => [sdkDesk({ seq: 0, lastEventAt: 12_345 })],
    })
    expect(d.lastOutputAt).toBeNull()
  })

  it('never returns a worker session — the role filter is the pool query, not a post-filter', () => {
    const sdkDesks = vi.fn(() => [])
    listManagerDesks('/repo', { ptyDesks: () => [], ptyAlive: () => true, sdkDesks })
    expect(sdkDesks).toHaveBeenCalledWith('/repo', 'manager')
  })
})

describe('isManagerDeskAlive', () => {
  const h = (runtime: 'pty' | 'sdk'): ManagerDeskHandle => ({
    runtime,
    handleId: 'x',
    cwd: '/repo',
    agentSessionId: null,
    lastOutputAt: null,
    startedAt: 0,
    stopping: false,
  })

  it('asks the pool that owns the handle, and only that one', () => {
    const ptyAlive = vi.fn(() => true)
    const sdkAlive = vi.fn(() => true)
    isManagerDeskAlive(h('pty'), { ptyAlive, sdkAlive })
    expect(ptyAlive).toHaveBeenCalledOnce()
    expect(sdkAlive).not.toHaveBeenCalled()
    isManagerDeskAlive(h('sdk'), { ptyAlive, sdkAlive })
    expect(sdkAlive).toHaveBeenCalledOnce()
  })
})

describe('managerDeskForSession', () => {
  const dead = { live: false, lastOutputAt: null, terminalId: null }

  it('prefers the live PTY holding that conversation', () => {
    const d = managerDeskForSession('sess-pty', '/repo', {
      activity: () => ({ live: true, lastOutputAt: 7, terminalId: 'term-9' }),
    })
    expect(d).toMatchObject({ runtime: 'pty', handleId: 'term-9' })
  })

  it('falls through to the SDK pool when no PTY holds it', () => {
    const d = managerDeskForSession('sess-sdk', '/repo', {
      activity: () => dead,
      ptyDesks: () => [],
      ptyAlive: () => true,
      sdkDesks: () => [sdkDesk()],
    })
    expect(d).toMatchObject({ runtime: 'sdk', handleId: 'sdk-1' })
  })

  it('does not hand back a desk holding a DIFFERENT conversation', () => {
    expect(
      managerDeskForSession('sess-other', '/repo', {
        activity: () => dead,
        ptyDesks: () => [],
        ptyAlive: () => true,
        sdkDesks: () => [sdkDesk()],
      }),
    ).toBeNull()
  })

  it('an empty session id is never a desk', () => {
    expect(managerDeskForSession('', '/repo')).toBeNull()
  })
})

describe('sayToManagerDesk', () => {
  const pty: ManagerDeskHandle = {
    runtime: 'pty',
    handleId: 'term-1',
    cwd: '/repo',
    agentSessionId: null,
    lastOutputAt: null,
    startedAt: 0,
    stopping: false,
  }
  const sdk: ManagerDeskHandle = { ...pty, runtime: 'sdk', handleId: 'sdk-1' }

  it('PTY: appends CR and respects the deliverability refusal', () => {
    const write = vi.fn(() => true)
    expect(
      sayToManagerDesk(pty, 'hello', { screen: () => 'idle', deliverable: () => true, write }).ok,
    ).toBe(true)
    expect(write).toHaveBeenCalledWith('term-1', 'hello\r')

    write.mockClear()
    const held = sayToManagerDesk(pty, 'hello', {
      screen: () => 'esc to interrupt',
      deliverable: () => false,
      write,
    })
    expect(held).toEqual({ ok: false, heldBecause: 'busy-or-half-typed' })
    expect(write).not.toHaveBeenCalled()
  })

  it('SDK: pushes the text as-is, with NO carriage return', () => {
    const push = vi.fn(() => true)
    expect(sayToManagerDesk(sdk, 'hello', { push }).ok).toBe(true)
    expect(push).toHaveBeenCalledWith('sdk-1', 'hello')
  })

  it('SDK: never consults the screen or the deliverability gate', () => {
    // Not "consults it and always passes" — an SDK desk has no state in which
    // the message must be withheld, and a gate that could say no would build a
    // queue that never drains.
    const screen = vi.fn(() => null)
    const deliverable = vi.fn(() => false)
    const res = sayToManagerDesk(sdk, 'hello', { screen, deliverable, push: () => true })
    expect(res.ok).toBe(true)
    expect(screen).not.toHaveBeenCalled()
    expect(deliverable).not.toHaveBeenCalled()
  })

  it('no desk ⇒ a NAMED failure, not a silent false', () => {
    expect(sayToManagerDesk(null, 'hello')).toEqual({ ok: false, heldBecause: 'no-desk' })
  })
})

describe('screen + summary', () => {
  const pty: ManagerDeskHandle = {
    runtime: 'pty',
    handleId: 'term-1',
    cwd: '/repo',
    agentSessionId: null,
    lastOutputAt: null,
    startedAt: 0,
    stopping: false,
  }
  const sdk: ManagerDeskHandle = { ...pty, runtime: 'sdk', handleId: 'sdk-1' }

  it('an SDK desk has NO screen (null, never an empty string)', () => {
    // A reader that got '' would conclude "nothing on it" and, for the quota
    // watch, that a healthy desk is not stopped — right answer, wrong reason,
    // and wrong the moment the reasoning is reused.
    expect(managerDeskScreen(sdk, { screen: () => 'should not be read' })).toBeNull()
    expect(managerDeskScreen(pty, { screen: () => 'rows' })).toBe('rows')
  })

  it('the summary keeps the identity invariant: exactly one id is non-null', () => {
    expect(managerDeskSummary(pty)).toEqual({ runtime: 'pty', terminalId: 'term-1', sdkSessionId: null })
    expect(managerDeskSummary(sdk)).toEqual({ runtime: 'sdk', terminalId: null, sdkSessionId: 'sdk-1' })
  })
})

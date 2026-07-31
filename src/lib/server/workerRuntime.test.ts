import { describe, it, expect, vi, beforeEach } from 'vitest'

// node-pty is never spawned here: the PTY runtime is a pure delegation, so the
// pool is mocked and the assertions are about WHICH id was delegated with.
const getTerminal = vi.fn()
const getTerminalScreen = vi.fn()
const killTerminal = vi.fn()
vi.mock('./terminal', () => ({
  getTerminal: (id: string) => getTerminal(id),
  getTerminalScreen: (id: string) => getTerminalScreen(id),
  killTerminal: (id: string) => killTerminal(id),
}))

import {
  workerRuntimeKind,
  workerKey,
  runtimeOf,
  ptyWorkerRuntime,
  WorkerHandleError,
} from './workerRuntime'

beforeEach(() => {
  getTerminal.mockReset()
  getTerminalScreen.mockReset()
  killTerminal.mockReset()
})

describe('workerRuntimeKind', () => {
  it("treats an ABSENT runtime as 'pty' — every roster entry written before the field existed", () => {
    expect(workerRuntimeKind({ terminalId: 't1' })).toBe('pty')
  })

  it('honours an explicit kind', () => {
    expect(workerRuntimeKind({ runtime: 'pty', terminalId: 't1' })).toBe('pty')
    expect(workerRuntimeKind({ runtime: 'sdk', sdkSessionId: 's1' })).toBe('sdk')
  })
})

describe('workerKey', () => {
  it('is the terminalId for a PTY worker — so the engine maps keep their contents', () => {
    expect(workerKey({ terminalId: 't1' })).toBe('t1')
    expect(workerKey({ runtime: 'pty', terminalId: 't1' })).toBe('t1')
  })

  it('is the sdkSessionId for an SDK worker', () => {
    expect(workerKey({ runtime: 'sdk', sdkSessionId: 's1' })).toBe('s1')
  })

  it('THROWS on a handle-less record rather than returning a shared/empty key', () => {
    // A record with no handle would key every engine map at the same slot and
    // silently share another worker's rate-limit / stall state.
    expect(() => workerKey({})).toThrow(WorkerHandleError)
    expect(() => workerKey({ runtime: 'sdk' })).toThrow(WorkerHandleError)
    expect(() => workerKey({ runtime: 'pty', sdkSessionId: 's1' })).toThrow(WorkerHandleError)
  })
})

describe('ptyWorkerRuntime — pure delegation (behaviour-neutral)', () => {
  it('isAlive asks the pool for the terminal id', () => {
    getTerminal.mockReturnValue({ id: 't1' })
    expect(ptyWorkerRuntime.isAlive({ terminalId: 't1' })).toBe(true)
    expect(getTerminal).toHaveBeenCalledWith('t1')

    getTerminal.mockReturnValue(null)
    expect(ptyWorkerRuntime.isAlive({ terminalId: 't1' })).toBe(false)
  })

  it('recentOutput returns the pool screen verbatim, including null', () => {
    getTerminalScreen.mockReturnValue('some screen')
    expect(ptyWorkerRuntime.recentOutput({ terminalId: 't1' })).toBe('some screen')
    expect(getTerminalScreen).toHaveBeenCalledWith('t1')

    // null must pass through unchanged — callers read it as "no evidence".
    getTerminalScreen.mockReturnValue(null)
    expect(ptyWorkerRuntime.recentOutput({ terminalId: 't1' })).toBeNull()
  })

  it('kill delegates and swallows the pool return value (idempotent by contract)', () => {
    killTerminal.mockReturnValue(false) // already dead
    expect(() => ptyWorkerRuntime.kill({ terminalId: 't1' })).not.toThrow()
    expect(killTerminal).toHaveBeenCalledWith('t1')
  })
})

describe('runtimeOf', () => {
  it('resolves an absent/pty runtime to the PTY implementation', () => {
    expect(runtimeOf({ terminalId: 't1' }).kind).toBe('pty')
    expect(runtimeOf({ runtime: 'pty', terminalId: 't1' }).kind).toBe('pty')
  })

  it('resolves sdk to the SDK runtime', () => {
    expect(runtimeOf({ runtime: 'sdk', sdkSessionId: 's1' }).kind).toBe('sdk')
  })

  it('NEVER touches the PTY pool for an sdk worker', () => {
    // The property that matters: an SDK worker must not be half-operated
    // through the terminal pool. A session that does not exist reads as dead
    // and produces no output — both honest answers, neither of them a PTY call.
    const w = { runtime: 'sdk' as const, sdkSessionId: 'no-such-session' }
    const rt = runtimeOf(w)
    expect(rt.isAlive(w)).toBe(false)
    expect(rt.recentOutput(w)).toBeNull()
    expect(rt.lastOutputAt(w)).toBeNull()
    expect(rt.nudge(w)).toBe(false)
    expect(() => rt.kill(w)).not.toThrow()

    expect(getTerminal).not.toHaveBeenCalled()
    expect(getTerminalScreen).not.toHaveBeenCalled()
    expect(killTerminal).not.toHaveBeenCalled()
  })

  it('still refuses a handle-less sdk worker rather than guessing a key', () => {
    const w = { runtime: 'sdk' as const }
    expect(() => runtimeOf(w).isAlive(w)).toThrow(WorkerHandleError)
  })
})

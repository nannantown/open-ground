// The two SANITIZERS' half of the runtime identity invariant
// (pty ⇔ terminalId, sdk ⇔ sdkSessionId — src/lib/server/workerRuntime.ts).
//
// Both of them asked a PTY-shaped question about records that may live in either
// pool, and both were the same silent-defect family docs/MAP.md §5 names:
//
//   · `sanitizeEngineState` filtered the engine's roster with
//     `typeof w.terminalId === 'string'`. It survives today only by luck — the
//     engine still writes terminalId:'' for an SDK worker, so the empty string
//     satisfies the typeof. The day that field stops being emitted (the record
//     documents it as EMPTY and it carries no information), EVERY SDK worker
//     disappears from the commander's monitor with no error and no warning.
//
//   · `sanitizeSwarmWorkers`'s coercer table is exhaustive by TYPE but blind
//     ACROSS fields, so a row claiming `runtime:'sdk'` with NO session handle
//     sailed through. That record is addressable by nobody: the SDK tile cannot
//     mount (SwarmModule requires both), and `stopWorkerDesk` takes the sdk arm,
//     finds no id, falls through, finds no terminalId either — so the "restart"
//     that follows spawns a second `claude` into a worktree the first may still
//     be writing in. The twin hazard, reached from a malformed payload.
//
// MUTATIONS that turn this red (each measured):
//   · restore `.filter((w) => typeof w.terminalId === 'string')`;
//   · drop the `row.runtime === 'sdk' && !sdkSessionId` fold.

import { describe, it, expect } from 'vitest'
import { engineWorkerKey, sanitizeEngineState, sanitizeSwarmWorkers } from './useSwarmEngine'

describe('sanitizeEngineState — an SDK worker is addressed by its SESSION', () => {
  /** The row an engine that has stopped emitting a meaningless terminalId
   *  sends: runtime + the handle, and nothing from the PTY pool. */
  const sdkRow = {
    runtime: 'sdk',
    sdkSessionId: 'sdk-1',
    branch: 'swarm/a',
    taskId: 't1',
    taskTitle: 'T1',
    startedAt: '2026-08-01T00:00:00.000Z',
    stage: 'running',
  }

  it('keeps a worker that carries NO terminalId at all', () => {
    const out = sanitizeEngineState({ workers: [sdkRow] }).workers
    expect(out).toHaveLength(1)
    expect(out[0].runtime).toBe('sdk')
    expect(out[0].sdkSessionId).toBe('sdk-1')
    // Addressable — which is the whole question the filter should be asking.
    expect(engineWorkerKey(out[0])).toBe('sdk-1')
    // The record's own contract: EMPTY for an SDK worker, never undefined.
    expect(out[0].terminalId).toBe('')
  })

  it('still keeps a PTY worker, and still drops a row with no identity at all', () => {
    const out = sanitizeEngineState({
      workers: [
        { terminalId: 'pty-1', branch: 'swarm/b', taskId: 't2', taskTitle: 'T2', startedAt: 'x' },
        { nope: true },
      ],
    }).workers
    expect(out.map((w) => w.terminalId)).toEqual(['pty-1'])
    expect(out[0].runtime).toBeUndefined()
  })

  it('DROPS a row that is addressable in NEITHER pool — `typeof \'\' === "string"` is not the question', () => {
    // The filter used to read `typeof w.terminalId === 'string' || typeof
    // w.sdkSessionId === 'string'`, and an SDK worker's terminalId is ALWAYS the
    // empty string by the identity invariant — so the test admitted every row,
    // including this one. `engineWorkerKey` throws on it: it is a worker nothing
    // can stop, nudge or answer, sitting in the commander's monitor looking
    // ordinary.
    const out = sanitizeEngineState({
      workers: [
        { terminalId: '', sdkSessionId: '', branch: 'swarm/x', taskId: 't', taskTitle: 'T', startedAt: 'x' },
      ],
    }).workers
    expect(out).toEqual([])
  })

  it('…and still keeps every row that IS addressable — over-tightening is its own failure', () => {
    // The opposite error is the one that started all this: a filter that drops
    // live workers empties the commander's monitor beside desks that are
    // visibly working, with no error and no warning.
    const out = sanitizeEngineState({
      workers: [
        { terminalId: 'pty-1', branch: 'swarm/a', taskId: 't1', taskTitle: 'A', startedAt: 'x' },
        { terminalId: '', runtime: 'sdk', sdkSessionId: 'sdk-1', branch: 'swarm/b', taskId: 't2', taskTitle: 'B', startedAt: 'x' },
      ],
    }).workers
    expect(out.map((w) => engineWorkerKey(w))).toEqual(['pty-1', 'sdk-1'])
  })

  it('never claims the SDK pool without a handle to address it by', () => {
    // A forged / truncated row. Claiming 'sdk' with no session id would make
    // engineWorkerKey return '' — every such worker collapsing to ONE identity,
    // which is exactly how a "stop" once dropped an entire roster.
    const out = sanitizeEngineState({
      workers: [{ terminalId: 'pty-9', runtime: 'sdk', branch: 'swarm/c', taskId: 't', taskTitle: 'T', startedAt: 'x' }],
    }).workers
    expect(out).toHaveLength(1)
    expect(out[0].runtime).toBeUndefined()
    expect(engineWorkerKey(out[0])).toBe('pty-9')
  })
})

describe('sanitizeSwarmWorkers — runtime and its handle are ONE fact', () => {
  it('folds a runtime claim that carries no session handle', () => {
    const [row] = sanitizeSwarmWorkers({
      workers: [{ worktree: '/wt/a', branch: 'swarm/a', runtime: 'sdk' }],
    })
    // The row survives — the worktree exists on disk and must stay visible,
    // terminable and restartable — but it no longer claims a pool it cannot be
    // reached in. Without the fold it renders as a worker whose "restart" runs a
    // stop that addresses nobody and then spawns a twin into that worktree.
    expect(row).toEqual({ worktree: '/wt/a', branch: 'swarm/a' })
    expect(row.runtime).toBeUndefined()
  })

  it('folds it for an empty-string handle too (an empty id is not a handle)', () => {
    const [row] = sanitizeSwarmWorkers({
      workers: [{ worktree: '/wt/b', branch: 'swarm/b', runtime: 'sdk', sdkSessionId: '' }],
    })
    expect(row.runtime).toBeUndefined()
    expect(row.sdkSessionId).toBeUndefined()
  })

  it('leaves a well-formed SDK worker exactly as the server sent it', () => {
    const [row] = sanitizeSwarmWorkers({
      workers: [{ worktree: '/wt/c', branch: 'swarm/c', runtime: 'sdk', sdkSessionId: 'sdk-c' }],
    })
    expect(row).toEqual({
      worktree: '/wt/c',
      branch: 'swarm/c',
      runtime: 'sdk',
      sdkSessionId: 'sdk-c',
    })
  })

  it('leaves the DEAD-worker shape alone — no runtime, no id, and that is legal', () => {
    // The mirror case, and the reason the fold is asymmetric: `runtime:'pty'`
    // (or absent) with no terminalId is a REAL state — a heartbeat-only worker
    // whose desk is gone. It is what the restart affordance exists for, so it
    // must never be dropped or "repaired".
    const [row] = sanitizeSwarmWorkers({
      workers: [{ worktree: '/wt/d', branch: 'swarm/d', heartbeatAt: '2026-08-01T00:00:00.000Z' }],
    })
    expect(row).toEqual({
      worktree: '/wt/d',
      branch: 'swarm/d',
      heartbeatAt: '2026-08-01T00:00:00.000Z',
    })
  })
})

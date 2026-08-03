import { describe, it, expect } from 'vitest'
import { listManagerDesks, type ManagerDeskHandle } from './swarmManagerRuntime'

// ─── occupancy vs adoption: the same desk, two different answers ─────────────
//
// THE DEAD END (overnight review 2026-08-03). `terminateSdkSession` flips a
// session's `status` to 'exited' SYNCHRONOUSLY — it means "we asked it to
// stop" — while the pump keeps unwinding, sometimes for a long time (a wedged
// desk may never finish). listManagerDesks selects on `reaped`, ON PURPOSE, so
// the singleton guard keeps seeing the dying desk and no twin spawns on top of
// it. But the UI's reconcile adopts ANY live desk the server publishes, so:
//   owner presses 停止 → the pane clears its record → the next poll publishes
//   the still-unwinding desk → the pane ADOPTS it again → 停止 never sticks.
// On the wedged desk — precisely the case where stopping matters — that loop
// is permanent.
//
// The `stopping` flag splits the two questions at the seam: the desk still
// EXISTS (occupancy) but is no longer ADOPTABLE. These pin both halves,
// because either direction alone is its own incident: drop it from the list
// entirely and a twin spawns onto a live worktree; publish it for adoption and
// stopping is impossible.

const sdkSession = (over: Partial<{ id: string; status: string; seq: number }> = {}) =>
  ({
    id: over.id ?? 'sdk-1',
    cwd: '/repo',
    role: 'manager',
    agentSessionId: 'agent-1',
    status: over.status ?? 'working',
    startedAt: 1_000,
    lastEventAt: 2_000,
    seq: over.seq ?? 3,
  }) as never

const desks = (status: string): ManagerDeskHandle[] =>
  listManagerDesks('/repo', {
    ptyDesks: () => [],
    ptyAlive: () => true,
    sdkDesks: () => [sdkSession({ status })],
  })

describe('listManagerDesks — stopping', () => {
  it('a WORKING sdk desk is listed and adoptable', () => {
    const [d] = desks('working')
    expect(d).toBeTruthy()
    expect(d.stopping).toBe(false)
  })

  it('a desk asked to stop (status exited, not yet reaped) is STILL LISTED — the twin guard needs it', () => {
    expect(desks('exited')).toHaveLength(1)
    expect(desks('failed')).toHaveLength(1)
  })

  it('…but it is marked stopping, so the adoption filter drops it', () => {
    expect(desks('exited')[0].stopping).toBe(true)
    expect(desks('failed')[0].stopping).toBe(true)
    // The exact expression getOrchestratorState publishes.
    expect(desks('exited').find((d) => !d.stopping) ?? null).toBeNull()
    expect(desks('working').find((d) => !d.stopping)).toBeTruthy()
  })

  it('a PTY desk that survived the process-table check is never "stopping"', () => {
    const out = listManagerDesks('/repo', {
      ptyDesks: () =>
        [
          {
            id: 'term-1',
            cwd: '/repo',
            agentSessionId: 'a',
            lastOutputAt: 5,
            startedAtMs: 1,
          },
        ] as never,
      ptyAlive: () => true,
      sdkDesks: () => [],
    })
    expect(out[0].stopping).toBe(false)
  })
})

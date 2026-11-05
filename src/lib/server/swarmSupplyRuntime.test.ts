import { describe, expect, it } from 'vitest'
import { listAllLiveSupplyDesks } from './swarmSupplyRuntime'
import type { SdkSessionInfo } from './sdkSession'
import type { OwnerDeskTerminal } from './terminal'

describe('president runtime occupancy', () => {
  it('orders both pools together, excludes dead PTYs/reaped SDKs, and keeps stopping SDK occupancy', () => {
    const pty = [
      { id: 'claude', cwd: '/project', deskLabel: '補給官', startedAtMs: 2 },
      { id: 'dead', cwd: '/project', deskLabel: '補給官', startedAtMs: 100 },
      { id: 'manager', cwd: '/project', deskLabel: '司令官', startedAtMs: 100 },
    ] as OwnerDeskTerminal[]
    const sdk = [
      { id: 'chatgpt', cwd: '/project', role: 'supply', startedAt: 4, status: 'waiting', seq: 3, inputs: 1, lastEventAt: 5 },
      { id: 'stopping', cwd: '/project', role: 'supply', startedAt: 3, status: 'exited', closed: true, seq: 0, lastEventAt: 3 },
      { id: 'finished', cwd: '/project', role: 'supply', startedAt: 6, reaped: true, seq: 0 },
      { id: 'worker', cwd: '/project', role: 'worker', startedAt: 7, seq: 0 },
    ] as SdkSessionInfo[]
    const desks = listAllLiveSupplyDesks({ pty: () => pty, alive: (id) => id !== 'dead', sdk: () => sdk })
    expect(desks.map((desk) => [desk.handleId, desk.runtime, desk.stopping])).toEqual([
      ['chatgpt', 'sdk', false], ['stopping', 'sdk', true], ['claude', 'pty', false],
    ])
    expect(desks[0].lastOutputAt).toBe(5)
    expect(desks[1].lastOutputAt).toBeNull()
  })

  it('retains unreaped failed/exited SDK pumps as occupied but refuses their adoption', () => {
    const sdk = [
      { id: 'failed-unwinding', cwd: '/project', role: 'supply', startedAt: 3, status: 'failed', closed: false, seq: 0 },
      { id: 'exited-unwinding', cwd: '/project', role: 'supply', startedAt: 2, status: 'exited', closed: false, seq: 0 },
      { id: 'waiting-reaped', cwd: '/project', role: 'supply', startedAt: 4, status: 'waiting', reaped: true, seq: 0 },
    ] as SdkSessionInfo[]
    const desks = listAllLiveSupplyDesks({ pty: () => [], sdk: () => sdk })
    expect(desks.map((desk) => [desk.handleId, desk.stopping])).toEqual([
      ['failed-unwinding', true], ['exited-unwinding', true],
    ])
  })
})

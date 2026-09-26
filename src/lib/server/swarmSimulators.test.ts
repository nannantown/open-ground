import { describe, expect, it } from 'vitest'
import { shutdownWorkerSimulators, type SimDevice, type SimulatorDeps } from './swarmSimulators'

const A = '4484441C-B3BC-4C54-84A2-45C6ADA5E2F4'
const B = 'BA971BE0-6539-4ED2-92D2-27DA00119455'

/** One Bash call in claude's JSONL shape: tool_use at `start`, tool_result at `end`. */
const bash = (id: string, command: string, start: string, end: string) =>
  [
    { type: 'assistant', timestamp: start, message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } },
    { type: 'user', timestamp: end, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } },
  ]
    .map((r) => JSON.stringify(r))
    .join('\n')

/** `booted` are up now; `installed` are the Mac's other (shut down) devices. */
const run = async (worker: string[], booted: SimDevice[], others: string[] = [], installed: SimDevice[] = []) => {
  const shut: string[] = []
  const deps: SimulatorDeps = {
    readWorkerTranscripts: async () => worker,
    readOtherLiveTranscripts: async () => others,
    listDevices: async () => [
      ...booted.map((d) => ({ state: 'Booted', ...d })),
      ...installed.map((d) => ({ state: 'Shutdown', ...d })),
    ],
    shutdown: async (u) => {
      shut.push(u)
    },
  }
  const closed = await shutdownWorkerSimulators('/wt', 'dir', deps)
  expect(closed).toEqual(shut)
  return shut
}

const worker = [bash('t1', `xcrun simctl boot ${A} && xcrun simctl install ${A} app`, '2026-09-26T06:51:40.000Z', '2026-09-26T06:52:10.000Z')]

describe('shutdownWorkerSimulators', () => {
  it('closes a simulator the worker booted', async () => {
    expect(await run(worker, [{ udid: A, lastBootedAt: '2026-09-26T06:51:51Z' }])).toEqual([A])
  })

  it('never closes one the owner booted before the worker named it', async () => {
    // Worker ran `simctl boot A` while A was already up (the command fails); lastBootedAt predates it.
    expect(await run(worker, [{ udid: A, lastBootedAt: '2026-09-26T05:00:00Z' }])).toEqual([])
  })

  it('never closes one booted again after the worker was done with it', async () => {
    expect(await run(worker, [{ udid: A, lastBootedAt: '2026-09-26T08:00:00Z' }])).toEqual([])
  })

  it('never closes a device the worker never named', async () => {
    expect(await run(worker, [{ udid: B, lastBootedAt: '2026-09-26T06:51:51Z' }])).toEqual([])
  })

  it('leaves it running while another live worker uses it', async () => {
    const other = [bash('o1', `xcrun simctl install ${A} other.app`, '2026-09-26T07:00:00Z', '2026-09-26T07:00:05Z')]
    expect(await run(worker, [{ udid: A, lastBootedAt: '2026-09-26T06:51:51Z' }], other)).toEqual([])
  })

  it('does nothing without transcripts (no simctl call at all)', async () => {
    const deps: SimulatorDeps = {
      readWorkerTranscripts: async () => [],
      readOtherLiveTranscripts: async () => [],
      listDevices: async () => {
        throw new Error('must not list')
      },
      shutdown: async () => {
        throw new Error('must not shut down')
      },
    }
    expect(await shutdownWorkerSimulators('/wt', 'dir', deps)).toEqual([])
  })
})

describe('shutdownWorkerSimulators — devices named by name, not UDID', () => {
  const byName = [bash('n1', 'xcrun simctl boot "iPhone 17 Pro" && open -a Simulator', '2026-09-26T06:51:40.000Z', '2026-09-26T06:52:10.000Z')]
  const pro = (lastBootedAt: string): SimDevice => ({ udid: A, name: 'iPhone 17 Pro', lastBootedAt })

  it('closes a device the worker booted by name', async () => {
    expect(await run(byName, [pro('2026-09-26T06:51:51Z')])).toEqual([A])
  })

  it('never closes a same-named device the owner had booted before the command', async () => {
    expect(await run(byName, [pro('2026-09-26T06:40:00Z')])).toEqual([])
  })

  it('matches the whole name only ("iPhone 17" is not "iPhone 17 Pro")', async () => {
    expect(await run(byName, [{ udid: B, name: 'iPhone 17', lastBootedAt: '2026-09-26T06:51:51Z' }])).toEqual([])
  })

  it('xcodebuild -destination name=… counts as naming it', async () => {
    const xb = [bash('x1', "xcodebuild test -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.0'", '2026-09-26T06:51:40.000Z', '2026-09-26T06:55:00.000Z')]
    expect(await run(xb, [pro('2026-09-26T06:52:30Z')])).toEqual([A])
  })

  it('leaves it running while another live worker names it', async () => {
    const other = [bash('o2', 'xcodebuild -destination "name=iPhone 17 Pro" build', '2026-09-26T07:00:00Z', '2026-09-26T07:01:00Z')]
    expect(await run(byName, [pro('2026-09-26T06:51:51Z')], other)).toEqual([])
  })
})

describe('boot-time slack is one second (lastBootedAt is whole seconds)', () => {
  it('a boot 2 s before the command started is not the command\'s', async () => {
    expect(await run(worker, [{ udid: A, lastBootedAt: '2026-09-26T06:51:38Z' }])).toEqual([])
  })
})


// Review repros (2026-09-26): a NAME must never let the owner's own device be closed.
describe('name attribution never closes the owner\'s device', () => {
  const C = '11111111-2222-3333-4444-555555555555'
  const pro = (udid: string, lastBootedAt?: string): SimDevice => ({ udid, name: 'iPhone 17 Pro', lastBootedAt })
  /** A Bash call that never got a result (killed mid-run). */
  const killed = (id: string, command: string, start: string) =>
    JSON.stringify({ type: 'assistant', timestamp: start, message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } })

  it('several devices share the name: neither the worker\'s nor the owner\'s is closed by name', async () => {
    const xb = [bash('x', "xcodebuild test -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.0'", '2026-09-26T06:50:00.000Z', '2026-09-26T07:00:00.000Z')]
    // Worker's 26.0 device and the owner's 26.2 device both booted inside the 10-min window.
    const booted = [pro(A, '2026-09-26T06:50:30Z'), pro(B, '2026-09-26T06:55:00Z')]
    expect(await run(xb, booted, [], [pro(C)])).toEqual([])
  })

  it('a build that names the device does not boot it: the owner\'s (only) device stays up', async () => {
    const build = [bash('b', "xcodebuild build -destination 'name=iPhone 17 Pro'", '2026-09-26T06:50:00.000Z', '2026-09-26T06:58:00.000Z')]
    expect(await run(build, [pro(A, '2026-09-26T06:54:00Z')])).toEqual([])
  })

  it('a killed command gets no name match in its open window', async () => {
    const k = [killed('k', 'xcrun simctl boot "iPhone 17 Pro"', '2026-09-26T06:50:00.000Z')]
    expect(await run(k, [pro(A, '2026-09-26T07:10:00Z')])).toEqual([])
  })

  it('a killed command that named the UDID still closes it (UDID rule unchanged)', async () => {
    const k = [killed('k', `xcrun simctl boot ${A}`, '2026-09-26T06:50:00.000Z')]
    expect(await run(k, [pro(A, '2026-09-26T06:50:03Z')])).toEqual([A])
  })
})

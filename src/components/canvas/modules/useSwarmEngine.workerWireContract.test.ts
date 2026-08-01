// The WIRE CONTRACT of GET /api/swarm/workers, tested end to end through BOTH
// real implementations: the server's own record builder
// (src/lib/server/swarmWorkerRegistry.ts `listSwarmWorkers`) on one side, the
// client's sanitizer (`sanitizeSwarmWorkers`) on the other, with a real JSON
// round-trip in between — which is exactly what the route does.
//
// WHY IT EXISTS: until 2026-08-01 the sanitizer copied fields one at a time and
// simply did not copy `runtime` / `sdkSessionId`. The server carries those two
// deliberately (the registry has a paragraph about it), so this was a pure
// client-side loss with no error, no warning, and no failing test: every SDK
// worker arrived at the render as a runtime-less record, fell through to the PTY
// renderer with no terminalId, and was drawn as an ENDED session — over a
// `claude` that was alive and working. The SDK tile and its stop button were
// dead code in production while 76 tests stayed green.
//
// Neither side alone can catch that: a server test asserts the server sends it,
// a client test asserts the client parses what the test author remembered to put
// in the fixture. Only running the two halves against each other does, so that
// is what this file does — and `SWARM_WORKER_KEYS` keeps the fixture honest as
// the record type grows.

import { describe, it, expect } from 'vitest'
import { listSwarmWorkers, type SwarmWorkerRegistryDeps } from '@/lib/server/swarmWorkerRegistry'
import { sanitizeSwarmWorkers, SWARM_WORKER_KEYS } from './useSwarmEngine'
import type {
  ActiveTerminalsResponse,
  OrchestratorWorker,
  SwarmOrchestratorState,
  SwarmWorkerRecord,
} from '@/lib/types'

const emptyEngineState: SwarmOrchestratorState = {
  running: true,
  manualStop: false,
  manualStopPersisted: false,
  selfSupply: false,
  overseer: false,
  workers: [],
  reviews: [],
  log: [],
  anomalies: [],
  maxWorkers: 3,
  kpis: {
    leadTime: { medianMs: null, count: 0 },
    conflictRate: null,
    reworkRate: null,
    workerSuccessRate: null,
    counts: { dispatched: 0, integrated: 0, conflicted: 0, reworked: 0, crashed: 0, stalled: 0 },
  },
  consumption: { activeWorkers: 0, activeRunMs: 0, dispatched: 0, limit: 0, overLimit: false },
  autonomyRemembered: false,
  autonomyResumed: false,
  overseerRemembered: false,
}

// An SDK worker as the ENGINE actually records one: terminalId is the EMPTY
// STRING and the handle is sdkSessionId (the identity invariant — pty ⇔
// terminalId, sdk ⇔ sdkSessionId, workerRuntime.ts).
const sdkEngineWorker: OrchestratorWorker = {
  terminalId: '',
  runtime: 'sdk',
  sdkSessionId: 'sdk-sess-1',
  branch: 'swarm/sdk-a',
  worktree: '/wt/sdk-a',
  taskId: 'task-sdk',
  taskTitle: 'SDK task',
  startedAt: '2026-08-01T00:00:00.000Z',
  stage: 'running',
  // phase/note on an ENGINE record come from the engine's own folded heartbeat
  // read, not from the registry's fresh disk read (only `heartbeatAt` prefers
  // the fresh one) — so they belong here, on the roster entry.
  phase: 'verify',
  note: 'running the suite',
}

const ptyEngineWorker: OrchestratorWorker = {
  terminalId: 'pty-1',
  branch: 'swarm/pty-b',
  worktree: '/wt/pty-b',
  taskId: 'task-pty',
  taskTitle: 'PTY task',
  startedAt: '2026-08-01T00:05:00.000Z',
  stage: 'starting',
  phase: 'blocked',
  note: 'stuck',
}

const activeTerminals = (claude: ActiveTerminalsResponse['claude']): ActiveTerminalsResponse => ({
  cwds: claude.map((c) => c.cwd),
  claude,
})

const makeDeps = (over: Partial<SwarmWorkerRegistryDeps> = {}): SwarmWorkerRegistryDeps => ({
  listActiveTerminals: () => activeTerminals([]),
  listActiveSdkWorkers: () => [],
  getOrchestratorState: async () => emptyEngineState,
  readHeartbeats: async () => new Map(),
  branchOfWorktree: async () => null,
  resolveCentralWorktreesDir: async () => '/wt',
  ...over,
})

/** What the route hands the browser: the builder's records, through JSON.
 *  Serialising for real matters — it is the step that would quietly turn an
 *  exotic value into something the sanitizer sees differently. */
const overTheWire = (workers: SwarmWorkerRecord[]): unknown =>
  JSON.parse(JSON.stringify({ workers }))

describe('GET /api/swarm/workers — the client must not lose what the server sends', () => {
  it('carries an SDK worker through with its runtime AND its session handle', async () => {
    const built = await listSwarmWorkers('/proj', makeDeps({
      getOrchestratorState: async () => ({ ...emptyEngineState, workers: [sdkEngineWorker] }),
    }))
    // The server's half of the contract, stated outright so a regression THERE
    // is not silently absorbed by this test's own fixture.
    expect(built).toHaveLength(1)
    expect(built[0].runtime).toBe('sdk')
    expect(built[0].sdkSessionId).toBe('sdk-sess-1')

    // …and the client's half: nothing lost, nothing invented.
    expect(sanitizeSwarmWorkers(overTheWire(built))).toEqual(built)
  })

  it('carries a mixed fleet through field for field, covering EVERY record field', async () => {
    // Two workers because one record cannot hold every field: `ready` and
    // `blocked` are mutually exclusive by construction in the registry
    // (blocked is only set when readyToMerge is false).
    const built = await listSwarmWorkers('/proj', makeDeps({
      getOrchestratorState: async () => ({
        ...emptyEngineState,
        workers: [sdkEngineWorker, ptyEngineWorker],
      }),
      listActiveTerminals: () => activeTerminals([{ id: 'pty-1', cwd: '/wt/pty-b', status: 'working' }]),
      readHeartbeats: async () =>
        new Map([
          [
            '/wt/sdk-a',
            { branch: 'swarm/sdk-a', phase: 'verify', task: 'running the suite', readyToMerge: true, updatedAt: '2026-08-01T00:10:00.000Z' },
          ],
          [
            '/wt/pty-b',
            { branch: 'swarm/pty-b', phase: 'blocked', task: 'stuck', readyToMerge: false, blockers: 'needs a decision', updatedAt: '2026-08-01T00:11:00.000Z' },
          ],
        ]),
    }))
    expect(built).toHaveLength(2)

    // FIXTURE COMPLETENESS. If a field is added to SwarmWorkerRecord (and thus,
    // via the exhaustive coercer table, to SWARM_WORKER_KEYS) this fails until
    // the fixture above actually makes the server emit it — otherwise the
    // equality assertion below would keep passing while covering less and less.
    const covered = new Set(built.flatMap((w) => Object.keys(w)))
    expect([...SWARM_WORKER_KEYS].sort().filter((k) => !covered.has(k))).toEqual([])

    expect(sanitizeSwarmWorkers(overTheWire(built))).toEqual(built)
  })

  it('a dead SDK worker (heartbeat only) still round-trips — no runtime invented', async () => {
    // Source 3 of the registry: the session is gone, only the heartbeat file is
    // left. It carries NO runtime and NO id, and the sanitizer must not make one
    // up — this record is exactly the "restart me" case.
    const built = await listSwarmWorkers('/proj', makeDeps({
      readHeartbeats: async () =>
        new Map([['/wt/dead', { branch: 'swarm/dead', phase: 'implement', updatedAt: '2026-08-01T00:01:00.000Z' }]]),
    }))
    expect(built).toEqual([
      { worktree: '/wt/dead', branch: 'swarm/dead', phase: 'implement', heartbeatAt: '2026-08-01T00:01:00.000Z' },
    ])
    const out = sanitizeSwarmWorkers(overTheWire(built))
    expect(out).toEqual(built)
    expect(out[0].runtime).toBeUndefined()
    expect(out[0].sdkSessionId).toBeUndefined()
  })
})

describe('sanitizeSwarmWorkers — forged runtime fields', () => {
  it('keeps only the two runtimes this build can render', () => {
    const rows = sanitizeSwarmWorkers({
      workers: [
        { worktree: '/a', branch: 'swarm/a', runtime: 'sdk', sdkSessionId: 's1' },
        { worktree: '/b', branch: 'swarm/b', runtime: 'pty', terminalId: 't1' },
        // A runtime a NEWER server knows and this client does not: folding it to
        // absent (⇒ pty) is the only renderer this build is sure it has.
        { worktree: '/c', branch: 'swarm/c', runtime: 'wasm', sdkSessionId: 's3' },
        { worktree: '/d', branch: 'swarm/d', runtime: 42 },
      ],
    })
    expect(rows.map((r) => r.runtime)).toEqual(['sdk', 'pty', undefined, undefined])
    // An empty session id is NOT a handle — it must never be carried, or the SDK
    // tile renders pointed at nothing (and an addressed-by-'' stop hits whoever
    // answers first).
    expect(sanitizeSwarmWorkers({
      workers: [{ worktree: '/e', branch: 'swarm/e', runtime: 'sdk', sdkSessionId: '' }],
    })[0].sdkSessionId).toBeUndefined()
  })
})

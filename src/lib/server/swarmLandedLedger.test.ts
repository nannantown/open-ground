import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, readFile, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import {
  readLandedLedger,
  recordPromoted,
  sweepLanded,
  utcWeekStart,
  weeklyLandedSeries,
  isSelfProject,
  type LandedLedgerEntry,
} from './swarmLandedLedger'
import {
  runDispatchPass,
  __resetOrchestratorForTests,
  defaultDeps,
  emptyMetricsCounters,
  type ProjectEngine,
  type OrchestratorDeps,
  type IntegrationDeps,
  type AnomalyDeps,
} from './swarmOrchestrator'
import { initSelfSupplyRuntime } from './swarmSelfSupply'
import { initOverseerRuntime } from './swarmOverseer'
import { settingsFile, projectCentralDir } from './paths'
import type { ProjectTask, OrchestratorWorker } from '../types'

// Real fs + registry I/O — same margin as the sibling real-fs suites
// (reference_vitest_5s_default_is_the_flake_root).
vi.setConfig({ testTimeout: 60_000 })

// This suite runs against the whole-file OPENGROUND_HOME tmpdir pinned by
// src/test/setup-home.ts. The ledger lives under the project's CENTRAL data dir
// (~/.openground/projects/<uuid>/swarm-landed.json), which resolves through the
// registry — so each test registers its project in settings.json and cleans it
// back up (the swarmEnginePersistence.test.ts pattern).

let projDir = ''
let uuid = ''

beforeEach(async () => {
  projDir = await realpath(await mkdtemp(join(tmpdir(), 'og-landed-proj-')))
  uuid = randomUUID()
  await writeFile(
    settingsFile(),
    JSON.stringify({ projects: [{ id: uuid, path: projDir, addedAt: '2026-01-01T00:00:00.000Z' }] }),
  )
})

afterEach(async () => {
  __resetOrchestratorForTests()
  await rm(projDir, { recursive: true, force: true })
  await rm(projectCentralDir(uuid), { recursive: true, force: true }).catch(() => {})
  await writeFile(settingsFile(), JSON.stringify({ projects: [] }))
})

const card = (id: string, column: string, title = id): ProjectTask =>
  ({ id, title, boardColumn: column, done: column === 'done' }) as unknown as ProjectTask

// ─── read: fail-quiet-to-empty ───────────────────────────────────────────────

describe('readLandedLedger — fail-quiet-to-empty', () => {
  it('returns [] when the file was never written', async () => {
    expect(await readLandedLedger(projDir)).toEqual([])
  })

  it('returns [] on corrupt JSON, never throws', async () => {
    const dir = projectCentralDir(uuid)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'swarm-landed.json'), '{nope')
    expect(await readLandedLedger(projDir)).toEqual([])
  })

  it('returns [] for an UNREGISTERED project path (resolver throws → quiet)', async () => {
    const stranger = await mkdtemp(join(tmpdir(), 'og-landed-stranger-'))
    try {
      expect(await readLandedLedger(stranger)).toEqual([])
    } finally {
      await rm(stranger, { recursive: true, force: true })
    }
  })

  it('filters malformed entries instead of dropping the whole file', async () => {
    const dir = projectCentralDir(uuid)
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'swarm-landed.json'),
      JSON.stringify({
        version: 1,
        entries: [
          { taskId: 'ok', title: 't', promotedAt: '2026-08-01T00:00:00.000Z' },
          { taskId: '', title: 'empty id', promotedAt: '2026-08-01T00:00:00.000Z' },
          { title: 'no id at all' },
          42,
        ],
      }),
    )
    const entries = await readLandedLedger(projDir)
    expect(entries).toHaveLength(1)
    expect(entries[0].taskId).toBe('ok')
  })
})

// ─── recordPromoted / sweepLanded — write with the production writer, read
//     back with the production reader ─────────────────────────────────────────

describe('recordPromoted → sweepLanded round-trip', () => {
  it('records a promote and stamps landedAt only once the Board shows done', async () => {
    await recordPromoted(projDir, { taskId: 'c1', title: 'fix A', branch: 'swarm/a' }, '2026-08-03T00:00:00.000Z')

    let entries = await readLandedLedger(projDir)
    expect(entries).toEqual([
      { taskId: 'c1', title: 'fix A', branch: 'swarm/a', promotedAt: '2026-08-03T00:00:00.000Z' },
    ])

    // Still in review → no land.
    expect(await sweepLanded(projDir, [card('c1', 'review')], '2026-08-04T00:00:00.000Z')).toBe(0)
    entries = await readLandedLedger(projDir)
    expect(entries[0].landedAt).toBeUndefined()

    // Done → landed, stamped with the sweep's clock.
    expect(await sweepLanded(projDir, [card('c1', 'done')], '2026-08-05T00:00:00.000Z')).toBe(1)
    entries = await readLandedLedger(projDir)
    expect(entries[0].landedAt).toBe('2026-08-05T00:00:00.000Z')
  })

  it('a done card the engine never promoted is NOT counted (hand-made work is not the swarm\'s)', async () => {
    await recordPromoted(projDir, { taskId: 'c1', title: 'fix A' }, '2026-08-03T00:00:00.000Z')
    expect(await sweepLanded(projDir, [card('hand', 'done'), card('c1', 'doing')], '2026-08-05T00:00:00.000Z')).toBe(0)
    const entries = await readLandedLedger(projDir)
    expect(entries).toHaveLength(1)
    expect(entries.find((e) => e.taskId === 'hand')).toBeUndefined()
  })

  it('re-promote after 差し戻し keeps the FIRST promotedAt (refreshes title/branch only)', async () => {
    await recordPromoted(projDir, { taskId: 'c1', title: 'v1', branch: 'swarm/a' }, '2026-08-01T00:00:00.000Z')
    await recordPromoted(projDir, { taskId: 'c1', title: 'v2', branch: 'swarm/a2' }, '2026-08-09T00:00:00.000Z')
    const entries = await readLandedLedger(projDir)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ title: 'v2', branch: 'swarm/a2', promotedAt: '2026-08-01T00:00:00.000Z' })
  })

  it('a second sweep is idempotent — landedAt is set once and keeps its first stamp', async () => {
    await recordPromoted(projDir, { taskId: 'c1', title: 'fix A' }, '2026-08-03T00:00:00.000Z')
    await sweepLanded(projDir, [card('c1', 'done')], '2026-08-05T00:00:00.000Z')
    expect(await sweepLanded(projDir, [card('c1', 'done')], '2026-08-06T00:00:00.000Z')).toBe(0)
    const entries = await readLandedLedger(projDir)
    expect(entries[0].landedAt).toBe('2026-08-05T00:00:00.000Z')
  })

  it('recordPromoted on an unregistered path is a silent no-op (fail-open), never a throw', async () => {
    const stranger = await mkdtemp(join(tmpdir(), 'og-landed-stranger2-'))
    try {
      await expect(
        recordPromoted(stranger, { taskId: 'x', title: 'y' }),
      ).resolves.toBeUndefined()
    } finally {
      await rm(stranger, { recursive: true, force: true })
    }
  })
})

// ─── pure helpers ─────────────────────────────────────────────────────────────

describe('utcWeekStart — Monday-start UTC weeks', () => {
  it.each([
    ['2026-08-12T16:00:00Z', '2026-08-10'], // Wednesday → its Monday
    ['2026-08-10T00:00:00Z', '2026-08-10'], // Monday → itself
    ['2026-08-16T23:59:59Z', '2026-08-10'], // Sunday → the PREVIOUS Monday
    ['2026-08-17T00:00:00Z', '2026-08-17'], // next Monday boundary
    ['2026-01-01T00:00:00Z', '2025-12-29'], // year boundary
  ])('%s → week of %s', (iso, want) => {
    expect(utcWeekStart(Date.parse(iso))).toBe(want)
  })
})

describe('weeklyLandedSeries', () => {
  const now = Date.parse('2026-08-12T16:00:00Z') // week of 2026-08-10
  const landedOn = (iso: string, i: number): LandedLedgerEntry => ({
    taskId: `t${i}`,
    title: 't',
    promotedAt: iso,
    landedAt: iso,
  })

  it('returns a FIXED-length oldest→newest series with empty weeks at zero', () => {
    const series = weeklyLandedSeries(
      [landedOn('2026-08-11T00:00:00Z', 1), landedOn('2026-07-29T00:00:00Z', 2)],
      { weeks: 4, now },
    )
    expect(series).toEqual([
      { weekStart: '2026-07-20', landed: 0 },
      { weekStart: '2026-07-27', landed: 1 },
      { weekStart: '2026-08-03', landed: 0 },
      { weekStart: '2026-08-10', landed: 1 },
    ])
  })

  it('ignores un-landed, unparseable, and out-of-window entries', () => {
    const series = weeklyLandedSeries(
      [
        { taskId: 'a', title: 't', promotedAt: '2026-08-11T00:00:00Z' }, // promoted, not landed
        { taskId: 'b', title: 't', promotedAt: 'x', landedAt: 'not-a-date' },
        landedOn('2020-01-01T00:00:00Z', 3), // far outside the window
        landedOn('2026-08-12T00:00:00Z', 4),
      ],
      { weeks: 2, now },
    )
    expect(series).toEqual([
      { weekStart: '2026-08-03', landed: 0 },
      { weekStart: '2026-08-10', landed: 1 },
    ])
  })
})

describe('isSelfProject — package.json name equality against the built-from name', () => {
  it('true for a checkout whose package.json name matches this repo\'s', async () => {
    const pkg = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
      name: string
    }
    await writeFile(join(projDir, 'package.json'), JSON.stringify({ name: pkg.name }))
    expect(await isSelfProject(projDir)).toBe(true)
  })

  it('false for another package name, a missing package.json, and corrupt JSON', async () => {
    await writeFile(join(projDir, 'package.json'), JSON.stringify({ name: 'someapp' }))
    expect(await isSelfProject(projDir)).toBe(false)
    await writeFile(join(projDir, 'package.json'), '{nope')
    expect(await isSelfProject(projDir)).toBe(false)
    await rm(join(projDir, 'package.json'))
    expect(await isSelfProject(projDir)).toBe(false)
  })
})

// ─── WIRING — the call sites in runDispatchPass actually feed the ledger ─────
// (The unit tests above prove the primitives; these prove the engine writes
// them at the promote site and sweeps them at the board read — the roster
// wiring test's shape.)

const newEngine = (over: Partial<ProjectEngine> = {}): ProjectEngine =>
  ({
    path: projDir,
    running: true,
    passInFlight: false,
    generation: 0,
    timer: null,
    workers: [],
    reviews: [],
    conflictedBranches: new Set(),
    verifyFailed: new Map(),
    reviewFailed: new Map(),
    reviewDeferred: new Map(),
    highRiskHolds: new Map(),
    lastIntegrateAt: 0,
    recoveries: new Map(),
    reworks: new Map(),
    reworkReasons: new Map(),
    conflictReworks: new Map(),
    stuckMoves: new Map(),
    nudges: new Map(),
    rateLimited: new Map(),
    permissionWaits: new Map(),
    log: [],
    anomalies: [],
    selfSupply: initSelfSupplyRuntime(),
    overseer: initOverseerRuntime(),
    notified: new Set(),
    pendingFatal: [],
    metrics: emptyMetricsCounters(),
    ...over,
  }) as ProjectEngine

const stubDeps = (
  over: Partial<OrchestratorDeps>,
): OrchestratorDeps & IntegrationDeps & AnomalyDeps => ({
  ...defaultDeps(),
  fetchTasks: async () => [],
  spawnWorker: async () => {
    throw new Error('spawnWorker not stubbed for this test')
  },
  moveToDoing: async () => true,
  moveToReview: async () => true,
  recoverCard: async () => true,
  recoverWorker: async () => ({ removed: true }),
  isAlive: () => true,
  ...over,
})

const readyWorker = (over: Partial<OrchestratorWorker> = {}): OrchestratorWorker => ({
  terminalId: 'pty-1',
  branch: 'swarm/c1',
  worktree: join(projDir, 'wt', 'c1'),
  taskId: 'c1',
  taskTitle: 'wire me',
  startedAt: new Date(Date.now() - 60_000).toISOString(),
  stage: 'running',
  model: 'fable',
  sessionId: 'sess-1',
  reworkCount: 0,
  ...over,
})

describe('wiring — runDispatchPass writes the landed ledger', () => {
  it('the promote site records the card, and the sweep stamps it when done', async () => {
    // Pass 1: a ready worker (fresh heartbeat + commits ahead) → promote fires.
    const engine = newEngine({ workers: [readyWorker()] })
    const doing = card('c1', 'doing', 'wire me')
    await runDispatchPass(
      engine,
      stubDeps({
        fetchTasks: async () => [doing],
        countCommitsAhead: async () => 1,
        readHeartbeat: async () => ({ ready: true, blocked: false, at: new Date().toISOString() }),
      }),
      Date.now(),
    )
    let entries = await readLandedLedger(projDir)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ taskId: 'c1', title: 'wire me', branch: 'swarm/c1' })
    expect(entries[0].landedAt).toBeUndefined()

    // Pass 2 (fresh engine, as after a restart — the ledger must not depend on
    // the in-memory journal): the Board now shows the card done → landedAt.
    const engine2 = newEngine({ workers: [] })
    const now2 = Date.now()
    await runDispatchPass(
      engine2,
      stubDeps({ fetchTasks: async () => [card('c1', 'done', 'wire me')] }),
      now2,
    )
    entries = await readLandedLedger(projDir)
    expect(entries).toHaveLength(1)
    expect(entries[0].landedAt).toBe(new Date(now2).toISOString())
  })
})

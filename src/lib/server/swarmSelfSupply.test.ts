// @vitest-environment node
//
// Self-supply (card b3fbbfba) — the commander engine proposing its OWN improvement
// cards. Proves the observable conditions WITHOUT spawning real tsc/lint/vitest:
//   (1) findings from every source (anomaly/tsc/lint/test/todo) become observable,
//       completion-conditioned todo cards.
//   (2) per-pass AND per-day caps stop the flood (runaway defense).
//   (3) a proposed card is owner-approval-gated — selectDispatch refuses it until
//       approveSelfSupplyCard runs.
//   (4) a finding already represented by an OPEN card is deduped (never re-carded).
//   (5) every fire + suppression lands in the engine journal (the log sink).
//   (6) the real readProjectData/writeProjectData round-trip persists the gate
//       fields (isolated HOME) — if the schema dropped them the gate would fail open.
//   (7) a scanner subprocess that FORKS leaves no orphan when its run is reaped, and
//       a scan never blocks the engine tick (audit 856daefb).
//
// The pure parsers are unit-tested with sample tool output; the carding pipeline is
// driven with synthetic findings + an in-memory board. The only subprocesses are the
// two cheap `sh` stand-ins in the runCapture suite — the real tsc/lint/vitest scanners
// are never spawned (self-supply is OFF everywhere in the test suite).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, realpath } from 'fs/promises'
import { existsSync, mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { addProjectEntry, __resetMigrationCacheForTests } from './registry'
import { readProjectData } from './projectData'
import { selectDispatch } from './swarmOrchestrator'
import {
  runSelfSupplyPass,
  kickSelfSupplyPass,
  runCapture,
  approveSelfSupplyCard,
  anomalyFindings,
  parseTscFindings,
  parseEslintFindings,
  parseVitestFindings,
  parseTodoFindings,
  openSelfSupplyKeys,
  initSelfSupplyRuntime,
  defaultBoard,
  type SelfSupplyEngine,
  type SelfSupplyDeps,
  type SelfSupplyBoard,
  type SelfSupplyFinding,
  type SelfSupplyConfig,
  type SelfSupplyLog,
} from './swarmSelfSupply'
import type { OrchestratorAnomaly, ProjectData, ProjectTask } from '../types'

// A fixed clock (2023-11-14), well within one UTC day for the two-pass cap test.
const T0 = 1_700_000_000_000

const mk = (over: Partial<ProjectTask>): ProjectTask => ({
  id: 'x',
  title: 't',
  done: false,
  createdAt: '2026-01-01T00:00:00Z',
  boardColumn: 'todo',
  ...over,
})

const finding = (n: number): SelfSupplyFinding => ({
  source: 'todo',
  key: `k${n}`,
  title: `自動提案: fix ${n}`,
  body: `do ${n}. 完了条件: テスト緑`,
})

/** An in-memory CAS board — the unit-test stand-in for readProjectData/write. */
const memBoard = (initial: ProjectTask[] = []) => {
  const state = {
    data: { description: '', tasks: initial.map((t) => ({ ...t })), notes: '', updatedAt: 't0' } as ProjectData,
    writes: 0,
  }
  const board: SelfSupplyBoard = {
    read: async () => ({ ...state.data, tasks: state.data.tasks.map((t) => ({ ...t })) }),
    write: async (_p, next, opts) => {
      if (opts?.expectUpdatedAt !== undefined && opts.expectUpdatedAt !== state.data.updatedAt) {
        throw new Error('conflict')
      }
      state.writes++
      state.data = { ...next, tasks: next.tasks.map((t) => ({ ...t })), updatedAt: `t${state.writes}` }
      return state.data
    },
  }
  return { board, state }
}

const mkDeps = (board: SelfSupplyBoard, todoFindings: SelfSupplyFinding[] = [], nowMs = T0): SelfSupplyDeps => ({
  now: () => nowMs,
  board,
  scanTypeErrors: async () => [],
  scanLintErrors: async () => [],
  scanTestFailures: async () => [],
  scanTodoComments: async () => todoFindings,
})

const engine = (over: Partial<SelfSupplyEngine> = {}): SelfSupplyEngine => ({
  path: '/proj',
  anomalies: [],
  selfSupply: { ...initSelfSupplyRuntime(), enabled: true },
  ...over,
})

const collectLog = () => {
  const lines: { level: 'info' | 'warn'; message: string }[] = []
  const log: SelfSupplyLog = (level, message) => lines.push({ level, message })
  return { lines, log }
}

const NOOP: SelfSupplyLog = () => {}
const CFG: SelfSupplyConfig = { maxPerPass: 5, maxPerDay: 10, intervalMs: 0 }

/** Poll `pred` until true (or the cap elapses) — a condition wait, so it returns the
 *  instant the state lands and only the slow-under-load ceiling is generous. */
const waitUntil = async (pred: () => boolean, ms = 5000): Promise<boolean> => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return true
    await new Promise((r) => setTimeout(r, 5))
  }
  return pred()
}

// ── Guards: disarmed + throttled are no-ops ───────────────────────────────────

describe('self-supply gating (disarmed / throttled)', () => {
  it('does NOTHING when disarmed (default OFF — the ignition guard)', async () => {
    const { board, state } = memBoard()
    const e = engine({ selfSupply: { ...initSelfSupplyRuntime(), enabled: false } })
    const out = await runSelfSupplyPass(e, NOOP, mkDeps(board, [finding(1)]), CFG)
    expect(out.scanned).toBe(false)
    expect(out.proposed).toHaveLength(0)
    expect(state.data.tasks).toHaveLength(0)
  })

  it('does NOTHING inside the throttle window (no re-scan every tick)', async () => {
    const { board, state } = memBoard()
    const e = engine({
      selfSupply: { enabled: true, lastScanAt: T0, dayKey: '', dayCount: 0, scanInFlight: false },
    })
    const out = await runSelfSupplyPass(e, NOOP, mkDeps(board, [finding(1)], T0 + 500), {
      maxPerPass: 5,
      maxPerDay: 5,
      intervalMs: 60_000,
    })
    expect(out.scanned).toBe(false)
    expect(state.data.tasks).toHaveLength(0)
  })
})

// ── Detection → carding ───────────────────────────────────────────────────────

describe('self-supply carding', () => {
  it('cards a discovered finding into todo as an approval-gated card + logs the fire', async () => {
    const { board, state } = memBoard()
    const { lines, log } = collectLog()
    const out = await runSelfSupplyPass(engine(), log, mkDeps(board, [finding(1)]), CFG)
    expect(out.scanned).toBe(true)
    expect(out.proposed.map((f) => f.key)).toEqual(['k1'])
    expect(state.data.tasks).toHaveLength(1)
    const card = state.data.tasks[0]
    expect(card.boardColumn).toBe('todo')
    expect(card.selfSupplyKey).toBe('k1')
    expect(card.selfSupplyApproved).toBe(false)
    expect(card.done).toBe(false)
    expect(card.notes).toContain('完了条件')
    expect(lines.some((l) => l.level === 'info' && l.message.includes('self-supply: 提案'))).toBe(true)
  })

  it('turns engine anomalies into cards with observable completion conditions', async () => {
    const { board, state } = memBoard()
    const e = engine({
      anomalies: [{ kind: 'orphan-doing', ref: 'task-x', branch: 'swarm/x', taskTitle: 'Orphan' }],
    })
    const out = await runSelfSupplyPass(e, NOOP, mkDeps(board, []), CFG)
    expect(out.proposed.map((f) => f.key)).toEqual(['anomaly:orphan-doing:task-x'])
    expect(state.data.tasks[0].selfSupplyKey).toBe('anomaly:orphan-doing:task-x')
    expect(state.data.tasks[0].notes).toContain('完了条件')
  })
})

// ── Caps (runaway defense) ────────────────────────────────────────────────────

describe('self-supply caps', () => {
  it('per-pass cap: only maxPerPass land, the rest are held + logged', async () => {
    const { board, state } = memBoard()
    const { lines, log } = collectLog()
    const out = await runSelfSupplyPass(engine(), log, mkDeps(board, [1, 2, 3, 4, 5].map(finding)), {
      maxPerPass: 2,
      maxPerDay: 10,
      intervalMs: 0,
    })
    expect(out.proposed).toHaveLength(2)
    expect(out.suppressed.filter((s) => s.reason === 'per-pass-cap')).toHaveLength(3)
    expect(state.data.tasks).toHaveLength(2)
    expect(lines.some((l) => l.level === 'warn' && l.message.includes('上限到達'))).toBe(true)
  })

  it('per-day cap: holds across passes once the daily budget is spent', async () => {
    const { board, state } = memBoard()
    const e = engine()
    const cfg: SelfSupplyConfig = { maxPerPass: 2, maxPerDay: 3, intervalMs: 0 }
    // pass 1 (k1..k5): per-pass cap → 2 land (k1,k2), dayCount → 2.
    const o1 = await runSelfSupplyPass(e, NOOP, mkDeps(board, [1, 2, 3, 4, 5].map(finding), T0), cfg)
    expect(o1.proposed.map((f) => f.key)).toEqual(['k1', 'k2'])
    expect(e.selfSupply.dayCount).toBe(2)
    // pass 2 (same day): k1,k2 dedup; daily budget leaves room for ONE more (k3);
    // k4,k5 hit the daily cap.
    const o2 = await runSelfSupplyPass(e, NOOP, mkDeps(board, [1, 2, 3, 4, 5].map(finding), T0 + 1), cfg)
    expect(o2.proposed.map((f) => f.key)).toEqual(['k3'])
    expect(o2.suppressed.some((s) => s.reason === 'daily-cap')).toBe(true)
    expect(o2.suppressed.some((s) => s.reason === 'duplicate')).toBe(true)
    expect(state.data.tasks).toHaveLength(3)
    expect(e.selfSupply.dayCount).toBe(3)
  })
})

// ── Dedup ─────────────────────────────────────────────────────────────────────

describe('self-supply dedup', () => {
  it('skips a finding already represented by an OPEN card (todo/doing/review)', async () => {
    const { board } = memBoard([mk({ id: 'e1', boardColumn: 'doing', selfSupplyKey: 'k1' })])
    const { lines, log } = collectLog()
    const out = await runSelfSupplyPass(engine(), log, mkDeps(board, [finding(1), finding(2)]), CFG)
    expect(out.proposed.map((f) => f.key)).toEqual(['k2'])
    expect(out.suppressed.some((s) => s.reason === 'duplicate' && s.finding.key === 'k1')).toBe(true)
    expect(lines.some((l) => l.message.includes('既出') && l.message.includes('重複検出'))).toBe(true)
  })

  it('RE-proposes a finding whose only matching card already landed (a regression)', async () => {
    const { board } = memBoard([mk({ id: 'd1', done: true, boardColumn: 'done', selfSupplyKey: 'k1' })])
    const out = await runSelfSupplyPass(engine(), NOOP, mkDeps(board, [finding(1)]), CFG)
    expect(out.proposed.map((f) => f.key)).toEqual(['k1'])
  })
})

// ── Write-failure safety (CAS conflict holds everything) ──────────────────────

describe('self-supply write safety', () => {
  it('a board write failure cards nothing + holds the day budget, logs the hold', async () => {
    const board: SelfSupplyBoard = {
      read: async () => ({ description: '', tasks: [], notes: '', updatedAt: 't0' }),
      write: async () => {
        throw new Error('conflict')
      },
    }
    const e = engine()
    const { lines, log } = collectLog()
    const out = await runSelfSupplyPass(e, log, mkDeps(board, [finding(1)]), CFG)
    expect(out.scanned).toBe(true)
    expect(out.proposed).toHaveLength(0)
    expect(e.selfSupply.dayCount).toBe(0)
    expect(lines.some((l) => l.level === 'warn' && l.message.includes('保留'))).toBe(true)
  })
})

// ── Dispatch gate (owner approval) ────────────────────────────────────────────

describe('selectDispatch self-supply approval gate (⑥)', () => {
  it('holds an unapproved self-supplied card; dispatches once approved', () => {
    const gated = mk({ id: 'g', selfSupplyKey: 'k1' })
    expect(selectDispatch([gated], new Set(), 5)).toHaveLength(0)
    const approved = mk({ id: 'a', selfSupplyKey: 'k1', selfSupplyApproved: true })
    expect(selectDispatch([approved], new Set(), 5).map((c) => c.id)).toEqual(['a'])
  })

  it('never gates a human-authored card (no selfSupplyKey)', () => {
    const normal = mk({ id: 'n' })
    expect(selectDispatch([normal], new Set(), 5).map((c) => c.id)).toEqual(['n'])
  })

  it('a held proposal does not block a sibling todo behind it', () => {
    const gated = mk({ id: 'g', selfSupplyKey: 'k1', createdAt: '2026-01-01T00:00:00Z' })
    const normal = mk({ id: 'n', createdAt: '2026-01-02T00:00:00Z' })
    expect(selectDispatch([gated, normal], new Set(), 5).map((c) => c.id)).toEqual(['n'])
  })
})

describe('approveSelfSupplyCard', () => {
  it('approves a self-supplied card (idempotent), no-op for normal/absent cards', async () => {
    const { board, state } = memBoard([mk({ id: 'c1', selfSupplyKey: 'k1' }), mk({ id: 'c2' })])
    expect((await approveSelfSupplyCard('/proj', 'c1', board)).approved).toBe(true)
    expect(state.data.tasks.find((t) => t.id === 'c1')?.selfSupplyApproved).toBe(true)
    // idempotent — already approved
    expect((await approveSelfSupplyCard('/proj', 'c1', board)).approved).toBe(false)
    // a human card carries no selfSupplyKey — nothing to approve
    expect((await approveSelfSupplyCard('/proj', 'c2', board)).approved).toBe(false)
    // absent card
    expect((await approveSelfSupplyCard('/proj', 'nope', board)).approved).toBe(false)
  })
})

// ── Pure parsers (sample tool output → findings, no subprocess) ────────────────

describe('finding parsers', () => {
  it('anomalyFindings: stable keys + observable completion bodies per kind', () => {
    const anoms: OrchestratorAnomaly[] = [
      { kind: 'orphan-doing', ref: 't1', branch: 'swarm/a', taskTitle: 'Card A' },
      { kind: 'worker-stale', ref: 'swarm/b', branch: 'swarm/b', staleMinutes: 42 },
      { kind: 'rework-exhausted', ref: 't3', taskTitle: 'Card C', attempts: 3 },
    ]
    const fs = anomalyFindings(anoms)
    expect(fs.map((f) => f.key)).toEqual([
      'anomaly:orphan-doing:t1',
      'anomaly:worker-stale:swarm/b',
      'anomaly:rework-exhausted:t3',
    ])
    expect(fs.every((f) => f.source === 'anomaly')).toBe(true)
    expect(fs.every((f) => f.body.includes('完了条件'))).toBe(true)
    expect(fs[1].body).toContain('42')
  })

  it('parseTscFindings: one finding per (file, code), line drift collapsed', () => {
    const out = parseTscFindings(
      [
        "src/foo.ts(12,5): error TS2322: Type 'X' is not assignable to 'Y'.",
        'src/foo.ts(20,1): error TS2322: another instance',
        "src/bar.ts(3,3): error TS1005: ';' expected.",
        'not an error line',
      ].join('\n'),
    )
    expect(out.map((f) => f.key).sort()).toEqual(['tsc:src/bar.ts:TS1005', 'tsc:src/foo.ts:TS2322'])
    expect(out.every((f) => f.source === 'tsc')).toBe(true)
    expect(out.find((f) => f.key.includes('foo'))?.body).toContain('npx tsc --noEmit')
  })

  it('parseEslintFindings: errors only (severity 2), relativized, keyed by file+rule', () => {
    const json = JSON.stringify([
      {
        filePath: '/root/src/a.ts',
        messages: [
          { ruleId: 'no-unused-vars', severity: 2, message: 'x is unused' },
          { ruleId: 'prefer-const', severity: 1, message: 'warn only' },
        ],
      },
      { filePath: '/root/src/b.ts', messages: [] },
    ])
    const out = parseEslintFindings(json, '/root')
    expect(out).toHaveLength(1)
    expect(out[0].key).toBe('lint:src/a.ts:no-unused-vars')
    expect(out[0].body).toContain('npm run lint')
  })

  it('parseEslintFindings: malformed JSON → no findings (never throws)', () => {
    expect(parseEslintFindings('{ not json')).toEqual([])
  })

  it('parseVitestFindings: failed assertions only, keyed by full name', () => {
    const json = JSON.stringify({
      testResults: [
        {
          name: '/root/x.test.ts',
          assertionResults: [
            { fullName: 'suite > passes', status: 'passed' },
            { fullName: 'suite > fails', status: 'failed' },
          ],
        },
      ],
    })
    const out = parseVitestFindings(json)
    expect(out.map((f) => f.key)).toEqual(['test:suite > fails'])
    expect(out[0].body).toContain('npm test')
  })

  it('parseTodoFindings: one per (file, comment), whitespace-folded dedup', () => {
    const out = parseTodoFindings(
      [
        'src/x.ts:10:  // TODO: handle null',
        'src/x.ts:99:  // TODO:  handle null ', // moved + double-spaced → same key
        'src/y.ts:1:// FIXME: broken',
      ].join('\n'),
    )
    expect(out.map((f) => f.key).sort()).toEqual([
      'todo:src/x.ts:// todo: handle null',
      'todo:src/y.ts:// fixme: broken',
    ])
  })
})

describe('openSelfSupplyKeys', () => {
  it('collects self-supply keys of OPEN cards only (done excluded, keyless ignored)', () => {
    const tasks: ProjectTask[] = [
      mk({ id: '1', boardColumn: 'todo', selfSupplyKey: 'a' }),
      mk({ id: '2', boardColumn: 'doing', selfSupplyKey: 'b' }),
      mk({ id: '3', boardColumn: 'review', selfSupplyKey: 'c' }),
      mk({ id: '4', boardColumn: 'done', done: true, selfSupplyKey: 'd' }),
      mk({ id: '5', boardColumn: 'todo' }),
    ]
    expect(Array.from(openSelfSupplyKeys(tasks)).sort()).toEqual(['a', 'b', 'c'])
  })
})

// ── Real board, isolated HOME (the schema round-trip + dispatch end to end) ────

describe('self-supply — real board (isolated HOME)', () => {
  let home: string
  let scratch: string
  let savedHome: string | undefined

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'og-ss-home-')))
    scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-ss-scratch-')))
    savedHome = process.env.OPENGROUND_HOME
    process.env.OPENGROUND_HOME = home
    __resetMigrationCacheForTests()
  })
  afterEach(async () => {
    // Restore, never delete: an unset OPENGROUND_HOME sends later resolution at the
    // REAL home dir (the 2026-07-18 data loss). See src/lib/server/testHomeGuard.ts.
    if (savedHome !== undefined) process.env.OPENGROUND_HOME = savedHome
    __resetMigrationCacheForTests()
    await rm(home, { recursive: true, force: true })
    await rm(scratch, { recursive: true, force: true })
  })

  it('a finding persists as an approval-gated todo card; a 2nd scan dedups; approval makes it dispatchable', async () => {
    const proj = join(scratch, 'proj')
    await mkdir(proj, { recursive: true })
    await addProjectEntry(proj) // register so readProjectData/writeProjectData resolve

    const e: SelfSupplyEngine = {
      path: proj,
      anomalies: [{ kind: 'orphan-doing', ref: 'tX', branch: 'swarm/x', taskTitle: 'Orphan' }],
      selfSupply: { ...initSelfSupplyRuntime(), enabled: true },
    }
    const deps: SelfSupplyDeps = {
      now: () => T0,
      board: defaultBoard(), // the REAL readProjectData/writeProjectData
      scanTypeErrors: async () => [],
      scanLintErrors: async () => [],
      scanTestFailures: async () => [],
      scanTodoComments: async () => [],
    }
    const cfg: SelfSupplyConfig = { maxPerPass: 3, maxPerDay: 5, intervalMs: 0 }

    const o1 = await runSelfSupplyPass(e, NOOP, deps, cfg)
    expect(o1.proposed).toHaveLength(1)

    const data1 = await readProjectData(proj)
    expect(data1.tasks).toHaveLength(1)
    const card = data1.tasks[0]
    // The schema round-trip kept the gate fields (if schemas.ts dropped them this fails).
    expect(card.selfSupplyKey).toBe('anomaly:orphan-doing:tX')
    expect(card.selfSupplyApproved).toBe(false)
    expect(card.boardColumn).toBe('todo')
    // Gated: not dispatchable yet.
    expect(selectDispatch(data1.tasks, new Set(), 5)).toHaveLength(0)

    // Second scan: same anomaly → deduped, nothing added.
    const o2 = await runSelfSupplyPass(e, NOOP, deps, cfg)
    expect(o2.proposed).toHaveLength(0)
    expect(o2.suppressed.some((s) => s.reason === 'duplicate')).toBe(true)
    expect((await readProjectData(proj)).tasks).toHaveLength(1)

    // Owner approval via the real board → now dispatchable.
    expect((await approveSelfSupplyCard(proj, card.id)).approved).toBe(true)
    const data3 = await readProjectData(proj)
    expect(data3.tasks[0].selfSupplyApproved).toBe(true)
    expect(selectDispatch(data3.tasks, new Set(), 5).map((c) => c.id)).toEqual([card.id])
  })
})

// ── runCapture — the scanner subprocess runner (audit 856daefb) ────────────────
// The scanners spawn the project's OWN tsc / eslint / vitest. `vitest run` uses the
// default FORK pool, and execFile's `timeout` SIGTERMs only the direct pid — so a
// wedged suite hitting the 240s cap used to leave its fork workers ORPHANED, each
// spinning a core to machine saturation (feedback_vitest_no_midrun_kill; the hazard
// the merge gate's runGateProcess already documents). runCapture now goes through
// runGateProcess: detached child (its own process group) + a negative-pid SIGKILL of
// the WHOLE group on every exit path.
//
// The stand-in tool is `sh -c 'sleep & …'`: a non-interactive shell has no job
// control, so the backgrounded `sleep` stays in the shell's process group — exactly
// the shape of a vitest fork worker. Its survival after the run settles is the whole
// assertion: with the old plain execFile it lives on (orphan), with the group reaper
// it dies. `sh` + `sleep` start in milliseconds, so the short timeouts below have
// ~100× headroom even on a saturated machine (no cold-start race, unlike `node -e`).

describe('runCapture — reaps the scanner tool AND its forked workers (no orphans)', () => {
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0) // signal 0 = existence probe, kills nothing
      return true
    } catch {
      return false
    }
  }
  const waitFor = async (pred: () => boolean, ms: number): Promise<boolean> => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (pred()) return true
      await new Promise((r) => setTimeout(r, 10))
    }
    return pred()
  }
  /** Fork a worker into our own group, publish its pid, then wedge forever. */
  const WEDGE_AND_FORK = 'sleep 1000 & echo $! > "$WORKER_PIDFILE"; sleep 1000'
  /** Fork a worker, then exit non-zero WITH a payload on stdout (the tsc/eslint shape). */
  const FORK_THEN_FAIL = 'sleep 1000 & echo $! > "$WORKER_PIDFILE"; echo "the payload"; exit 1'

  const readPid = (pidFile: string): number => Number(readFileSync(pidFile, 'utf8').trim())
  const pidLanded = (pidFile: string): boolean =>
    existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== ''

  // POSIX-only: the negative-pid group signal (and `sh`/`sleep`) are POSIX.
  it.skipIf(process.platform === 'win32')(
    'a wedged tool times out: the run yields "" (never throws) and its forked worker is DEAD',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'og-ss-reap-'))
      const pidFile = join(dir, 'worker.pid')
      process.env.WORKER_PIDFILE = pidFile
      let workerPid = -1
      try {
        // 3000ms: the wedge NEVER exits, so the timeout path is the only way out. The
        // fork registers within milliseconds, far inside the window.
        const run = runCapture(dir, 'sh', ['-c', WEDGE_AND_FORK], 3000)
        expect(await waitFor(() => pidLanded(pidFile), 8000)).toBe(true)
        workerPid = readPid(pidFile)
        expect(workerPid).toBeGreaterThan(0)
        expect(alive(workerPid)).toBe(true) // the fork is live while the tool wedges

        // A killed scan yields no findings — runCapture swallows the timeout, it never
        // throws into the pass.
        await expect(run).resolves.toBe('')

        // The proof: the FORKED worker died with the tool. A parent-only SIGTERM (what
        // plain execFile's timeout does) would leave it spinning here.
        expect(await waitFor(() => !alive(workerPid), 8000)).toBe(true)
      } finally {
        delete process.env.WORKER_PIDFILE
        if (workerPid > 0 && alive(workerPid)) {
          try {
            process.kill(workerPid, 'SIGKILL') // never leak a spinner out of the suite
          } catch {
            /* already gone */
          }
        }
      }
    },
    20_000,
  )

  it.skipIf(process.platform === 'win32')(
    'a NON-ZERO exit still yields stdout (the tsc/eslint/vitest payload) and reaps the fork',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'og-ss-payload-'))
      const pidFile = join(dir, 'worker.pid')
      process.env.WORKER_PIDFILE = pidFile
      let workerPid = -1
      try {
        // The tools exit non-zero PRECISELY when they find problems — runGateProcess
        // rejects there, so runCapture must read the payload back off the rejection.
        // Losing this would silently zero out every finding.
        const out = await runCapture(dir, 'sh', ['-c', FORK_THEN_FAIL], 8000)
        expect(out).toContain('the payload')

        expect(await waitFor(() => pidLanded(pidFile), 8000)).toBe(true)
        workerPid = readPid(pidFile)
        // Clean exit reaps the group too: a straggler fork never outlives its scan.
        expect(await waitFor(() => !alive(workerPid), 8000)).toBe(true)
      } finally {
        delete process.env.WORKER_PIDFILE
        if (workerPid > 0 && alive(workerPid)) {
          try {
            process.kill(workerPid, 'SIGKILL')
          } catch {
            /* already gone */
          }
        }
      }
    },
    20_000,
  )

  it('a missing binary yields "" — a broken scanner is no findings, never a throw', async () => {
    await expect(runCapture(tmpdir(), 'og-no-such-binary-xyz', ['--version'], 5000)).resolves.toBe('')
  })
})

// ── Off-tick: the scan runs BESIDE the engine tick, one at a time ──────────────
// Audit 856daefb: the scan (tsc 120s + eslint 120s + vitest 240s, sequential) was
// awaited inside runEnginePass, which holds passInFlight — so dispatch, the monitor
// (stall / runaway / crash detection) and integrate froze for minutes. It is now
// fire-and-forget, which makes overlap possible: a later tick can arrive mid-scan.
// scanInFlight is the check-and-set guard that keeps exactly one scan alive.

describe('self-supply off-tick execution (kickSelfSupplyPass + scanInFlight)', () => {
  /** Deps whose todo scanner blocks until the test releases it. */
  const gatedDeps = (board: SelfSupplyBoard) => {
    let release: () => void = () => {}
    let entered = 0
    const gate = new Promise<void>((r) => (release = r))
    const deps: SelfSupplyDeps = {
      ...mkDeps(board),
      scanTodoComments: async () => {
        entered++
        await gate
        return [finding(1)]
      },
    }
    return { deps, release: () => release(), entries: () => entered }
  }

  it('kickSelfSupplyPass returns IMMEDIATELY — the tick never waits for the scanners', async () => {
    const { board, state } = memBoard()
    const e = engine()
    const { deps, release } = gatedDeps(board)

    // If the kick awaited the scan this line would hang on the gated scanner.
    kickSelfSupplyPass(e, NOOP, deps, CFG)
    expect(e.selfSupply.scanInFlight).toBe(true) // scan is live, beside us
    expect(state.data.tasks).toHaveLength(0) // …and has not carded yet

    release()
    expect(await waitUntil(() => !e.selfSupply.scanInFlight)).toBe(true)
    expect(state.data.tasks).toHaveLength(1) // the off-tick scan still lands its card
  })

  it('a tick arriving mid-scan does NOT start a second scan (scanInFlight re-entrancy)', async () => {
    const { board, state } = memBoard()
    const e = engine()
    const { deps, release, entries } = gatedDeps(board)

    const first = runSelfSupplyPass(e, NOOP, deps, CFG)
    expect(await waitUntil(() => entries() === 1)).toBe(true) // scan 1 is parked in the scanner

    // Scan 2 fires from the next tick, 3s later. intervalMs is 0 here, so ONLY
    // scanInFlight can stop it — the throttle cannot (lastScanAt is stamped after the
    // board read, i.e. inside scan 1's await window).
    const second = await runSelfSupplyPass(e, NOOP, deps, CFG)
    expect(second.scanned).toBe(false)
    expect(entries()).toBe(1) // the scanner ran once, not twice

    release()
    expect((await first).proposed).toHaveLength(1)
    expect(state.data.tasks).toHaveLength(1) // one card, not a double-carded duplicate
    expect(e.selfSupply.scanInFlight).toBe(false) // released in `finally`
  })

  it('a failing scan releases scanInFlight — a fault never wedges self-supply shut', async () => {
    const { board, state } = memBoard()
    const e = engine()
    const { lines, log } = collectLog()
    const failing: SelfSupplyBoard = {
      read: async () => {
        throw new Error('boom')
      },
      write: board.write,
    }
    kickSelfSupplyPass(e, log, { ...mkDeps(board), board: failing }, CFG)
    expect(await waitUntil(() => !e.selfSupply.scanInFlight)).toBe(true)
    expect(lines.some((l) => l.level === 'warn' && /board read failed/.test(l.message))).toBe(true)

    // Not wedged: the NEXT kick scans and cards normally (the fault was transient).
    kickSelfSupplyPass(e, log, mkDeps(board, [finding(1)]), CFG)
    expect(await waitUntil(() => state.data.tasks.length === 1)).toBe(true)
  })

  it('a throwing dep is caught by the kick — a fault is journaled, not an unhandled rejection', async () => {
    const { board } = memBoard()
    const e = engine()
    const { lines, log } = collectLog()
    // `now()` runs OUTSIDE the pass's try/finally (it precedes the scanInFlight set), so a
    // throw there escapes runSelfSupplyPass — exactly the class of fault the kick's
    // `.catch` exists for. Fire-and-forget without it would surface as an unhandled
    // rejection and, in Electron, could take the server process down.
    const hostile: SelfSupplyDeps = {
      ...mkDeps(board),
      now: () => {
        throw new Error('broken clock')
      },
    }
    kickSelfSupplyPass(e, log, hostile, CFG)
    expect(await waitUntil(() => lines.some((l) => /pass errored/.test(l.message)))).toBe(true)
    expect(e.selfSupply.scanInFlight).toBe(false)
  })
})

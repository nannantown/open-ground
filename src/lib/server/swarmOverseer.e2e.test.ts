// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { escalationsFile } from './paths'
import {
  runOverseerPass,
  initOverseerRuntime,
  defaultOverseerDeps,
  OVERSEER_THRESHOLDS,
  type OverseerEngine,
  type OverseerDeps,
} from './swarmOverseer'
import {
  listEscalations,
  listEscalationReceiptKeys,
  openEscalation,
  dismissEscalation,
  answerEscalation,
} from './swarmEscalations'
import { createSwarmFatalNotification } from './swarmNotifications'
import { canonicalize } from './canonicalize'

// ── S3 re-post E2E (the 2026-07-09 field bug) — REAL stores end to end ─────────
//
// swarm-notifications.json (real append) → recentFatals (the REAL windowed seam
// from defaultOverseerDeps) → S3 raises into the REAL escalations.json → the owner
// dismisses (real dismissEscalation) → the app "restarts" (a brand-new
// OverseerRuntime: ov.seen gone, exactly what a relaunch/re-arm does) → the same
// stored fatal must NOT reopen. And a fatal older than the window must never raise
// at all, however often the overseer is re-armed.

describe('S3 e2e — a dismissed exec-timeout stays dismissed across a restart (real stores)', () => {
  let projectPath: string

  beforeEach(async () => {
    projectPath = await canonicalize(await mkdtemp(join(tmpdir(), 'ogc-s3-')))
  })

  /** Real-seam deps: fatal store + escalation ledger + raise are the shipped code;
   *  PTY/usage/janitor are inert fakes (none fire in this scenario).
   *  `raises` (optional) counts every raise attempt reaching the REAL openEscalation
   *  — the observable for "nothing was re-posted" when the ledger itself is the
   *  thing under attack (corrupt file ⇒ listEscalations can't verify). */
  const realishDeps = (raises?: { count: number }): OverseerDeps => {
    const real = defaultOverseerDeps({ isAlive: () => false, readHeartbeat: async () => null })
    return {
      now: () => Date.now(),
      isAlive: () => false,
      readHeartbeat: async () => null,
      openEscalation: async (input) => {
        if (raises) raises.count += 1
        return openEscalation(input) // REAL persist into escalations.json
      },
      notifyInfo: async () => ({}), // keep the bell quiet; delivery is not under test
      peekUsagePct: () => null,
      refreshUsage: () => {},
      listEscalations, // REAL tolerant inbox read (S11 lane)
      listReceiptKeys: listEscalationReceiptKeys, // REAL STRICT receipt read (S3/S10 lane)
      recentFatals: real.recentFatals, // REAL windowed store read
      runJanitor: async () => ({}),
    }
  }

  const freshEngine = (): OverseerEngine => ({
    path: projectPath,
    running: true,
    anomalies: [],
    notified: new Set(),
    workers: [],
    reviews: [],
    overseer: { ...initOverseerRuntime(), enabled: true, lastJanitorAt: Number.MAX_SAFE_INTEGER },
  })

  it.each([20, 100])('persists S4 at usage %s, then delivers only the human answer', async (usage) => {
    const question = 'May I publish this release?'
    const engine = freshEngine()
    engine.workers = [{ runtime: 'sdk', sdkSessionId: 'human-target', branch: 'swarm/question', taskId: 'question-card', taskTitle: 'Release' }]
    const deps: OverseerDeps = {
      ...realishDeps(),
      isAlive: () => true,
      peekUsagePct: () => usage,
      readHeartbeat: async () => ({ ready: false, blocked: true, blockers: question }),
    }
    await runOverseerPass(engine, [], () => {}, deps)
    await runOverseerPass({ ...engine, overseer: freshEngine().overseer }, [], () => {}, deps)
    const inbox = await listEscalations({ projectPath, status: 'open' })
    expect(inbox).toHaveLength(1)
    expect(inbox[0]).toMatchObject({ question, runtime: 'sdk', sdkSessionId: 'human-target' })
    expect(inbox[0]).not.toHaveProperty('proxyDraft')
    const delivered: string[] = []
    const answer = await answerEscalation(inbox[0].id, 'Do not publish.', {
      isPathAllowed: async () => true,
      canPushInto: async (id) => id === 'human-target',
      push: (_id, text) => { delivered.push(text); return true },
    })
    expect(answer.delivery).toBe('injected')
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toContain('Do not publish.')
    expect((await listEscalations({ projectPath }))[0]).toMatchObject({ status: 'injected', answer: 'Do not publish.' })
  })

  it('raise once → dismiss → restart → NO re-post; the ledger does not grow', async () => {
    // A real fatal lands in the real notification store (in-window: 1min ago).
    await createSwarmFatalNotification(
      {
        event: 'exec-timeout',
        detail: 'ワーカーが実行時間上限 30分 を超過（45分稼働）→ 強制回収。',
        projectPath,
        taskId: 'card-e2e',
        branch: 'swarm/e2e',
        taskTitle: 'E2Eカード',
      },
      { os: false, now: Date.now() - 60_000 },
    )

    // Session 1: the overseer raises it into the REAL inbox exactly once.
    const out1 = await runOverseerPass(freshEngine(), [], () => {}, realishDeps())
    expect(out1.fired).toContain('S3')
    const open1 = await listEscalations({ projectPath, status: 'open' })
    expect(open1).toHaveLength(1)

    // …and a SECOND fresh session before any dismiss stays deduped too (the raise
    // is receipted on disk the moment it lands — not only in ov.seen).
    const outBis = await runOverseerPass(freshEngine(), [], () => {}, realishDeps())
    expect(outBis.fired).not.toContain('S3')
    expect(await listEscalations({ projectPath })).toHaveLength(1)

    // The owner dismisses it (REAL status flip in escalations.json).
    await dismissEscalation(open1[0].id)

    // "Restart": a brand-new runtime (in-memory seen is GONE) + the same stores.
    const out2 = await runOverseerPass(freshEngine(), [], () => {}, realishDeps())
    expect(out2.fired).not.toContain('S3')

    // Observable truth: nothing reopened AND the ledger did not grow a 2nd row.
    expect(await listEscalations({ projectPath, status: 'open' })).toHaveLength(0)
    const all = await listEscalations({ projectPath })
    expect(all).toHaveLength(1)
    expect(all[0].status).toBe('dismissed')
  })

  it('a fatal older than the window never raises, no matter how often the overseer re-arms', async () => {
    await createSwarmFatalNotification(
      {
        event: 'exec-timeout',
        detail: '一週間前のfatal（消滅済みworker）',
        projectPath,
        taskId: 'card-old',
        branch: 'swarm/old',
        taskTitle: '古いカード',
      },
      { os: false, now: Date.now() - OVERSEER_THRESHOLDS.fatalWindowMs - 60_000 },
    )

    // Two consecutive fresh sessions (OFF→ON, OFF→ON) — the field repro shape.
    for (let i = 0; i < 2; i++) {
      const out = await runOverseerPass(freshEngine(), [], () => {}, realishDeps())
      expect(out.fired).not.toContain('S3')
    }
    expect(await listEscalations({ projectPath })).toHaveLength(0)
  })

  it('a CORRUPT receipt ledger on disk defers the raise through the REAL wiring — no blind re-post', async () => {
    // The adversarial-review finding this pins: the receipt check's catch is only
    // fail-closed if the reader THROWS on a bad ledger. A tolerant reader
    // (readTolerant / listEscalations) folds corruption into [] — the catch never
    // fires, receipted reads as empty, and a dismissed fatal re-posts. So this test
    // runs the REAL reader against a REAL corrupt escalations.json and asserts the
    // pass raises NOTHING while the ledger is bad — and stays receipted after it heals.
    await createSwarmFatalNotification(
      {
        event: 'exec-timeout',
        detail: '受領台帳破損シナリオのfatal',
        projectPath,
        taskId: 'card-corrupt',
        branch: 'swarm/corrupt',
        taskTitle: '破損カード',
      },
      { os: false, now: Date.now() - 60_000 },
    )

    // Session 1 (healthy ledger): raise once, owner dismisses — receipt persisted.
    const raises1 = { count: 0 }
    await runOverseerPass(freshEngine(), [], () => {}, realishDeps(raises1))
    expect(raises1.count).toBe(1)
    const open = await listEscalations({ projectPath, status: 'open' })
    expect(open).toHaveLength(1)
    await dismissEscalation(open[0].id)
    const healthy = await readFile(escalationsFile(), 'utf8') // snapshot to heal with

    // The ledger goes BAD on disk (what a partial write / hand edit leaves behind).
    await writeFile(escalationsFile(), '{corrupted', 'utf8')

    // Session 2 (fresh runtime = restart): the REAL strict reader throws, the pass
    // must DEFER — zero raise attempts, and the corrupt file is left untouched
    // (a raise would readForWrite → quarantine + rewrite it).
    const raises2 = { count: 0 }
    const out = await runOverseerPass(freshEngine(), [], () => {}, realishDeps(raises2))
    expect(out.ran).toBe(true)
    expect(out.fired).not.toContain('S3')
    expect(raises2.count).toBe(0) // ← fail-open wiring (tolerant read) would raise here
    expect(await readFile(escalationsFile(), 'utf8')).toBe('{corrupted')

    // The ledger HEALS (restored verbatim): the dismissed receipt applies again —
    // still no re-post, on this session or another fresh one.
    await writeFile(escalationsFile(), healthy, 'utf8')
    const raises3 = { count: 0 }
    await runOverseerPass(freshEngine(), [], () => {}, realishDeps(raises3))
    expect(raises3.count).toBe(0)
    expect(await listEscalations({ projectPath, status: 'open' })).toHaveLength(0)
  })
})

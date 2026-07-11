// @vitest-environment node
//
// C-core E2E (OVERSEER_DESIGN §10 Done ⑥) — the WHOLE proxy-you loop end to end,
// through the REAL shipped seams, with only the brain's `claude` PTY stubbed (an
// ABSTAIN verdict — no subscription burn, deterministic):
//
//   overseer S4 detects a blocked worker's free-text question
//     → C2 answerAsOwner runs (real orchestration + real C4 gate) and ABSTAINS
//     → C1 openEscalation persists it to the REAL escalations.json (proxy draft attached)
//     → the owner reads the inbox (real listEscalations) and answers it
//     → the worker is RESUMED via the real W16 injection path (delivery: 'injected')
//     → the Q→A is written back to the REAL you-corpus (appendJudgment)
//
// Everything runs against the isolated tmp HOME (setup-home.ts), so it never touches
// the real ~/.openground and never spawns `claude`. This is the hermetic counterpart
// of the live test-project smoke; it is what GUARANTEES the integration stays wired.

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
  answerAsOwner,
  OVERSEER_MARKER,
  OVERSEER_END,
  type BrainRunner,
} from './swarmOverseerBrain'
import {
  listEscalations,
  listEscalationReceiptKeys,
  answerEscalation,
  openEscalation,
  dismissEscalation,
} from './swarmEscalations'
import { createSwarmFatalNotification } from './swarmNotifications'
import { readYouCorpus } from './youCorpus'
import { canonicalize } from './canonicalize'

const flush = () => new Promise((r) => setTimeout(r, 0))

// A blocked worker asking a REVERSIBLE, corpus-thin design question — C4 lets it
// reach the brain, and the (empty test) corpus can't ground it, so the brain abstains.
const QUESTION = '認証方式は OAuth と magic link のどちらを採用すべきですか？'

// A fake brain runner that emits a well-formed ABSTAIN verdict (calibrated "thin
// corpus" — K7), so answerAsOwner's REAL orchestration returns escalate/insufficient-info.
const abstainingBrain: BrainRunner = async () =>
  `${OVERSEER_MARKER} ABSTAIN | コーパスに認証方式の判断根拠がない ${OVERSEER_END}`

describe('C-core E2E — overseer S4 → abstention → inbox → answer → resume → corpus', () => {
  let projectPath: string

  beforeEach(async () => {
    // A real dir so canonicalize() resolves consistently (the store keys on it).
    projectPath = await canonicalize(await mkdtemp(join(tmpdir(), 'ogc-e2e-')))
  })

  it('runs the whole proxy-you loop through the real seams', async () => {
    const injectCalls: { terminalId: string; text: string }[] = []
    const notices: string[] = []
    const engine: OverseerEngine = {
      path: projectPath,
      running: true,
      anomalies: [],
      notified: new Set(),
      workers: [{ terminalId: 'term-e2e', branch: 'swarm/auth', taskId: 'card-auth', taskTitle: '認証の実装' }],
      reviews: [],
      overseer: { ...initOverseerRuntime(), enabled: true, lastJanitorAt: Number.MAX_SAFE_INTEGER },
    }
    const deps: OverseerDeps = {
      now: () => Date.now(),
      isAlive: () => true,
      readHeartbeat: async () => ({ ready: false, blocked: true, blockers: QUESTION }),
      // REAL C2 orchestration + REAL C4 gate; only the LLM PTY is the fake above.
      answerAsOwner: (q, signal) => answerAsOwner(q, { runBrain: abstainingBrain, signal }),
      openEscalation: (await import('./swarmEscalations')).openEscalation, // REAL persist
      canInjectInto: async () => true,
      injectAnswer: async (terminalId, text) => {
        injectCalls.push({ terminalId, text })
        return true
      },
      notifyInfo: async (n) => {
        notices.push(n.event)
        return {}
      },
      peekUsagePct: () => null, // no throttle
      refreshUsage: () => {},
      listEscalations,
      listReceiptKeys: listEscalationReceiptKeys,
      recentFatals: async () => [],
      runJanitor: async () => ({}),
    }

    // Pass 1 launches the brain (fire-and-forget); flush lets it settle into the mailbox.
    await runOverseerPass(engine, [], () => {}, deps)
    await flush()
    // Pass 2 drains the mailbox → the abstention is raised to the REAL inbox (T3).
    await runOverseerPass(engine, [], () => {}, deps)

    // ── The escalation is now persisted in the real escalations.json ──
    const open = await listEscalations({ projectPath, status: 'open' })
    expect(open).toHaveLength(1)
    const esc = open[0]
    expect(esc.question).toBe(QUESTION)
    expect(esc.whyEscalated).toBe('insufficient-info')
    expect(esc.proxyDraft?.isAbstention).toBe(true)
    expect(esc.taskId).toBe('card-auth')
    expect(esc.terminalId).toBe('term-e2e')

    // ── The owner answers → worker RESUMED (injected) + Q→A written to you-corpus ──
    const OWNER_ANSWER = 'magic link を採用してください（パスワード管理を減らす方針）。'
    const result = await answerEscalation(esc.id, OWNER_ANSWER, {
      // Fake the PTY delivery so it "lands" (worker live) → status 'injected'. The
      // landing-check scrape (getTerminalScreen) returns null for this fake terminal id,
      // which injectAnswerIntoWorker reads as "both writes landed" — no readScreen needed.
      write: () => true,
      canInjectInto: async () => true,
      isPathAllowed: async () => true,
      sleep: async () => {},
      // appendMemory is LEFT REAL (default appendJudgment → you-corpus).
    })
    expect(result.delivery).toBe('injected')
    expect(result.memoryWritten).toBe(true)

    // ── The record advanced to 'injected' (the worker got the answer) ──
    const afterAll = await listEscalations({ projectPath })
    expect(afterAll.find((e) => e.id === esc.id)?.status).toBe('injected')

    // ── The Q→A is now in the REAL you-corpus (the proxy-you training loop) ──
    const corpus = await readYouCorpus()
    expect(corpus).toContain('magic link を採用')
    expect(corpus).toContain(QUESTION.slice(0, 12)) // the question rode into memory too
  })
})

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
   *  brain/PTY/usage/janitor are inert fakes (none fire in this scenario).
   *  `raises` (optional) counts every raise attempt reaching the REAL openEscalation
   *  — the observable for "nothing was re-posted" when the ledger itself is the
   *  thing under attack (corrupt file ⇒ listEscalations can't verify). */
  const realishDeps = (raises?: { count: number }): OverseerDeps => {
    const real = defaultOverseerDeps({ isAlive: () => false, readHeartbeat: async () => null })
    return {
      now: () => Date.now(),
      isAlive: () => false,
      readHeartbeat: async () => null,
      answerAsOwner: async () => ({ kind: 'escalate', why: 'insufficient-info', reason: 'unused' }),
      openEscalation: async (input) => {
        if (raises) raises.count += 1
        return openEscalation(input) // REAL persist into escalations.json
      },
      canInjectInto: async () => false,
      injectAnswer: async () => false,
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

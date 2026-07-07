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
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  runOverseerPass,
  initOverseerRuntime,
  type OverseerEngine,
  type OverseerDeps,
} from './swarmOverseer'
import {
  answerAsOwner,
  OVERSEER_MARKER,
  OVERSEER_END,
  type BrainRunner,
} from './swarmOverseerBrain'
import { listEscalations, answerEscalation } from './swarmEscalations'
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

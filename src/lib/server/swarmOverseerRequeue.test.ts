import { describe, it, expect, vi } from 'vitest'
import { runOverseerPass, MAX_BRAIN_ROUTE_ATTEMPTS } from './swarmOverseer'

// ─── a failed inbox write must not destroy the question ──────────────────────
//
// THE LOSS (overnight review 2026-08-03). raiseToInbox returns false on an
// fs/notify hiccup, and its own comment states the contract it was written to:
// "leave `seen` UNSET so the NEXT PASS retries; the receiptKey keeps a later
// retry idempotent." But drainBrainResults spliced every result out of the
// mailbox first and then ignored the return — so there was no next pass to
// retry with. One failed write silently destroyed BOTH the worker's question
// and the proxy's answer, and the worker went on waiting for an inbox entry
// that would never appear. Nothing threw, nothing logged.
//
// These pin the restored contract and its bound: retry while it can, give up
// LOUDLY rather than growing the mailbox forever on a dead disk.

const engineWith = (results: unknown[]) =>
  ({
    path: '/repo',
    overseer: {
      enabled: true,
      brainResults: results,
      seen: new Map(),
      watch: new Map(),
      lastEscalateAt: 0,
      lastUsageAt: 0,
      usageBackoffUntil: 0,
      throttled: false,
      fingerprints: new Map(),
    },
  }) as never

const brainResult = (over: Record<string, unknown> = {}) => ({
  signalKey: 'S4:t1',
  question: 'このAPIキーを消していい?',
  context: 'ctx',
  taskId: 't1',
  branch: 'swarm/x',
  runtime: 'sdk' as const,
  sdkSessionId: 'sdk-1',
  answer: null, // ⇒ the escalate lane
  ...over,
})

/** Deps with a FAILING inbox write (openEscalation throws ⇒ raiseToInbox false). */
const failingDeps = () => ({
  now: () => 1_000,
  openEscalation: vi.fn(async () => {
    throw new Error('ENOSPC')
  }),
  notifyInfo: vi.fn(async () => {}),
  notifyFatal: vi.fn(async () => {}),
  peekUsagePct: () => null,
  refreshUsage: vi.fn(),
  runBrain: vi.fn(),
  deliverAnswer: vi.fn(async () => false),
  answerAsOwner: vi.fn(),
})

describe('drainBrainResults — a failed inbox write is retried, not lost', () => {
  it('re-queues the result so the next pass can retry it', async () => {
    const engine = engineWith([brainResult()])
    const deps = failingDeps()
    await runOverseerPass(engine, [], () => {}, deps as never)
    const mailbox = (engine as unknown as { overseer: { brainResults: { routeAttempts?: number }[] } })
      .overseer.brainResults
    expect(mailbox, 'the question must still be in the mailbox').toHaveLength(1)
    expect(mailbox[0].routeAttempts).toBe(1)
  })

  it('a SUCCESSFUL write drains it (no accidental duplicate escalation)', async () => {
    const engine = engineWith([brainResult()])
    const deps = { ...failingDeps(), openEscalation: vi.fn(async () => ({ id: 'e1' })) }
    await runOverseerPass(engine, [], () => {}, deps as never)
    expect(
      (engine as unknown as { overseer: { brainResults: unknown[] } }).overseer.brainResults,
    ).toHaveLength(0)
  })

  it('gives up LOUDLY after the attempt bound — the mailbox cannot grow forever', async () => {
    const engine = engineWith([brainResult({ routeAttempts: MAX_BRAIN_ROUTE_ATTEMPTS - 1 })])
    const lines: string[] = []
    await runOverseerPass(engine, [], (_l, m) => lines.push(m), failingDeps() as never)
    expect(
      (engine as unknown as { overseer: { brainResults: unknown[] } }).overseer.brainResults,
      'at the bound the result is dropped rather than re-queued',
    ).toHaveLength(0)
    expect(lines.some((l) => /GIVING UP/.test(l)), 'the drop must be said out loud').toBe(true)
  })
})

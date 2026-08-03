import { describe, it, expect } from 'vitest'
import { matchesRateLimit, normalizeScreen } from './swarmRateLimitText'
import { ptyWorkerRuntime, type WorkerRuntime } from './workerRuntime'

// ─── the quota sensor must not depend on OUR copy of Anthropic's wording ─────
//
// THE MISS (overnight review 2026-08-04). The engine's quota sensor is a
// WORDING matcher over the worker's recent output (swarmRateLimitText). The SDK
// pool does not guess wording — it matches the refusal against the SDK's own
// exported USAGE_LIMIT_ERROR_PREFIXES and parks the session. Where the two
// disagree, the engine loses: this real CLI refusal matches none of our
// patterns, so markRateLimited never fired, the tier never cooled, and dispatch
// kept launching workers into a dry tier — one fresh worktree burnt per attempt
// against a limit that would not lift for hours.
//
// The first test DOCUMENTS the blind spot (it asserts the matcher misses it —
// if a future pattern happens to cover this sentence, that is fine and the test
// says so out loud rather than silently passing). The rest pin the structural
// answer: a second, authoritative channel on the runtime seam, whose PTY arm
// stays false so text remains the only evidence there.

const OUT_OF_CREDITS = "You're out of usage credits. Add funds to continue."

describe('quota detection — wording matcher vs the pool verdict', () => {
  it('the wording matcher does NOT recognise the out-of-credits refusal (the blind spot)', () => {
    expect(
      matchesRateLimit(normalizeScreen(OUT_OF_CREDITS)),
      'if this now MATCHES, the pattern list grew — good, but the seam below is still the load-bearing answer',
    ).toBe(false)
  })

  it('every runtime answers the quota question — it is not optional on the seam', () => {
    // Required (not `?:`) on purpose: a future runtime that forgets it is a
    // compile error, not a silently blind sensor.
    const r: WorkerRuntime = ptyWorkerRuntime
    expect(typeof r.quotaBlocked).toBe('function')
  })

  it('the PTY arm reports false — its screen text IS the evidence, already read', () => {
    expect(ptyWorkerRuntime.quotaBlocked({ terminalId: 'term-1' } as never)).toBe(false)
  })
})

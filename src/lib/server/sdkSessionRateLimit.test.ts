// @vitest-environment node
//
// The pool's two seams for the SDK's structured limit state (AUTONOMY-SPEC
// R-D2 design, R-C1 (1)):
//   • every session's rate_limit event reaches the window store (the one
//     forwarding line in the distil loop);
//   • a refused desk pauses until the STRUCTURED reset, not the sentence's.
// The event shape is the CLI's own (claude-agent-sdk 0.3.220 bundled CLI): a
// refusal carries status + resetsAt (epoch s) + rateLimitType, no utilization.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  spawnSdkSession,
  getSdkSession,
  sdkQuotaPause,
  __resetSdkSessionsForTests,
  __setQuotaPrefixesForTests,
  type SdkQueryFn,
} from './sdkSession'
import { recordRateLimitEvent, usageWindowsSnapshot, flushUsageWindowsPersist, __resetUsageWindowsForTest } from './usageWindows'

const T0 = new Date(2026, 10, 23, 16, 33, 0).getTime()
const RESET_S = Math.round((T0 + 50 * 3_600_000) / 1000) // the weekly wall, two days away

const refusedWithEvent: SdkQueryFn = ({ prompt }) => ({
  async *[Symbol.asyncIterator]() {
    for await (const _input of prompt) {
      yield { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: RESET_S, rateLimitType: 'seven_day', isUsingOverage: false } }
      // The sentence names an earlier time on purpose: the structured reset must win.
      yield { type: 'assistant', message: { content: [{ type: 'text', text: "You've hit your weekly limit · resets 9pm" }] } }
      yield { type: 'result', subtype: 'success', terminal_reason: 'completed' }
    }
  },
})

beforeEach(() => {
  __resetSdkSessionsForTests()
  __resetUsageWindowsForTest()
  __setQuotaPrefixesForTests(["You've hit your"])
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
})
afterEach(async () => {
  vi.useRealTimers()
  __resetSdkSessionsForTests()
  __setQuotaPrefixesForTests(null)
  await flushUsageWindowsPersist()
  __resetUsageWindowsForTest()
})

describe('sdkSession × usage windows', () => {
  it('a refused session records the window and pauses until its structured reset', async () => {
    const s = spawnSdkSession({ cwd: '/proj', role: 'manager', options: {}, initialPrompt: 'start', queryFn: refusedWithEvent })
    await vi.waitFor(() => expect(getSdkSession(s.id)?.status).toBe('quota-parked'))
    await vi.waitFor(() => expect(sdkQuotaPause(s.id)).not.toBeNull())

    expect(usageWindowsSnapshot().seven_day).toMatchObject({ status: 'rejected', usedPct: 100, resetsAt: RESET_S * 1000 })
    expect(sdkQuotaPause(s.id)!.until).toBe(RESET_S * 1000)
  })

  // A desk's pause takes the reset of the window that refused IT: its own event,
  // or an account-wide window. Another session's per-model week must not make a
  // 5-hour refusal last four days (review 2026-11-28 B-M1: the commander paused 96 h).
  const refusedBy = (limitType: string, resetS: number): SdkQueryFn => ({ prompt }) => ({
    async *[Symbol.asyncIterator]() {
      for await (const _input of prompt) {
        yield { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: resetS, rateLimitType: limitType, isUsingOverage: false } }
        yield { type: 'assistant', message: { content: [{ type: 'text', text: "You've hit your limit · resets 9pm" }] } }
        yield { type: 'result', subtype: 'success', terminal_reason: 'completed' }
      }
    },
  })
  const pausedHours = async (queryFn: SdkQueryFn) => {
    const s = spawnSdkSession({ cwd: '/proj', role: 'manager', options: {}, initialPrompt: 'start', queryFn })
    await vi.waitFor(() => expect(sdkQuotaPause(s.id)).not.toBeNull())
    return (sdkQuotaPause(s.id)!.until - T0) / 3_600_000
  }

  it("another session's opus weekly wall does not stretch this desk's 5-hour pause", async () => {
    recordRateLimitEvent(
      { kind: 'rate_limit', status: 'rejected', utilization: null, resetsAt: Math.round((T0 + 96 * 3_600_000) / 1000), limitType: 'seven_day_opus' },
      T0 - 5 * 60_000,
    )
    expect(await pausedHours(refusedBy('five_hour', Math.round((T0 + 2 * 3_600_000) / 1000)))).toBe(2)
  })

  it("the desk's OWN per-model refusal still sets its pause", async () => {
    expect(await pausedHours(refusedBy('seven_day_opus', Math.round((T0 + 30 * 3_600_000) / 1000)))).toBe(30)
  })
})

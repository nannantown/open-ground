// @vitest-environment node
//
// A DESK A USAGE LIMIT REFUSED MUST HEAR AGAIN ONCE THE LIMIT IS BACK (2026-11-23).
//
// Measured 16:33: the commander's SDK desk was refused ("You've hit your 5-hour
// limit · resets 9pm"). The refusal paused its input admission, and nothing but a
// runtime switch ever lifted that pause — so every message to it after the limit
// came back (`POST /api/swarm/manager/say`) answered {"delivered":false} with no
// reason, the engine's nudges were dropped the same way, and the revive path kept
// adopting the deaf desk. Pinned here, each red against the pre-fix pool:
//   • refused → the stated reset time passes → a message is delivered and worked on;
//   • refused → the owner says the limit came back early → delivered at once;
//   • while still refused, the commander relay says WHY (usage-limit + when).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  spawnSdkSession,
  terminateSdkSession,
  pushSdkInput,
  getSdkSession,
  drainSdkSession,
  resumeSdkInputAdmission,
  resumeSdkQuotaPauses,
  sdkQuotaPause,
  __resetSdkSessionsForTests,
  __setQuotaPrefixesForTests,
  type SdkQueryFn,
} from './sdkSession'
import { sayToManagerDesk, type ManagerDeskHandle } from './swarmManagerRuntime'

const REFUSAL = "You've hit your 5-hour limit · resets 9pm (Asia/Tokyo)"

/** The turns numbered in `refuseTurns` are refused with `refusal`; every other turn
 *  does work (a tool call) — what a desk does once its limit is back. */
let turns: string[] = []
let refusal = REFUSAL
let refuseTurns = new Set([0])
const refuseOnceThenWork: SdkQueryFn = ({ prompt }) => ({
  async *[Symbol.asyncIterator]() {
    let turn = 0
    for await (const input of prompt) {
      turns.push(JSON.stringify(input))
      if (refuseTurns.has(turn++)) yield { type: 'assistant', message: { content: [{ type: 'text', text: refusal }] } }
      else yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: `t${turn}`, name: 'Bash', input: { command: 'ls' } }] } }
      yield { type: 'result', subtype: 'success', terminal_reason: 'completed' }
    }
  },
})
const handed = (text: string) => turns.filter((t) => t.includes(text)).length

/** Freeze the clock (Date only — the pool's own timers stay real) at a local time. */
const clockAt = (hour: number, minute: number) => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 10, 23, hour, minute, 0))
}

const refusedDesk = async () => {
  const s = spawnSdkSession({ cwd: '/proj', role: 'manager', options: {}, initialPrompt: 'start', queryFn: refuseOnceThenWork })
  await vi.waitFor(() => expect(getSdkSession(s.id)?.status).toBe('quota-parked'))
  await vi.waitFor(() => expect(sdkQuotaPause(s.id)).not.toBeNull())
  return s.id
}

const desk = (id: string): ManagerDeskHandle =>
  ({ runtime: 'sdk', handleId: id, cwd: '/proj', agentSessionId: null }) as unknown as ManagerDeskHandle

beforeEach(() => {
  turns = []
  refusal = REFUSAL
  refuseTurns = new Set([0])
  __resetSdkSessionsForTests()
  __setQuotaPrefixesForTests(["You've hit your", "You've reached your"])
})
afterEach(() => {
  vi.useRealTimers()
  __resetSdkSessionsForTests()
  __setQuotaPrefixesForTests(null)
})

describe('a refused desk hears again once the limit is back', () => {
  it('the stated reset time passes → the next message is delivered and worked on', async () => {
    // The clock is fixed BEFORE the refusal: read against the real one, "resets
    // 9pm" had already passed between 21:00 and 24:00 (UTC) and this went red
    // every evening (review 2026-11-26).
    clockAt(16, 33)
    const id = await refusedDesk()
    // Still inside the limit: held, and the pause knows when it ends (the refusal's own 9pm).
    expect(pushSdkInput(id, 'too early')).toBe(false)
    const until = sdkQuotaPause(id)!.until
    expect(until).toBe(new Date(2026, 10, 23, 21, 0, 0).getTime())

    vi.setSystemTime(until + 1000)
    expect(pushSdkInput(id, 'the limit is back — carry on')).toBe(true)
    vi.useRealTimers()
    await vi.waitFor(() => expect(turns.some((t) => t.includes('the limit is back — carry on'))).toBe(true))
    expect(sdkQuotaPause(id)).toBeNull()
    terminateSdkSession(id)
  })

  it('a refusal at night whose reset time already passed today pauses until that time TOMORROW, not for 20 minutes', async () => {
    // 11-23 22:21: "resets 2:50am". Read as a stale screen it was a 20-minute
    // pause, and the turn admitted after it met the same wall.
    clockAt(22, 21)
    refusal = "You've hit your 5-hour limit · resets 2:50am (Asia/Tokyo)"
    const id = await refusedDesk()
    expect(sdkQuotaPause(id)!.until).toBe(new Date(2026, 10, 24, 2, 50, 0).getTime())
    terminateSdkSession(id)
  })

  it('a reset time only just passed is the reset happening now, not one a day away', async () => {
    clockAt(21, 0)
    vi.setSystemTime(new Date(2026, 10, 23, 21, 0, 30))
    const id = await refusedDesk() // "resets 9pm", 30 s after 9pm
    const until = sdkQuotaPause(id)!.until
    expect(until - Date.now()).toBeLessThanOrEqual(20 * 60_000) // the flat grace, never 24 h
    terminateSdkSession(id)
  })

  it('a message refused before the desk did anything is kept and handed over when the limit lifts — never lost', async () => {
    // The desk takes input (no pause, or the last one lifted), so the relay
    // delivers — but the limit is spent and refuses the turn. Dropped, while the
    // sender had been told {ok:true} (review 2026-11-26).
    clockAt(16, 33)
    refuseTurns = new Set([1]) // the kickoff works; the next turn meets the limit
    const s = spawnSdkSession({ cwd: '/proj', role: 'manager', options: {}, initialPrompt: 'start', queryFn: refuseOnceThenWork })
    const id = s.id
    await vi.waitFor(() => expect(getSdkSession(id)?.status).toBe('waiting'))
    expect(sayToManagerDesk(desk(id), 'integrate the ready branch')).toEqual({ ok: true })
    await vi.waitFor(() => expect(sdkQuotaPause(id)).not.toBeNull()) // refused
    expect(handed('integrate the ready branch')).toBe(1)

    resumeSdkQuotaPauses() // the limit really is back
    await vi.waitFor(() => expect(handed('integrate the ready branch')).toBe(2))
    terminateSdkSession(id)
  })

  it('the pause ends by itself at the stated reset — a kept message does not wait for another sender', async () => {
    refusal = "You've hit your 5-hour limit · resets in 1 seconds"
    const id = await refusedDesk()
    // Nothing is pushed: the refused kickoff alone comes back once the reset passes.
    await vi.waitFor(() => expect(handed('start')).toBe(2), { timeout: 6000 })
    expect(sdkQuotaPause(id)).toBeNull()
    terminateSdkSession(id)
  })

  it('a turn that already ran a tool is not put back when the limit cuts it (never replay)', async () => {
    const q: SdkQueryFn = ({ prompt }) => ({
      async *[Symbol.asyncIterator]() {
        for await (const input of prompt) {
          turns.push(JSON.stringify(input))
          yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x1', name: 'Bash', input: { command: 'make' } }] } }
          yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x1', content: 'ok' }] } }
          yield { type: 'assistant', message: { content: [{ type: 'text', text: REFUSAL }] } }
          yield { type: 'result', subtype: 'success', terminal_reason: 'completed' }
        }
      },
    })
    const s = spawnSdkSession({ cwd: '/proj', role: 'manager', options: {}, initialPrompt: 'build it', queryFn: q })
    await vi.waitFor(() => expect(sdkQuotaPause(s.id)).not.toBeNull())
    resumeSdkQuotaPauses()
    await new Promise((r) => setTimeout(r, 50))
    expect(handed('build it')).toBe(1)
    terminateSdkSession(s.id)
  })

  it('the owner says the limit came back early → delivered at once, before the stated reset', async () => {
    const id = await refusedDesk()
    expect(pushSdkInput(id, 'still refused')).toBe(false)
    expect(resumeSdkQuotaPauses()).toBe(1)
    expect(pushSdkInput(id, 'reset early — go')).toBe(true)
    await vi.waitFor(() => expect(turns.some((t) => t.includes('reset early — go'))).toBe(true))
    terminateSdkSession(id)
  })

  it('a runtime drain keeps its own pause — neither the clock nor the owner lift ends it', async () => {
    const id = await refusedDesk()
    await drainSdkSession(id)
    expect(sdkQuotaPause(id)).toBeNull()
    expect(resumeSdkQuotaPauses()).toBe(0)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 48 * 3_600_000)
    expect(pushSdkInput(id, 'mid-transition')).toBe(false)
    vi.useRealTimers()
    resumeSdkInputAdmission(id)
    expect(pushSdkInput(id, 'after the transition')).toBe(true)
    terminateSdkSession(id)
  })
})

describe('the commander relay says why a message did not land', () => {
  it('a refused commander → usage-limit with the reset time; after the owner lift → delivered', async () => {
    const id = await refusedDesk()
    const held = sayToManagerDesk(desk(id), 'status?')
    expect(held).toEqual({ ok: false, heldBecause: 'usage-limit', retryAt: sdkQuotaPause(id)!.until })

    resumeSdkQuotaPauses()
    expect(sayToManagerDesk(desk(id), 'status?')).toEqual({ ok: true })
    await vi.waitFor(() => expect(turns.some((t) => t.includes('status?'))).toBe(true))
    terminateSdkSession(id)
  })
})

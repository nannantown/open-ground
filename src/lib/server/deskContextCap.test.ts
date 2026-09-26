import { describe, it, expect } from 'vitest'
import { recycleDeskSessionIfOverCap, deskRecycledLogLine, deskCompactedLogLine } from './deskContextCap'

// The commander's recycle decision (owner decision 2026-09-18). Fail-OPEN is the
// contract: any doubt ⇒ resume exactly as before — a conversation is only ever
// dropped on a MEASURED fill at or over a POSITIVE cap.
describe('recycleDeskSessionIfOverCap', () => {
  const RESUME = { agentSessionId: 'old-sid', resume: true }
  const deps = (tokens: number | null, cap = 300_000) => ({
    contextTokens: async () => tokens,
    cap: async () => cap,
    newId: () => 'new-sid',
  })

  it('under the cap ⇒ resumes the SAME conversation (the historical behaviour)', async () => {
    const r = await recycleDeskSessionIfOverCap(RESUME, deps(299_999))
    expect(r).toEqual({ session: RESUME, recycledFromTokens: null })
  })

  it('at/over the cap ⇒ a NEW conversation, not resumed, and says what it dropped', async () => {
    for (const t of [300_000, 346_076]) {
      const r = await recycleDeskSessionIfOverCap(RESUME, deps(t))
      expect(r.session).toEqual({ agentSessionId: 'new-sid', resume: false })
      expect(r.recycledFromTokens).toBe(t)
    }
  })

  it('an unmeasurable fill ⇒ resume (never drop a conversation on a guess)', async () => {
    expect((await recycleDeskSessionIfOverCap(RESUME, deps(null))).session).toBe(RESUME)
    const throwing = { ...deps(999_999), contextTokens: async () => Promise.reject(new Error('io')) }
    expect((await recycleDeskSessionIfOverCap(RESUME, throwing)).session).toBe(RESUME)
    const badCap = { ...deps(999_999), cap: async () => Promise.reject(new Error('settings')) }
    expect((await recycleDeskSessionIfOverCap(RESUME, badCap)).session).toBe(RESUME)
  })

  it('cap 0 = off ⇒ always resume', async () => {
    expect((await recycleDeskSessionIfOverCap(RESUME, deps(900_000, 0))).recycledFromTokens).toBeNull()
  })

  it('a FRESH session is left alone and not even measured', async () => {
    let measured = false
    const fresh = { agentSessionId: 'f', resume: false }
    const r = await recycleDeskSessionIfOverCap(fresh, {
      ...deps(900_000),
      contextTokens: async () => {
        measured = true
        return 900_000
      },
    })
    expect(r.session).toBe(fresh)
    expect(measured).toBe(false)
  })
})

describe('engine-log lines', () => {
  it('say what happened in the owner’s words, with the numbers', () => {
    expect(deskRecycledLogLine('司令官', 346_076)).toContain('司令官の卓を作り直した(文脈 346,076 から 0 へ)')
    expect(deskCompactedLogLine('補給官', 965_390, 170_458)).toBe('補給官の卓を圧縮した(文脈 965,390 から 170,458 へ)')
    expect(deskCompactedLogLine('補給官', 400_000, null)).toContain('から 不明 へ')
  })
})

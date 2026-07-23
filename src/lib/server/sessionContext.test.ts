import { describe, it, expect } from 'vitest'
import { attachContextLeftPct, paneContextLeftPct, type ContextLeftDeps } from './sessionContext'
import type { ActiveTerminalsResponse } from '@/lib/types'

// All seams injected — no live PTY pool, no real ~/.claude transcript. Defaults are
// the "nothing known" case; each test overrides what it exercises.
const deps = (over: Partial<ContextLeftDeps> = {}): ContextLeftDeps => ({
  getScreen: () => null,
  getSessionId: () => null,
  contextTokens: async () => null,
  ...over,
})

describe('paneContextLeftPct — per-session context "% free"', () => {
  it('reads the on-screen footnote when present — the near-limit alarm wins over JSONL', async () => {
    const d = deps({
      getScreen: () => ['⏺ hi', '  Context left until auto-compact: 12%'].join('\n'),
      // JSONL would estimate something else; the footnote must override it, because
      // it only appears near the limit and is the sharper value at that moment.
      getSessionId: () => 'sess',
      contextTokens: async () => 100_000,
    })
    expect(await paneContextLeftPct('t1', d)).toBe(12)
  })

  it('falls back to JSONL usage when there is no footnote (the always-on main source)', async () => {
    // 38,848 used of 200k ≈ 19% used → ~81% free (the spike's /context said 80.6%).
    const d = deps({ getSessionId: () => 'sess', contextTokens: async () => 38_848 })
    expect(await paneContextLeftPct('t1', d)).toBe(81)
  })

  it('clamps to 0–100 and rounds', async () => {
    expect(
      await paneContextLeftPct('t1', deps({ getSessionId: () => 's', contextTokens: async () => 0 })),
    ).toBe(100)
    // A session somehow past the window never reports a negative "% free".
    expect(
      await paneContextLeftPct('t1', deps({ getSessionId: () => 's', contextTokens: async () => 250_000 })),
    ).toBe(0)
  })

  it('is null when neither a footnote nor a session id is available', async () => {
    expect(await paneContextLeftPct('t1', deps())).toBeNull()
  })

  it('is null when the session has produced no transcript line yet', async () => {
    expect(
      await paneContextLeftPct('t1', deps({ getSessionId: () => 'sess', contextTokens: async () => null })),
    ).toBeNull()
  })
})

describe('attachContextLeftPct — beacon enrich', () => {
  const base = (): ActiveTerminalsResponse => ({
    cwds: ['/p'],
    claude: [
      { id: 'a', cwd: '/p', status: 'working' },
      { id: 'b', cwd: '/p', status: 'waiting' },
    ],
  })

  it('stamps every claude pane with contextLeftPct — a number, or null when unknown', async () => {
    const d = deps({
      getSessionId: (id) => (id === 'a' ? 'sa' : null),
      contextTokens: async () => 38_848,
    })
    const res = await attachContextLeftPct(base(), d)
    // Card contract: "なければ null" — the field is present on every pane, null when
    // no source resolved (pane b has no session id), never silently absent.
    expect(res.claude).toEqual([
      { id: 'a', cwd: '/p', status: 'working', contextLeftPct: 81 },
      { id: 'b', cwd: '/p', status: 'waiting', contextLeftPct: null },
    ])
    expect(res.cwds).toEqual(['/p']) // untouched
  })

  it('degrades one faulty pane to null without failing the whole beacon', async () => {
    const d = deps({
      getScreen: (id) => {
        if (id === 'a') throw new Error('boom')
        return null
      },
    })
    const res = await attachContextLeftPct(base(), d)
    expect(res.claude.map((c) => c.contextLeftPct)).toEqual([null, null])
    expect(res.claude.map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('returns the response untouched when there are no claude panes', async () => {
    const empty: ActiveTerminalsResponse = { cwds: [], claude: [] }
    expect(await attachContextLeftPct(empty, deps())).toEqual(empty)
  })
})

import { describe, it, expect } from 'vitest'
import { attachContextLeftPct, paneContextLeft, type ContextLeftDeps } from './sessionContext'
import type { ActiveTerminalsResponse } from '@/lib/types'

// All seams injected — no live PTY pool, no real ~/.claude transcript. Defaults are
// the "nothing known" case; each test overrides what it exercises.
const deps = (over: Partial<ContextLeftDeps> = {}): ContextLeftDeps => ({
  getScreen: () => null,
  getSessionId: () => null,
  contextTokens: async () => null,
  ...over,
})

describe('paneContextLeft — per-session context "% free" + its scale', () => {
  it('reads the on-screen footnote when present — the near-limit alarm wins over JSONL', async () => {
    const d = deps({
      getScreen: () => ['⏺ hi', '  Context left until auto-compact: 12%'].join('\n'),
      // JSONL would estimate something else; the footnote must override it, because
      // it only appears near the limit and is the sharper value at that moment.
      getSessionId: () => 'sess',
      contextTokens: async () => 100_000,
    })
    // The SOURCE travels with the number: 12 from the footnote means "12% to
    // auto-compact", not "12% of the window free" — the gauge colours them apart.
    expect(await paneContextLeft('t1', d)).toEqual({ pct: 12, source: 'footnote' })
  })

  it('falls back to JSONL usage when there is no footnote (the always-on main source)', async () => {
    // 38,848 used of 200k ≈ 19% used → ~81% free (the spike's /context said 80.6%).
    const d = deps({ getSessionId: () => 'sess', contextTokens: async () => 38_848 })
    expect(await paneContextLeft('t1', d)).toEqual({ pct: 81, source: 'jsonl' })
  })

  it('clamps to 0–100 and rounds', async () => {
    expect(
      await paneContextLeft('t1', deps({ getSessionId: () => 's', contextTokens: async () => 0 })),
    ).toEqual({ pct: 100, source: 'jsonl' })
    // A session somehow past the window never reports a negative "% free".
    expect(
      await paneContextLeft('t1', deps({ getSessionId: () => 's', contextTokens: async () => 250_000 })),
    ).toEqual({ pct: 0, source: 'jsonl' })
  })

  it('is null when neither a footnote nor a session id is available', async () => {
    expect(await paneContextLeft('t1', deps())).toBeNull()
  })

  it('is null when the session has produced no transcript line yet', async () => {
    expect(
      await paneContextLeft('t1', deps({ getSessionId: () => 'sess', contextTokens: async () => null })),
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

  it('stamps every claude pane with contextLeftPct + its source — null when unknown', async () => {
    const d = deps({
      getSessionId: (id) => (id === 'a' ? 'sa' : null),
      contextTokens: async () => 38_848,
    })
    const res = await attachContextLeftPct(base(), d)
    // Card contract: "なければ null" — the field is present on every pane, null when
    // no source resolved (pane b has no session id), never silently absent.
    expect(res.claude).toEqual([
      { id: 'a', cwd: '/p', status: 'working', contextLeftPct: 81, contextLeftSource: 'jsonl' },
      { id: 'b', cwd: '/p', status: 'waiting', contextLeftPct: null, contextLeftSource: null },
    ])
    expect(res.cwds).toEqual(['/p']) // untouched
  })

  it('carries the footnote source through, so the gauge can flag the alarm scale', async () => {
    const d = deps({
      getScreen: (id) => (id === 'a' ? 'Context left until auto-compact: 8%' : null),
    })
    const res = await attachContextLeftPct(base(), d)
    expect(res.claude[0]).toMatchObject({ contextLeftPct: 8, contextLeftSource: 'footnote' })
    expect(res.claude[1]).toMatchObject({ contextLeftPct: null, contextLeftSource: null })
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
    expect(res.claude.map((c) => c.contextLeftSource)).toEqual([null, null])
    expect(res.claude.map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('returns the response untouched when there are no claude panes', async () => {
    const empty: ActiveTerminalsResponse = { cwds: [], claude: [] }
    expect(await attachContextLeftPct(empty, deps())).toEqual(empty)
  })
})

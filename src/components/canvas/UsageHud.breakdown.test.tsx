// @vitest-environment jsdom
//
// "WHY is my weekly budget draining" — the question the gauge could not answer
// (2026-09-02: half a weekly Fable budget gone with no heavy card in flight; it
// was the always-on desks). The popover now lists the last 7 days grouped by
// model × where the session ran.
//
// TWO contracts are pinned here, and they pull in opposite directions:
//   1. the rows RENDER (model, source word, share %) — the panel is useless if
//      it only ever shows the empty state;
//   2. the scan is paid for ONLY when the popover opens — it walks a week of
//      transcripts, so putting it on the 5s poll would tax every session for a
//      number nobody is looking at.
//
// MUTATIONS that turn this red: drop the `open` gate on the effect (pre-open
// assertion fails); render the raw model id / drop the source word; compute the
// share against something other than the total.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('@/i18n/I18nContext', () => ({
  useT: () => ({
    t: (k: string, vars?: Record<string, string | number>) =>
      vars ? `${k} ${Object.entries(vars).map(([n, v]) => `${n}=${v}`).join(' ')}` : k,
    lang: 'en',
    setLang: () => {},
    toggleLang: () => {},
  }),
}))

import { UsageHud } from './UsageHud'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const USAGE = {
  windowHours: 5,
  windowStart: null,
  nextResetAt: null,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 1000 },
  messageCount: 0,
  byModel: {},
  currentModel: 'claude-fable-5-1',
  cli: {
    session: { pct: 40, resetsAt: '7:20 pm' },
    weekAll: { pct: 22, resetsAt: '1:00 pm (Mon)' },
    capturedAt: '2026-09-02T00:00:00.000Z',
    status: 'ok',
  },
}

const BREAKDOWN = {
  days: 7,
  total: 200,
  scannedAt: '2026-09-02T00:00:00.000Z',
  rows: [
    { model: 'claude-fable-5-1', source: 'project', tokens: 120 },
    { model: 'claude-fable-5-1', source: 'swarm-worker', tokens: 60 },
    { model: 'claude-opus-5', source: 'other', tokens: 20 },
  ],
}

/** Routes the two endpoints and counts the breakdown scans. */
const installFetch = () => {
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input)
      calls.push(url)
      const body = url.includes('/api/usage/breakdown') ? BREAKDOWN : USAGE
      return { ok: true, json: async () => body } as unknown as Response
    }),
  )
  return calls
}

describe('UsageHud — what used the budget (7 days)', () => {
  it('lists model × source with each share, only AFTER the popover is opened', async () => {
    const calls = installFetch()
    render(<UsageHud />)
    // The chip only renders once the mount fetch populated state.
    await screen.findByText('Fable 5.1')
    // ⚠ The week-wide walk must NOT run for a session that never opens the panel.
    expect(calls.some((u) => u.includes('/api/usage/breakdown'))).toBe(false)

    fireEvent.click(screen.getByLabelText('misc.usage.heading'))
    await waitFor(() => expect(calls.some((u) => u.includes('/api/usage/breakdown'))).toBe(true))

    // The rows: shortened model + the source in words + the share of the total.
    await screen.findByText('misc.usage.breakdown.heading')
    const panel = screen.getByText('misc.usage.breakdown.heading').parentElement!
    const text = panel.textContent ?? ''
    expect(text).toContain('Fable 5.1') // shortModel, not the raw id
    expect(text).toContain('misc.usage.breakdown.project')
    expect(text).toContain('misc.usage.breakdown.worker')
    expect(text).toContain('60%') // 120 / 200
    expect(text).toContain('30%') // 60 / 200
    expect(text).toContain('10%') // 20 / 200
    // The honesty line about the coarse 'project' bucket travels with the list.
    expect(text).toContain('misc.usage.breakdown.note')
  })

  it('a failed scan shows the empty state, never a fabricated zero-row table', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) =>
        String(input).includes('/api/usage/breakdown')
          ? ({ ok: false, json: async () => ({}) } as unknown as Response)
          : ({ ok: true, json: async () => USAGE } as unknown as Response),
      ),
    )
    render(<UsageHud />)
    await screen.findByText('Fable 5.1')
    fireEvent.click(screen.getByLabelText('misc.usage.heading'))
    await screen.findByText('misc.usage.breakdown.empty')
  })
})

// @vitest-environment jsdom
//
// UsageHud "no live %" FALLBACK test. When the CLI `/usage` scrape can't produce
// a cap-relative % (signed out / not installed / scrape failed / TUI format
// change), the gauge used to show a silent "—". This pins the hardened
// behaviour: the chip still falls back to "—", but the popover now states an
// explicit reason (from cli.status) AND surfaces the local-jsonl token total as
// a real fallback value — so the reading is never silent. The local total is
// shown COMPACTED (compactTokens), and the tests pin that interpolated value
// ("1.2M" / "800k") rather than only the message key. (The request-cancel
// wiring is covered separately in UsageHud.cancel.test.tsx.)
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

// Echo translation KEYS so we can assert which message rendered without the
// I18nProvider (same pattern as the cancel test). When interpolation vars are
// present, also append them as `name=value` pairs — so a test can pin the
// *interpolated* value (e.g. compactTokens' "1.2M" in the {tokens} slot), not
// merely the message key. (The real t() substitutes {tokens}/{hours}; the plain
// echo dropped those values, so the local-estimate line was only key-checked.)
vi.mock('@/i18n/I18nContext', () => ({
  useT: () => ({
    t: (k: string, vars?: Record<string, string | number>) =>
      vars ? `${k} ${Object.entries(vars).map(([name, v]) => `${name}=${v}`).join(' ')}` : k,
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

// A GET /api/usage payload with NO live % (cli.session null) — only a status
// reason and a local-jsonl token total.
const usageWith = (status: string, total: number) => ({
  windowHours: 5,
  windowStart: null,
  nextResetAt: null,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
  messageCount: 0,
  byModel: {},
  currentModel: 'claude-opus-4-8',
  cli: { session: null, weekAll: null, capturedAt: '2026-06-30T00:00:00.000Z', status },
})

// A fetch that resolves once with the given payload (UsageHud reads res.json()).
function installFetch(payload: unknown) {
  const fetchMock = vi.fn(async () => ({ json: async () => payload }) as unknown as Response)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('UsageHud — no-% fallback (reason + local estimate)', () => {
  it('scrape failed → "—" chip, but an explicit reason + local estimate in the popover', async () => {
    installFetch(usageWith('scrape-failed', 1_200_000))
    render(<UsageHud />)
    // The model label only renders once the mount fetch populated state.
    await screen.findByText('Opus 4.8')
    // The compact chip still shows "—" (no cap-relative %)…
    expect(screen.getByText('—')).toBeTruthy()
    // …but opening the popover reveals WHY and a real fallback value, instead of
    // a silent placeholder.
    fireEvent.click(screen.getByLabelText('misc.usage.heading'))
    expect(screen.getByText('misc.usage.reason.scrapeFailed')).toBeTruthy()
    // Pin the INTERPOLATED value, not just the message key: 1_200_000 local
    // tokens must compact to "1.2M" (compactTokens, M-branch → toFixed(1)) and
    // flow through t()'s {tokens} slot. A key-only assert would pass even if
    // compactTokens returned garbage.
    expect(screen.getByText(/misc\.usage\.localEstimate.*tokens=1\.2M/)).toBeTruthy()
  })

  it('signed out → the sign-in reason, and no estimate line when there are no local tokens', async () => {
    installFetch(usageWith('signed-out', 0))
    render(<UsageHud />)
    await screen.findByText('Opus 4.8')
    fireEvent.click(screen.getByLabelText('misc.usage.heading'))
    expect(screen.getByText('misc.usage.reason.signedOut')).toBeTruthy()
    // total 0 → no "≈0 tokens" noise.
    expect(screen.queryByText('misc.usage.localEstimate')).toBeNull()
  })

  // PARTIAL-PARSE consistency: the /usage TUI rendered enough rows to trigger a
  // parse (pctCount >= 3) but the "Current session" header shifted, so the server
  // returns status 'scrape-failed' with session=null YET a live weekAll. The chip
  // gates its at-a-glance week badge on `pct != null` (the same gate the popover's
  // week gauge sits behind), so it must NOT flash a lone week % while the popover
  // says "couldn't read" — both surfaces tell one story.
  it('partial parse (session row failed, week row OK) → chip hides the week badge so it matches the popover reason', async () => {
    installFetch({
      windowHours: 5,
      windowStart: null,
      nextResetAt: null,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 800_000 },
      messageCount: 0,
      byModel: {},
      currentModel: 'claude-opus-4-8',
      cli: {
        session: null,
        weekAll: { pct: 42, resetsAt: 'Jul 1 at 3pm (Asia/Tokyo)' },
        capturedAt: '2026-06-30T00:00:00.000Z',
        status: 'scrape-failed',
      },
    })
    render(<UsageHud />)
    await screen.findByText('Opus 4.8')
    // Session gauge has no live % → "—", and the week badge is GONE: its unique
    // chip-only label (weekShort) must be absent, so no lone week % leaks onto the
    // chip. (jsdom ignores Tailwind's `hidden`, so presence here is the React
    // conditional alone, not CSS.)
    expect(screen.getByText('—')).toBeTruthy()
    expect(screen.queryByText('misc.usage.weekShort')).toBeNull()
    // The popover tells the same story: an explicit reason, not a week gauge.
    fireEvent.click(screen.getByLabelText('misc.usage.heading'))
    expect(screen.getByText('misc.usage.reason.scrapeFailed')).toBeTruthy()
    // And it pins a DIFFERENT compactTokens branch than the 1.2M case above:
    // 800_000 local tokens compact to "800k" (k-branch → Math.round(n/1000)+"k").
    expect(screen.getByText(/misc\.usage\.localEstimate.*tokens=800k/)).toBeTruthy()
  })
})

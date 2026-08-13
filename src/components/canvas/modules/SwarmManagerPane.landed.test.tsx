// @vitest-environment jsdom
//
// 着地/週セクション(the durable outward-KPI)の描画契約。データの正しさは
// swarmLandedLedger.test.ts / swarmLandedKpi.routes.test.ts が持つ — ここは
// 「パネルがそれをオーナーに見せるか」だけを DOM で見る:
//   • landed が null(サーバ未回答)⇒ セクションごと出ない(推測で描かない)
//   • 合計ゼロ ⇒ チャートではなく1行の説明(新設ダイヤルの存在は一度は伝える)
//   • データあり ⇒ 見出し+凡例2行+バーの実体(SVG rect)
// Mutation that turns each red: the `landed &&` render gate inverted / the
// zero-totals branch dropped / the legend or bars removed.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { SwarmLandedKpi } from '@/lib/types'

vi.mock('@/i18n/I18nContext', () => ({
  useT: () => ({
    t: (k: string, v?: Record<string, unknown>) => (v ? `${k}:${JSON.stringify(v)}` : k),
    lang: 'en',
    setLang: () => {},
    toggleLang: () => {},
  }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}))

import { SwarmManagerPane } from './SwarmManagerPane'
import { DEFAULT_ENGINE } from './useSwarmEngine'

afterEach(cleanup)

const baseProps = {
  projectPath: '/p',
  session: null,
  sessionBusy: false,
  onLaunchSession: () => {},
  onStopSession: () => {},
  onSessionExit: () => {},
  onRestartSession: () => {},
  engine: DEFAULT_ENGINE,
  available: true,
  busy: false,
  error: null,
  onToggleOverseer: () => {},
  sandboxWarning: false,
  runtimeDials: null,
  onToggleRuntime: () => {},
}

const landedWith = (weeks: SwarmLandedKpi['weeks']): SwarmLandedKpi => ({
  weeks,
  perProject: [],
  totals: {
    self: weeks.reduce((n, w) => n + w.self, 0),
    external: weeks.reduce((n, w) => n + w.external, 0),
  },
})

describe('SwarmManagerPane — 着地/週 section', () => {
  it('renders NOTHING while the server has not answered (landed=null — never guess)', () => {
    render(<SwarmManagerPane {...baseProps} landed={null} />)
    expect(screen.queryByText(/landedHeading/)).toBeNull()
    expect(screen.queryByText(/landedEmpty/)).toBeNull()
  })

  it('renders the one-line explainer (not a chart) when the ledger is empty', () => {
    const landed = landedWith([
      { weekStart: '2026-08-03', self: 0, external: 0 },
      { weekStart: '2026-08-10', self: 0, external: 0 },
    ])
    const { container } = render(<SwarmManagerPane {...baseProps} landed={landed} />)
    expect(screen.getByText(/landedHeading/)).toBeTruthy()
    expect(screen.getByText(/landedEmpty/)).toBeTruthy()
    expect(container.querySelector('svg[aria-label*="landedExternal"]')).toBeNull()
  })

  it('renders heading + both legend rows + real bars when data exists', () => {
    const landed = landedWith([
      { weekStart: '2026-08-03', self: 1, external: 2 },
      { weekStart: '2026-08-10', self: 0, external: 3 },
    ])
    const { container } = render(<SwarmManagerPane {...baseProps} landed={landed} />)
    expect(screen.getByText(/landedHeading/)).toBeTruthy()
    // Scope line carries the window length so the cross-project scope is explicit.
    expect(screen.getByText(/landedScope.*"weeks":2/)).toBeTruthy()
    // Legend: identity in TEXT (never color-alone) + the window totals.
    expect(screen.getByText(/landedExternal/)).toBeTruthy()
    expect(screen.getByText(/landedSelf/)).toBeTruthy()
    expect(screen.getByText('5')).toBeTruthy() // external window sum
    expect(screen.getByText('1')).toBeTruthy() // self window sum
    // Bars exist: external in both weeks + self in one = 3 data rects (hit
    // targets and the baseline are extra, so assert on the fill attribute).
    const dataRects = container.querySelectorAll('svg rect[fill^="rgb(var(--og-"]')
    expect(dataRects.length).toBe(4) // 3 data segments + 1 baseline
    // Per-week tooltip carries both numbers.
    expect(container.querySelector('svg title')?.textContent).toContain('landedWeekTip')
  })
})

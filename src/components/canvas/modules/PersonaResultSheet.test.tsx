// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'

vi.mock('@/i18n/I18nContext', () => ({
  useT: () => ({
    t: (k: string, p?: Record<string, unknown>) =>
      p ? `${k}:${Object.values(p).join(',')}` : k,
  }),
}))

import { PersonaResultSheet } from './PersonaResultSheet'
import type { PersonaResult } from '@/lib/types'

const result: PersonaResult = {
  courseId: 'big5',
  courseName: 'Big Five',
  kind: 'bars',
  source: 'IPIP-NEO (public domain)',
  itemCount: 20,
  headline: '見出し',
  rows: [{ key: 'o', name: '開放性', pct: 60, note: '高め', desc: '説明' }],
  findings: [{ text: '所見', detail: '根拠' }],
}

const sheet = (onClose: () => void) =>
  render(
    <PersonaResultSheet
      result={result}
      sub="20問"
      takenAt="8月16日"
      onClose={onClose}
      onRetake={() => {}}
    />,
  )

describe('PersonaResultSheet', () => {
  // This sheet was the one overlay in the app that hand-rolled its own scrim
  // instead of using the shared shell — which is exactly why it was also the one
  // the owner could not dismiss by tapping outside it. Reverting the Scrim to a
  // plain `<div className="absolute inset-0 …">` is the regression this catches;
  // Overlay.test.tsx covers the RULE, this covers the WIRING.
  it('tapping the scrim closes the sheet', () => {
    const onClose = vi.fn()
    sheet(onClose)
    fireEvent.mouseDown(document.querySelector('[data-esc-overlay]')!)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('tapping the sheet itself does not', () => {
    const onClose = vi.fn()
    const { getByText } = sheet(onClose)
    fireEvent.mouseDown(getByText('見出し'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('Escape closes it too', () => {
    const onClose = vi.fn()
    sheet(onClose)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

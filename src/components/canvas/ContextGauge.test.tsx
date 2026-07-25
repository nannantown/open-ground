// @vitest-environment jsdom
//
// The per-pane context gauge + its manual escape hatch. What is pinned here is
// what the owner can actually SEE and DO: the reading is labelled on the right
// scale (the footnote and JSONL numbers mean different things), a pane with no
// claude session offers no "send into the session" buttons, and every press
// reports back in one plain line.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { ContextGauge } from './ContextGauge'

// Echo translation KEYS (+ interpolated vars) so assertions pin the message
// that rendered without dragging in the provider — the house pattern from
// UsageHud.fallback.test.tsx.
vi.mock('@/i18n/I18nContext', () => ({
  useT: () => ({
    t: (k: string, vars?: Record<string, string | number>) =>
      vars
        ? `${k} ${Object.entries(vars)
            .map(([name, v]) => `${name}=${v}`)
            .join(' ')}`
        : k,
    lang: 'en',
  }),
}))

afterEach(cleanup)

const open = () => fireEvent.click(screen.getByRole('button', { name: /contextGauge.label/ }))
const fill = () => screen.getByTestId('context-gauge-fill')
// Each action button carries its label AND a one-line description, which run
// together in the computed accessible name — so reach the button through its
// label text instead (exact match, so `clear` can't also hit `clearHint`).
const actionBtn = (id: 'compact' | 'clear' | 'fresh'): HTMLButtonElement => {
  const btn = screen.getByText(`projectPanel.contextGauge.${id}`).closest('button')
  if (!btn) throw new Error(`no button for ${id}`)
  return btn as HTMLButtonElement
}
// The optional "what the summary should keep" box that belongs to /compact.
const focusBox = () =>
  screen.getByLabelText('projectPanel.contextGauge.focusLabel') as HTMLInputElement

describe('ContextGauge — the reading', () => {
  it('shows how FULL the window is from a "% free" reading', () => {
    render(<ContextGauge leftPct={81} source="jsonl" hasSession onAction={async () => 'ok'} />)
    expect(fill()).toHaveStyle({ width: '19%' })
    expect(fill().className).toContain('bg-moss')
  })

  it('stays quiet while healthy — no number in the tab', () => {
    render(<ContextGauge leftPct={81} source="jsonl" hasSession onAction={async () => 'ok'} />)
    expect(screen.queryByText('19%')).toBeNull()
    expect(screen.queryByText('81%')).toBeNull()
  })

  it('shows the number in the tab once it turns amber', () => {
    render(<ContextGauge leftPct={12} source="jsonl" hasSession onAction={async () => 'ok'} />)
    expect(screen.getByText('12%')).toBeTruthy()
    expect(fill().className).toContain('bg-ochre')
  })

  it('labels a JSONL reading as free room', () => {
    render(<ContextGauge leftPct={81} source="jsonl" hasSession onAction={async () => 'ok'} />)
    open()
    expect(screen.getByText(/contextGauge.readingWindow pct=81/)).toBeTruthy()
  })

  it('labels a FOOTNOTE reading as the auto-summarise countdown — and never paints it green', () => {
    // The card-2 hand-off: 40 from the footnote is an alarm, 40 from JSONL is
    // comfortable. Same number, different wording AND different colour.
    render(<ContextGauge leftPct={40} source="footnote" hasSession onAction={async () => 'ok'} />)
    expect(fill().className).toContain('bg-ochre')
    open()
    expect(screen.getByText(/contextGauge.readingFootnote pct=40/)).toBeTruthy()
    expect(screen.queryByText(/contextGauge.readingWindow/)).toBeNull()
  })

  it('reads as "nothing yet" with no number, without pretending the pane is empty', () => {
    render(<ContextGauge hasSession leftPct={null} onAction={async () => 'ok'} />)
    expect(fill()).toHaveStyle({ width: '0%' })
    expect(fill().className).toContain('bg-white/25')
    open()
    expect(screen.getByText('projectPanel.contextGauge.readingNone')).toBeTruthy()
  })
})

describe('ContextGauge — the escape hatch', () => {
  it('sends /compact for the pane and reports the outcome in one plain line', async () => {
    const onAction = vi.fn(async () => 'ok' as const)
    render(<ContextGauge leftPct={12} source="jsonl" hasSession onAction={onAction} />)
    open()
    fireEvent.click(actionBtn('compact'))
    await waitFor(() =>
      expect(screen.getByText('projectPanel.contextGauge.outcome.ok')).toBeTruthy(),
    )
    expect(onAction).toHaveBeenCalledWith('compact')
  })

  it('offers clear-and-continue and a fresh session too', async () => {
    const onAction = vi.fn(async () => 'ok' as const)
    render(<ContextGauge leftPct={12} source="jsonl" hasSession onAction={onAction} />)
    open()
    fireEvent.click(actionBtn('clear'))
    await waitFor(() => expect(onAction).toHaveBeenCalledWith('clear'))
    fireEvent.click(actionBtn('fresh'))
    await waitFor(() => expect(onAction).toHaveBeenCalledWith('fresh'))
  })

  it('says what to do when claude is mid-turn', async () => {
    render(
      <ContextGauge leftPct={12} source="jsonl" hasSession onAction={async () => 'busy'} />,
    )
    open()
    fireEvent.click(actionBtn('compact'))
    await waitFor(() =>
      expect(screen.getByText('projectPanel.contextGauge.outcome.busy')).toBeTruthy(),
    )
  })

  it('reports an outcome even when the action throws', async () => {
    render(
      <ContextGauge
        leftPct={12}
        source="jsonl"
        hasSession
        onAction={async () => {
          throw new Error('offline')
        }}
      />,
    )
    open()
    fireEvent.click(actionBtn('compact'))
    await waitFor(() =>
      expect(screen.getByText('projectPanel.contextGauge.outcome.error')).toBeTruthy(),
    )
  })

  it('disables the two send buttons with no session — and clicking does nothing', () => {
    const onAction = vi.fn(async () => 'ok' as const)
    render(<ContextGauge hasSession={false} onAction={onAction} />)
    open()
    const compact = actionBtn('compact')
    const clear = actionBtn('clear')
    const fresh = actionBtn('fresh')
    expect(compact).toBeDisabled()
    expect(clear).toBeDisabled()
    // A fresh session is exactly what a pane with no session needs — it stays live.
    expect(fresh).not.toBeDisabled()
    fireEvent.click(compact)
    expect(onAction).not.toHaveBeenCalled()
    // The guidance box belongs to compact, so it goes inert with it.
    expect(focusBox()).toBeDisabled()
  })

  // The card's optional extra: "compact now" can carry one line of guidance
  // ("keep the payment work"). It rides ONLY with /compact — the other two take
  // no argument, and claude would reject the whole line if one were appended.
  it('carries a typed focus hint with /compact — and only with /compact', async () => {
    const onAction = vi.fn(async () => 'ok' as const)
    render(<ContextGauge leftPct={12} source="jsonl" hasSession onAction={onAction} />)
    open()
    fireEvent.change(focusBox(), { target: { value: '  keep the payment work  ' } })
    fireEvent.click(actionBtn('compact'))
    // Trimmed — leading/trailing space would be typed into the pane verbatim.
    await waitFor(() => expect(onAction).toHaveBeenCalledWith('compact', 'keep the payment work'))

    fireEvent.change(focusBox(), { target: { value: 'still typed here' } })
    fireEvent.click(actionBtn('clear'))
    await waitFor(() => expect(onAction).toHaveBeenCalledWith('clear'))
  })

  it('sends no hint argument at all when the box is empty', async () => {
    const onAction = vi.fn(async () => 'ok' as const)
    render(<ContextGauge leftPct={12} source="jsonl" hasSession onAction={onAction} />)
    open()
    fireEvent.change(focusBox(), { target: { value: '   ' } })
    fireEvent.click(actionBtn('compact'))
    // Whitespace is not guidance: the call must be indistinguishable from a
    // plain press, not `/compact` followed by a blank.
    await waitFor(() => expect(onAction).toHaveBeenCalledWith('compact'))
  })

  it('clears a hint once it has been sent, so the next press does not repeat it', async () => {
    const onAction = vi.fn(async () => 'ok' as const)
    render(<ContextGauge leftPct={12} source="jsonl" hasSession onAction={onAction} />)
    open()
    fireEvent.change(focusBox(), { target: { value: 'keep the payment work' } })
    fireEvent.click(actionBtn('compact'))
    await waitFor(() => expect(focusBox().value).toBe(''))
  })

  it('keeps a hint that did NOT go through, so it can be retried as typed', async () => {
    const onAction = vi.fn(async () => 'busy' as const)
    render(<ContextGauge leftPct={12} source="jsonl" hasSession onAction={onAction} />)
    open()
    fireEvent.change(focusBox(), { target: { value: 'keep the payment work' } })
    fireEvent.click(actionBtn('compact'))
    await waitFor(() => expect(onAction).toHaveBeenCalled())
    expect(focusBox().value).toBe('keep the payment work')
  })

  it('submits on Enter — but never steals the Enter that confirms an IME conversion', async () => {
    const onAction = vi.fn(async () => 'ok' as const)
    render(<ContextGauge leftPct={12} source="jsonl" hasSession onAction={onAction} />)
    open()
    fireEvent.change(focusBox(), { target: { value: '決済まわりの作業を残す' } })
    // Mid-conversion Enter: the IME is confirming candidate text, NOT submitting.
    fireEvent.keyDown(focusBox(), { key: 'Enter', isComposing: true })
    expect(onAction).not.toHaveBeenCalled()
    // Enter after the conversion is committed does submit.
    fireEvent.keyDown(focusBox(), { key: 'Enter' })
    await waitFor(() =>
      expect(onAction).toHaveBeenCalledWith('compact', '決済まわりの作業を残す'),
    )
  })

  it('blocks a second press while one is still in flight', async () => {
    let release: (v: 'ok') => void = () => {}
    const onAction = vi.fn(() => new Promise<'ok'>(res => (release = res)))
    render(<ContextGauge leftPct={12} source="jsonl" hasSession onAction={onAction} />)
    open()
    const compact = actionBtn('compact')
    fireEvent.click(compact)
    await waitFor(() => expect(compact).toBeDisabled())
    fireEvent.click(actionBtn('clear'))
    expect(onAction).toHaveBeenCalledTimes(1)
    release('ok')
  })
})

describe('ContextGauge — the panel', () => {
  it('opens on press and closes on Escape', () => {
    render(<ContextGauge leftPct={81} source="jsonl" hasSession onAction={async () => 'ok'} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    open()
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('closes on an outside click', () => {
    render(<ContextGauge leftPct={81} source="jsonl" hasSession onAction={async () => 'ok'} />)
    open()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('swallows mousedown so opening it cannot start a pane drag', () => {
    // The pane tab this sits in IS the drag handle (ProjectPanel's
    // startTabDrag) — a gauge press must never move the pane.
    const onParentDown = vi.fn()
    render(
      <div onMouseDown={onParentDown}>
        <ContextGauge leftPct={81} source="jsonl" hasSession onAction={async () => 'ok'} />
      </div>,
    )
    fireEvent.mouseDown(screen.getByRole('button', { name: /contextGauge.label/ }))
    expect(onParentDown).not.toHaveBeenCalled()
  })
})

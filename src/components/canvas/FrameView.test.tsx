// @vitest-environment jsdom
import { fireEvent, render } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { FrameView } from './FrameView'

vi.mock('@/i18n/I18nContext', () => ({ useT: () => ({ t: (key: string) => key }) }))
const frame = { id: 'ordinary', type: 'frame' as const, text: '通常フレーム', x: 0, y: 0, width: 480, height: 320 }
const props = { frame, selected: false, editing: false, onHeaderPointerDown: vi.fn(), onChangeLabel: vi.fn(), onEditDone: vi.fn() }

it('toggles this normal frame without starting a drag, using a Gothic title and all button states', () => {
  const toggle = vi.fn(), drag = vi.fn()
  const view = render(<FrameView {...props} onHeaderPointerDown={drag} onToggleAutomation={toggle} />)
  const control = view.getByRole('switch', { name: 'canvasEl.frame.automationLabel' })
  expect(control).toHaveAttribute('aria-checked', 'false')
  expect(view.getByText('通常フレーム')).toHaveClass('font-body')
  expect(control.className).toContain('hover:')
  expect(control.className).toContain('active:')
  expect(control.className).toContain('focus-visible:')
  expect(control.className).toContain('disabled:')
  fireEvent.pointerDown(control)
  fireEvent.click(control)
  expect(toggle).toHaveBeenCalledExactlyOnceWith(true)
  expect(drag).not.toHaveBeenCalled()
  view.rerender(<FrameView {...props} automation onToggleAutomation={toggle} />)
  expect(control).toHaveAttribute('aria-checked', 'true')
  fireEvent.click(control)
  expect(toggle).toHaveBeenLastCalledWith(false)
})

it('keeps the editable title Gothic and preserves the switch during label editing', () => {
  const view = render(<FrameView {...props} editing onToggleAutomation={() => {}} />)
  expect(view.getByRole('textbox')).toHaveClass('font-body')
  expect(view.getByRole('switch')).toBeVisible()
})

it('keeps the configured intent visible while a locked or pending control cannot mutate it', () => {
  const toggle = vi.fn()
  const view = render(<FrameView {...props} automation automationDisabled onToggleAutomation={toggle} />)
  const control = view.getByRole('switch')
  expect(control).toHaveAttribute('aria-checked', 'true')
  expect(control).toBeDisabled()
  fireEvent.click(control)
  expect(toggle).not.toHaveBeenCalled()
  view.rerender(<FrameView {...props} automation automationBusy onToggleAutomation={toggle} />)
  expect(control).toBeDisabled()
  expect(control).toHaveAttribute('aria-busy', 'true')
})

it('omits automation controls and the retired role badge when no owner action is available', () => {
  const view = render(<FrameView {...props} automation />)
  expect(view.queryByRole('switch')).not.toBeInTheDocument()
  expect(view.queryByText('canvasEl.frame.automation')).not.toBeInTheDocument()
})

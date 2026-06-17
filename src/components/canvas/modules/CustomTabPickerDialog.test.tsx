// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'

// The "+" picker (docs/CUSTOM_TABS_PLAN.md — per-project attachment): lists
// the library, attaches on click (already-attached rows are inert), shows the
// empty-library copy, and hosts the LIBRARY-level two-step delete/uninstall.
// All effects are callbacks — no fetch in the dialog itself — so the test
// asserts the contract through them.

vi.mock('@/i18n/I18nContext', () => ({
  useT: () => ({ t: (k: string, p?: Record<string, string>) => (p ? `${k}:${Object.values(p).join(',')}` : k) }),
}))

import { CustomTabPickerDialog, moduleRemoveKind } from './CustomTabPickerDialog'
import type { CustomModuleDef } from '@/lib/types'

const mod = (id: string, over: Partial<CustomModuleDef> = {}): CustomModuleDef => ({
  id,
  label: `Tab ${id}`,
  description: `desc ${id}`,
  framework: 'react',
  origin: 'local',
  createdAt: '2026-06-12T00:00:00.000Z',
  updatedAt: '2026-06-12T00:00:00.000Z',
  ...over,
})

const A = 'aaaaaaaa-0000-4000-8000-000000000001'
const B = 'bbbbbbbb-0000-4000-8000-000000000002'

const noop = () => {}

describe('CustomTabPickerDialog', () => {
  it('lists the library with label + description preview', () => {
    const { getByText } = render(
      <CustomTabPickerDialog
        modules={[mod(A), mod(B, { origin: 'installed', version: 3 })]}
        role="owner"
        attachedIds={new Set()}
        onAttach={noop}
        onDelete={noop}
        onClose={noop}
      />,
    )
    expect(getByText(`Tab ${A}`)).toBeTruthy()
    expect(getByText(`desc ${A}`)).toBeTruthy()
    expect(getByText(`Tab ${B}`)).toBeTruthy()
    // origin/version badges on the installed, published module
    expect(getByText('customTabs.installed')).toBeTruthy()
    expect(getByText('customTabs.publishedBadge:3')).toBeTruthy()
  })

  it('clicking an unattached row attaches it; an attached row is inert', () => {
    const onAttach = vi.fn()
    const { getByText } = render(
      <CustomTabPickerDialog
        modules={[mod(A), mod(B)]}
        role="owner"
        attachedIds={new Set([B])}
        onAttach={onAttach}
        onDelete={noop}
        onClose={noop}
      />,
    )
    fireEvent.click(getByText(`Tab ${A}`))
    expect(onAttach).toHaveBeenCalledWith(A)
    // The attached row is disabled and marked 追加済み — a click does nothing.
    expect(getByText('customTabs.pickerAttached')).toBeTruthy()
    fireEvent.click(getByText(`Tab ${B}`))
    expect(onAttach).toHaveBeenCalledTimes(1)
  })

  it('empty library: the empty copy plus the create command only', () => {
    const onCreateNew = vi.fn()
    const { getByText, queryByText } = render(
      <CustomTabPickerDialog
        modules={[]}
        role="owner"
        attachedIds={new Set()}
        onAttach={noop}
        onCreateNew={onCreateNew}
        onDelete={noop}
        onClose={noop}
      />,
    )
    expect(getByText('customTabs.pickerEmpty')).toBeTruthy()
    expect(queryByText('customTabs.delete')).toBeNull()
    fireEvent.click(getByText('customTabs.pickerCreateNew'))
    expect(onCreateNew).toHaveBeenCalledTimes(1)
  })

  it('tester without onCreateNew sees no create command', () => {
    const { queryByText } = render(
      <CustomTabPickerDialog
        modules={[]}
        role="tester"
        attachedIds={new Set()}
        onAttach={noop}
        onDelete={noop}
        onClose={noop}
      />,
    )
    expect(queryByText('customTabs.pickerCreateNew')).toBeNull()
  })

  it('owner delete is two-step: arm, then fire', () => {
    const onDelete = vi.fn().mockResolvedValue(undefined)
    const { getByLabelText } = render(
      <CustomTabPickerDialog
        modules={[mod(A)]}
        role="owner"
        attachedIds={new Set()}
        onAttach={noop}
        onDelete={onDelete}
        onClose={noop}
      />,
    )
    // First click only arms the confirm — nothing deleted yet. In the register
    // redesign the trash is an icon button (aria-label, no visible text), so
    // find it by its accessible label.
    fireEvent.click(getByLabelText('customTabs.delete'))
    expect(onDelete).not.toHaveBeenCalled()
    // The armed confirm exposes a ✓ button labelled with the confirm copy.
    fireEvent.click(getByLabelText('customTabs.deleteConfirmYes'))
    expect(onDelete).toHaveBeenCalledWith(A)
  })

  it('tester sees uninstall on installed modules only', () => {
    const { getByLabelText, queryByLabelText } = render(
      <CustomTabPickerDialog
        modules={[mod(A), mod(B, { origin: 'installed' })]}
        role="tester"
        attachedIds={new Set()}
        onAttach={noop}
        onDelete={noop}
        onClose={noop}
      />,
    )
    expect(queryByLabelText('customTabs.delete')).toBeNull()
    expect(getByLabelText('customTabs.uninstall')).toBeTruthy()
  })

  it('renders the Built-in section with each module’s show/hide state', () => {
    const { getByText } = render(
      <CustomTabPickerDialog
        modules={[]}
        role="none"
        attachedIds={new Set()}
        natives={[
          { id: 'board', label: 'Board', enabled: true },
          { id: 'canvas', label: 'Canvas', enabled: false },
        ]}
        canDisableNative
        onToggleNative={noop}
        onAttach={noop}
        onDelete={noop}
        onClose={noop}
      />,
    )
    expect(getByText('Board')).toBeTruthy()
    expect(getByText('Canvas')).toBeTruthy()
    expect(getByText('customTabs.shown')).toBeTruthy()
    expect(getByText('customTabs.hidden')).toBeTruthy()
  })

  it('clicking an enabled built-in hides it; a disabled one shows it', () => {
    const onToggleNative = vi.fn()
    const { getByText } = render(
      <CustomTabPickerDialog
        modules={[]}
        role="none"
        attachedIds={new Set()}
        natives={[
          { id: 'board', label: 'Board', enabled: true },
          { id: 'canvas', label: 'Canvas', enabled: false },
        ]}
        canDisableNative
        onToggleNative={onToggleNative}
        onAttach={noop}
        onDelete={noop}
        onClose={noop}
      />,
    )
    fireEvent.click(getByText('Board'))
    expect(onToggleNative).toHaveBeenCalledWith('board', false)
    fireEvent.click(getByText('Canvas'))
    expect(onToggleNative).toHaveBeenCalledWith('canvas', true)
  })

  it('the last visible built-in is locked — a click cannot hide it', () => {
    const onToggleNative = vi.fn()
    const { getByText } = render(
      <CustomTabPickerDialog
        modules={[]}
        role="none"
        attachedIds={new Set()}
        natives={[{ id: 'terminal', label: 'Terminal', enabled: true }]}
        canDisableNative={false}
        onToggleNative={onToggleNative}
        onAttach={noop}
        onDelete={noop}
        onClose={noop}
      />,
    )
    fireEvent.click(getByText('Terminal'))
    expect(onToggleNative).not.toHaveBeenCalled()
  })

  it('omitting onToggleNative hides the Built-in section entirely', () => {
    const { queryByText } = render(
      <CustomTabPickerDialog
        modules={[mod(A)]}
        role="owner"
        attachedIds={new Set()}
        natives={[{ id: 'board', label: 'Board', enabled: true }]}
        onAttach={noop}
        onDelete={noop}
        onClose={noop}
      />,
    )
    expect(queryByText('customTabs.builtinSection')).toBeNull()
    expect(queryByText('Board')).toBeNull()
  })

  it('Escape and a backdrop click both close', () => {
    const onClose = vi.fn()
    const { getByText } = render(
      <CustomTabPickerDialog
        modules={[mod(A)]}
        role="owner"
        attachedIds={new Set()}
        onAttach={noop}
        onDelete={noop}
        onClose={onClose}
      />,
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    // Backdrop (the data-esc-overlay element itself) closes; a click inside
    // the card must not.
    fireEvent.mouseDown(getByText('customTabs.pickerTitle'))
    expect(onClose).toHaveBeenCalledTimes(1)
    const backdrop = document.querySelector('[data-esc-overlay]')!
    fireEvent.mouseDown(backdrop)
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})

describe('moduleRemoveKind', () => {
  it('owner deletes anything; tester uninstalls installed only; none gets nothing', () => {
    expect(moduleRemoveKind('owner', { origin: 'local' })).toBe('delete')
    expect(moduleRemoveKind('owner', { origin: 'installed' })).toBe('delete')
    expect(moduleRemoveKind('tester', { origin: 'local' })).toBeNull()
    expect(moduleRemoveKind('tester', { origin: 'installed' })).toBe('uninstall')
    expect(moduleRemoveKind('none', { origin: 'installed' })).toBeNull()
  })
})

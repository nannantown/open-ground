// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, screen, act } from '@testing-library/react'

// Identity translator + a network-free api client. The panel's open-effect
// fetches GET /api/settings for the display-name placeholder; the autosave
// path itself never touches the network (it goes through the onSave prop).
vi.mock('@/i18n/I18nContext', () => ({
  useT: () => ({ t: (k: string) => k, lang: 'en', setLang: () => {} }),
}))
vi.mock('@/lib/api-client', () => ({
  api: {
    api: {
      settings: {
        $get: () => Promise.resolve({ ok: false }),
      },
      'pick-folder': { $post: () => Promise.resolve({ json: () => Promise.resolve({}) }) },
      // The Research-channels section fetches both on mount (2026-08-14) — a
      // mock without them crashes EVERY panel render, not just its own tests.
      research: {
        channels: {
          $get: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ channels: [] }) }),
        },
        auth: {
          $get: () =>
            Promise.resolve({ ok: true, json: () => Promise.resolve({ twitterConfigured: false }) }),
          $post: () =>
            Promise.resolve({ ok: true, json: () => Promise.resolve({ twitterConfigured: false }) }),
        },
      },
    },
  },
}))
vi.mock('@/lib/useClaudeConnection', () => ({ useClaudeConnection: () => null }))

import { SettingsPanel } from './SettingsPanel'
import type { Settings } from '@/lib/types'

const baseSettings: Settings = {
  projects: [],
  defaultWorkspace: null,
  projectsRoot: null,
  archiveDirName: '_archive',
  excludePatterns: [],
  displayName: '',
}

const renderPanel = (onSave: (s: Settings) => void, open = true) =>
  render(
    <SettingsPanel
      open={open}
      settings={baseSettings}
      onClose={() => {}}
      onSave={onSave}
    />,
  )

describe('SettingsPanel autosave', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('has no footer Save/Cancel buttons', () => {
    renderPanel(vi.fn())
    expect(screen.queryByText('common.save')).toBeNull()
    expect(screen.queryByText('common.cancel')).toBeNull()
  })

  it('debounces keystrokes into one save with normalized values', () => {
    const onSave = vi.fn()
    renderPanel(onSave)
    // The panel now holds more textboxes (the WordPress section) — name it.
    const input = screen.getByRole('textbox', { name: 'settings.displayName.heading' })
    fireEvent.change(input, { target: { value: 'A' } })
    fireEvent.change(input, { target: { value: 'Al' } })
    fireEvent.change(input, { target: { value: '  Alice  ' } })
    expect(onSave).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0][0]).toMatchObject({ displayName: 'Alice' })
    // The input keeps the raw in-progress value (IME guard: never rewritten).
    expect((input as HTMLInputElement).value).toBe('  Alice  ')
  })

  it('flushes on blur without waiting for the debounce', () => {
    const onSave = vi.fn()
    renderPanel(onSave)
    const input = screen.getByRole('textbox', { name: 'settings.displayName.heading' })
    fireEvent.change(input, { target: { value: 'Bob' } })
    fireEvent.blur(input)
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0][0]).toMatchObject({ displayName: 'Bob' })

    // The pending debounce was cancelled — no second (duplicate) save.
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('flushes a pending edit when the panel closes', () => {
    const onSave = vi.fn()
    const { rerender } = renderPanel(onSave)
    const input = screen.getByRole('textbox', { name: 'settings.displayName.heading' })
    fireEvent.change(input, { target: { value: 'Carol' } })
    expect(onSave).not.toHaveBeenCalled()

    rerender(
      <SettingsPanel open={false} settings={baseSettings} onClose={() => {}} onSave={onSave} />,
    )
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0][0]).toMatchObject({ displayName: 'Carol' })
  })

  it('flushes a pending edit on unmount', () => {
    const onSave = vi.fn()
    const { unmount } = renderPanel(onSave)
    fireEvent.change(screen.getByRole('textbox', { name: 'settings.displayName.heading' }), { target: { value: 'Dave' } })
    unmount()
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0][0]).toMatchObject({ displayName: 'Dave' })
  })

  it('does not save when nothing changed (close with untouched values)', () => {
    const onSave = vi.fn()
    const { rerender } = renderPanel(onSave)
    rerender(
      <SettingsPanel open={false} settings={baseSettings} onClose={() => {}} onSave={onSave} />,
    )
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(onSave).not.toHaveBeenCalled()
  })

  it('normalizes a blank workspace to null at persist time', () => {
    const onSave = vi.fn()
    render(
      <SettingsPanel
        open
        settings={{ ...baseSettings, defaultWorkspace: '/tmp/ws' }}
        onClose={() => {}}
        onSave={onSave}
      />,
    )
    // Workspace lives under the Advanced disclosure.
    fireEvent.click(screen.getByText('settings.advanced'))
    const ws = screen.getByPlaceholderText('/Users/you/projects')
    fireEvent.change(ws, { target: { value: '   ' } })
    fireEvent.blur(ws)
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0][0]).toMatchObject({ defaultWorkspace: null })
  })
})

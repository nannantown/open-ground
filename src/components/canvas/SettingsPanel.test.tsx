// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, screen, act, within } from '@testing-library/react'

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

const renderPanel = (onSave: (s: Partial<Settings>) => void, open = true) =>
  render(
    <SettingsPanel
      open={open}
      settings={baseSettings}
      onClose={() => {}}
      onSave={onSave}
    />,
  )

describe('SettingsPanel autosave', () => {
  it('saves only changed preferences when two switches change before a reload', async () => {
    let saved = { ...baseSettings, autoUpdate: false, soundOnDone: false }
    const onSave = vi.fn(async (patch: Partial<Settings>) => { saved = { ...saved, ...patch } })
    render(<SettingsPanel open settings={saved} onClose={() => {}} onSave={onSave} />)
    const updates = screen.getByRole('group', { name: 'settings.autoUpdate.label' })
    const sound = screen.getByRole('group', { name: 'settings.sound.label' })
    fireEvent.click(within(updates).getByRole('button', { name: 'settings.experiments.on' }))
    fireEvent.click(within(sound).getByRole('button', { name: 'settings.experiments.on' }))
    await act(async () => {})
    expect(saved).toMatchObject({ autoUpdate: true, soundOnDone: true })
    expect(onSave.mock.calls.flatMap(([patch]) => Object.keys(patch))).not.toContain('projects')
  })

  it('keeps a failed preference available for an explicit retry', async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined)
    renderPanel(onSave)
    const updates = screen.getByRole('group', { name: 'settings.autoUpdate.label' })
    await act(async () => {
      fireEvent.click(within(updates).getByRole('button', { name: 'settings.experiments.off' }))
    })
    expect(screen.getByText('settings.save.failed').closest('[role=alert]')).not.toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'settings.save.retry' })) })
    expect(onSave.mock.calls).toEqual([[{ autoUpdate: false }], [{ autoUpdate: false }]])
    expect(screen.queryByText('settings.save.failed')).toBeNull()
  })

  it('retries the newest switch value after an older in-flight write fails', async () => {
    let rejectFirst!: (reason: Error) => void
    const onSave = vi.fn().mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject }))
      .mockResolvedValue(undefined)
    renderPanel(onSave)
    const updates = screen.getByRole('group', { name: 'settings.autoUpdate.label' })
    fireEvent.click(within(updates).getByRole('button', { name: 'settings.experiments.off' }))
    fireEvent.click(within(updates).getByRole('button', { name: 'settings.experiments.on' }))
    await act(async () => { rejectFirst(new Error('offline')) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'settings.save.retry' })) })
    expect(onSave.mock.calls).toEqual([[{ autoUpdate: false }], [{ autoUpdate: true }]])
  })

  it('keeps a failed text edit visible after closing and reopening the panel', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('offline'))
    const view = renderPanel(onSave)
    const name = screen.getByRole('textbox', { name: 'settings.displayName.heading' })
    fireEvent.change(name, { target: { value: 'Retain my edit' } })
    await act(async () => { fireEvent.blur(name) })
    await act(async () => { view.rerender(<SettingsPanel open={false} settings={baseSettings} onClose={() => {}} onSave={onSave} />) })
    await act(async () => { view.rerender(<SettingsPanel open settings={baseSettings} onClose={() => {}} onSave={onSave} />) })
    expect(screen.getByRole('textbox', { name: 'settings.displayName.heading' })).toHaveValue('Retain my edit')
    expect(screen.getByText('settings.save.failed')).toBeInTheDocument()
  })

  it('refreshes sound and update switches from saved settings when reopened', async () => {
    const onSave = vi.fn()
    const view = renderPanel(onSave, false)
    await act(async () => { view.rerender(<SettingsPanel open settings={{ ...baseSettings, autoUpdate: false, soundOnDone: true, soundOnDoneVolume: 35 }} onClose={() => {}} onSave={onSave} />) })
    expect(within(screen.getByRole('group', { name: 'settings.autoUpdate.label' })).getByRole('button', { name: 'settings.experiments.off' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(screen.getByRole('group', { name: 'settings.sound.label' })).getByRole('button', { name: 'settings.experiments.on' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('slider')).toHaveValue('35')
  })

  it('hides owner settings without erasing their values during a public settings edit', () => {
    const wordpress = { baseUrl: 'https://saved.example', username: 'saved', appPassword: 'fixture' }
    const onSave = vi.fn()
    render(<SettingsPanel open settings={{ ...baseSettings, wordpress }} onClose={() => {}} onSave={onSave} />)
    expect(screen.queryByText('settings.wordpress.heading')).toBeNull()
    expect(screen.queryByText('settings.research.heading')).toBeNull()
    const input = screen.getByRole('textbox', { name: 'settings.displayName.heading' })
    fireEvent.change(input, { target: { value: 'Public user' } })
    fireEvent.blur(input)
    expect(onSave.mock.calls[0][0]).toEqual({ displayName: 'Public user' })
  })

  it('keeps the public Swarm opt-in available and saves its value with legacy settings intact', async () => {
    const onSave = vi.fn()
    render(<SettingsPanel open settings={baseSettings} swarmOptInAvailable onClose={() => {}} onSave={onSave} />)
    fireEvent.click(screen.getByText('settings.advanced'))
    const group = screen.getByRole('group', { name: 'settings.swarmOptIn.label' })
    fireEvent.click(within(group).getByRole('button', { name: 'settings.experiments.on' }))
    expect(onSave.mock.calls.at(-1)?.[0].swarmOptIn).toBe(true)
    await act(async () => { fireEvent.click(within(group).getByRole('button', { name: 'settings.experiments.off' })) })
    expect(onSave.mock.calls.at(-1)?.[0].swarmOptIn).toBe(false)
  })

  // ── the worker-directive trial toggle (Settings.workerTrials.thinkInCode) ──
  // It exists because the alternative was telling a non-programmer to POST JSON
  // with curl. Three properties are worth guarding, and the third is the one a
  // careless edit breaks.
  it('is hidden until the swarm is actually on for this user', () => {
    // A switch that changes nothing visible is worse than an absent one.
    render(<SettingsPanel open settings={baseSettings} onClose={() => {}} onSave={vi.fn()} />)
    fireEvent.click(screen.getByText('settings.advanced'))
    expect(screen.queryByText('settings.workerTrial.heading')).toBeNull()
  })

  it('appears and persists once the swarm is on for the owner', async () => {
    const onSave = vi.fn()
    render(
      <SettingsPanel
        open
        settings={{ ...baseSettings, swarmOptIn: true }}
        experimentsEligible
        swarmOptInAvailable
        swarmOptInEnabled
        onClose={() => {}}
        onSave={onSave}
      />,
    )
    fireEvent.click(screen.getByText('settings.advanced'))
    const group = screen.getByRole('group', { name: 'settings.workerTrial.thinkInCode' })
    fireEvent.click(within(group).getByRole('button', { name: 'settings.experiments.on' }))
    expect(onSave.mock.calls.at(-1)?.[0].workerTrials).toEqual({ thinkInCode: true })
    await act(async () => { fireEvent.click(within(group).getByRole('button', { name: 'settings.experiments.off' })) })
    expect(onSave.mock.calls.at(-1)?.[0].workerTrials).toEqual({ thinkInCode: false })
  })

  it('does NOT clear another arm when this one is flipped', () => {
    // `workerTrials` is ONE settings key and the save MERGES by key, so writing
    // a fresh object here would silently turn `brevity` off — a switch quietly
    // undoing a different switch, which no one would look for.
    const onSave = vi.fn()
    render(
      <SettingsPanel
        open
        settings={{ ...baseSettings, swarmOptIn: true, workerTrials: { brevity: true } }}
        experimentsEligible
        swarmOptInAvailable
        swarmOptInEnabled
        onClose={() => {}}
        onSave={onSave}
      />,
    )
    fireEvent.click(screen.getByText('settings.advanced'))
    const group = screen.getByRole('group', { name: 'settings.workerTrial.thinkInCode' })
    fireEvent.click(within(group).getByRole('button', { name: 'settings.experiments.on' }))
    expect(onSave.mock.calls.at(-1)?.[0].workerTrials).toEqual({ brevity: true, thinkInCode: true })
  })

  it('shows the state that is actually stored, not a default', () => {
    render(
      <SettingsPanel
        open
        settings={{ ...baseSettings, swarmOptIn: true, workerTrials: { thinkInCode: true } }}
        experimentsEligible
        swarmOptInAvailable
        swarmOptInEnabled
        onClose={() => {}}
        onSave={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByText('settings.advanced'))
    const group = screen.getByRole('group', { name: 'settings.workerTrial.thinkInCode' })
    expect(within(group).getByRole('button', { name: 'settings.experiments.on' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('still exposes saved WordPress settings to the owner', () => {
    render(<SettingsPanel open experimentsEligible settings={baseSettings} onClose={() => {}} onSave={vi.fn()} />)
    expect(screen.getByText('settings.wordpress.heading')).toBeTruthy()
  })
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

// @vitest-environment jsdom
//
// ExecutionModeMenu — the 使用可能モデル (model hard mask) half of the menu.
//
// Two invariants the server cannot enforce for the user, only refuse:
//   • the LAST enabled tier can't be switched off (an all-OFF mask only parks the
//     swarm; store.setUserSettings drops such a patch, so a UI that let you click
//     it would show a lie until the next re-GET);
//   • the execution-mode hints name the tier each mode ACTUALLY resolves to. With
//     fable switched off, "Max" must not keep advertising Fable — that promise is
//     exactly what the engine will never honor.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { ExecutionModeMenu } from './ExecutionModeToggle'
import { I18nProvider } from '@/i18n/I18nContext'
import type { SwarmAllowedModels } from '@/lib/types'

const settingsBody = (swarmAllowedModels?: Partial<SwarmAllowedModels>) => ({
  executionMode: 'max',
  ...(swarmAllowedModels ? { swarmAllowedModels } : {}),
})

/** Stub /api/settings: GET returns `body`, POST echoes 200 and records only the
 *  MASK patches — I18nProvider persists `language` through the same endpoint on
 *  mount, and that unrelated write must not be mistaken for a toggle's PATCH. */
const stubFetch = (body: unknown, posts: unknown[]) =>
  vi.fn((input: unknown, init?: { method?: string; body?: string }) => {
    if (init?.method === 'POST') {
      const patch: unknown = JSON.parse(init.body ?? '{}')
      if (patch && typeof patch === 'object' && 'swarmAllowedModels' in patch) posts.push(patch)
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) } as Response)
    }
    void input
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response)
  })

/** Render, then open the dropdown (the toggles live inside it). */
const openMenu = async (body: unknown, posts: unknown[] = []) => {
  vi.stubGlobal('fetch', stubFetch(body, posts))
  render(
    <I18nProvider>
      <ExecutionModeMenu />
    </I18nProvider>,
  )
  // The trigger's label is the current mode ('Max' — the stubbed executionMode).
  const trigger = await screen.findByRole('button', { expanded: false })
  fireEvent.click(trigger)
  return await screen.findByRole('menu')
}

const tierRow = (menu: HTMLElement, label: string) =>
  within(menu)
    .getAllByRole('menuitemcheckbox')
    .find((el) => el.textContent?.includes(label))!

const maxHint = (menu: HTMLElement) =>
  within(menu)
    .getAllByRole('menuitemradio')
    .find((el) => el.textContent?.startsWith('Max'))!.textContent ?? ''

describe('ExecutionModeMenu — usable-models hard mask', () => {
  beforeEach(() => vi.unstubAllGlobals())

  it('renders one checkbox per ladder tier, all checked by default', async () => {
    const menu = await openMenu(settingsBody())
    const rows = within(menu).getAllByRole('menuitemcheckbox')
    expect(rows.map((r) => r.textContent)).toEqual(['Fable', 'Opus', 'Sonnet', 'Haiku'])
    expect(rows.every((r) => r.getAttribute('aria-checked') === 'true')).toBe(true)
  })

  it('switching a tier off PATCHes the full mask and unchecks the row', async () => {
    const posts: unknown[] = []
    const menu = await openMenu(settingsBody(), posts)
    fireEvent.click(tierRow(menu, 'Fable'))

    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]).toEqual({
      swarmAllowedModels: { fable: false, opus: true, sonnet: true, haiku: true },
    })
    expect(tierRow(menu, 'Fable').getAttribute('aria-checked')).toBe('false')
  })

  it('the LAST enabled tier cannot be switched off (no all-OFF mask, no PATCH)', async () => {
    const posts: unknown[] = []
    const menu = await openMenu(
      settingsBody({ fable: false, opus: false, sonnet: false, haiku: true }),
      posts,
    )
    const haiku = tierRow(menu, 'Haiku')
    expect(haiku).toBeDisabled()
    expect(haiku.getAttribute('title')).toBe('At least one model must stay on')

    fireEvent.click(haiku)
    expect(posts).toHaveLength(0)
    expect(haiku.getAttribute('aria-checked')).toBe('true')
    // …while a DISABLED tier can always be switched back on (the escape hatch).
    expect(tierRow(menu, 'Fable')).not.toBeDisabled()
  })

  it('a failed PATCH rolls the row back rather than showing a mask that never persisted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: unknown, init?: { method?: string }) =>
        init?.method === 'POST'
          ? Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) } as Response)
          : Promise.resolve({
              ok: true,
              status: 200,
              json: () => Promise.resolve(settingsBody()),
            } as Response),
      ),
    )
    render(
      <I18nProvider>
        <ExecutionModeMenu />
      </I18nProvider>,
    )
    fireEvent.click(await screen.findByRole('button', { expanded: false }))
    const menu = await screen.findByRole('menu')
    fireEvent.click(tierRow(menu, 'Fable'))
    await waitFor(() =>
      expect(tierRow(menu, 'Fable').getAttribute('aria-checked')).toBe('true'),
    )
  })

  it('the mode hints name the tier the mode RESOLVES to — never a switched-off model', async () => {
    const menu = await openMenu(settingsBody())
    expect(maxHint(menu)).toContain('Fable')
  })

  it('with the top tier off, "Max" advertises Opus and never mentions Fable', async () => {
    const menu = await openMenu(settingsBody({ fable: false }))
    const hint = maxHint(menu)
    expect(hint).toContain('Opus')
    expect(hint).not.toContain('Fable')
  })

  it('with fable+opus off, the hints fall all the way to Sonnet', async () => {
    const menu = await openMenu(settingsBody({ fable: false, opus: false }))
    const hint = maxHint(menu)
    expect(hint).toContain('Sonnet')
    expect(hint).not.toContain('Fable')
    expect(hint).not.toContain('Opus')
  })

  it('with sonnet off, the CHEAP slot in the optimize hint drops to Haiku (not up to the top)', async () => {
    const menu = await openMenu(settingsBody({ sonnet: false }))
    const optimize =
      within(menu)
        .getAllByRole('menuitemradio')
        .find((el) => el.textContent?.startsWith('Optimize'))!.textContent ?? ''
    expect(optimize).toContain('Fable') // heavy work still on the top tier
    expect(optimize).toContain('Haiku') // chores step DOWN past the disabled sonnet
    expect(optimize).not.toContain('Sonnet')
  })
})

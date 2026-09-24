// @vitest-environment jsdom
//
// SwarmAllowedModelsSetting — the 使用可能モデル (model hard mask) on the
// Settings screen (moved off the team bar's mode menu, owner 2026-09-24).
//
// The invariant the server cannot enforce for the user, only refuse: the LAST
// enabled tier can't be switched off (an all-OFF mask only parks the team;
// store.setUserSettings drops such a patch, so a UI that let you click it would
// show a lie until the next re-GET).
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { SwarmAllowedModelsSetting } from './SwarmAllowedModelsSetting'
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

/** Render the setting and return its group (the tier checkboxes live in it). */
const openMenu = async (body: unknown, posts: unknown[] = []) => {
  vi.stubGlobal('fetch', stubFetch(body, posts))
  render(
    <I18nProvider>
      <SwarmAllowedModelsSetting />
    </I18nProvider>,
  )
  const group = await screen.findByRole('group')
  // Wait for the GET to land (the defaults are all-on too, so wait on a row).
  await screen.findAllByRole('checkbox')
  await new Promise((r) => setTimeout(r, 0))
  return group
}

const tierRow = (menu: HTMLElement, label: string) =>
  within(menu)
    .getAllByRole('checkbox')
    .find((el) => el.textContent?.includes(label))!

describe('SwarmAllowedModelsSetting — usable-models hard mask', () => {
  beforeEach(() => vi.unstubAllGlobals())

  it('renders one checkbox per ladder tier, all checked by default', async () => {
    const menu = await openMenu(settingsBody())
    const rows = within(menu).getAllByRole('checkbox')
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
        <SwarmAllowedModelsSetting />
      </I18nProvider>,
    )
    const menu = await screen.findByRole('group')
    await new Promise((r) => setTimeout(r, 0))
    fireEvent.click(tierRow(menu, 'Fable'))
    await waitFor(() =>
      expect(tierRow(menu, 'Fable').getAttribute('aria-checked')).toBe('true'),
    )
  })
})

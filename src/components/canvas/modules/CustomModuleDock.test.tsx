// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { StrictMode } from 'react'
import { render, act } from '@testing-library/react'

// StrictMode contract for the custom tab's TerminalDock plumbing
// (docs/CUSTOM_TABS_PLAN.md Goal #3): dev runs every mount effect
// setup → cleanup → setup, so the dock's auto-spawn must single-flight the
// POST (no twin PTYs) and the create flow's brush-up paste must still fire
// EXACTLY once. Plus the delete-flow teardown (killEmbeddedTerminals): kill
// every PTY bound under the module's storage identity and drop the dock
// state, which no later sweep could reach once the module is gone. The
// xterm-bearing pane is irrelevant here — mocked.

vi.mock('@/i18n/I18nContext', () => ({ useT: () => ({ t: (k: string) => k }) }))
vi.mock('@/components/canvas/ClaudeTerminalPane', () => ({
  ClaudeTerminalPane: () => null,
}))

import { CustomModuleView, customModuleStorageId } from './CustomModuleView'
import { killEmbeddedTerminals } from '@/components/canvas/EmbeddedClaudeTerminal'
import type { CustomModuleDef } from '@/lib/types'

const MODULE_ID = 'aaaaaaaa-0000-4000-8000-000000000001'
const MODULE: CustomModuleDef = {
  id: MODULE_ID,
  label: 'Workout',
  description: 'demo',
  framework: 'react',
  origin: 'local',
  createdAt: '2026-06-12T00:00:00.000Z',
  updatedAt: '2026-06-12T00:00:00.000Z',
}
// Mirrors PASTE_AFTER_LAUNCH_MS in CustomModuleView.tsx (the paste is delayed
// after a fresh spawn so claude's line editor is up before the bytes land).
const PASTE_DELAY_MS = 1500

interface Call {
  url: string
  method: string
}
let calls: Call[] = []

// Microtask-deterministic fetch fake: a real Response body read can hop
// through macrotasks, which fake timers would stall on.
const jsonRes = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

beforeEach(() => {
  calls = []
  localStorage.clear()
  vi.useFakeTimers()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push({ url, method })
      if (url === `/api/custom-modules/${MODULE_ID}/source`) {
        return jsonRes({ source: 'export default function T(){return null}', mtimeMs: 1 })
      }
      if (url === '/api/terminal/custom-module' && method === 'POST') {
        return jsonRes({ id: 'pty-9' })
      }
      if (url === '/api/terminal/pty-9/paste-custom-module' && method === 'POST') {
        return jsonRes({ ok: true })
      }
      if (method === 'DELETE') return jsonRes({ ok: true })
      return jsonRes({ error: 'not found' }, 404)
    }),
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const spawns = () =>
  calls.filter(c => c.url === '/api/terminal/custom-module' && c.method === 'POST')
const pastes = () =>
  calls.filter(c => c.url.endsWith('/paste-custom-module') && c.method === 'POST')

describe('custom tab TerminalDock (StrictMode)', () => {
  it('create flow: dock opens, ONE spawn, ONE delayed unsent paste', async () => {
    await act(async () => {
      render(
        <StrictMode>
          <CustomModuleView
            module={MODULE}
            role="owner"
            setup
            onChanged={() => {}}
          />
        </StrictMode>,
      )
    })
    // Doubled mount effects must have joined a single in-flight spawn.
    expect(spawns()).toHaveLength(1)
    expect(pastes()).toHaveLength(0)
    // The brush-up paste lands once, after the post-spawn grace.
    await act(async () => {
      vi.advanceTimersByTime(PASTE_DELAY_MS)
    })
    expect(pastes()).toHaveLength(1)
    // …and never again.
    await act(async () => {
      vi.advanceTimersByTime(PASTE_DELAY_MS * 2)
    })
    expect(pastes()).toHaveLength(1)
    // The PTY binding landed under the module's storage identity.
    const stored = Object.keys(localStorage).filter(k =>
      k.startsWith(`openground.embterm.${customModuleStorageId(MODULE_ID)}:`),
    )
    expect(stored).toHaveLength(1)
  })

  it('plain open (no setup): dock stays collapsed — no spawn, no paste', async () => {
    await act(async () => {
      render(
        <StrictMode>
          <CustomModuleView module={MODULE} role="owner" onChanged={() => {}} />
        </StrictMode>,
      )
    })
    await act(async () => {
      vi.advanceTimersByTime(PASTE_DELAY_MS * 2)
    })
    expect(spawns()).toHaveLength(0)
    expect(pastes()).toHaveLength(0)
  })

  it('non-owner: no dock at all', async () => {
    await act(async () => {
      render(
        <StrictMode>
          <CustomModuleView module={MODULE} role="tester" setup onChanged={() => {}} />
        </StrictMode>,
      )
    })
    await act(async () => {
      vi.advanceTimersByTime(PASTE_DELAY_MS * 2)
    })
    expect(spawns()).toHaveLength(0)
  })
})

describe('killEmbeddedTerminals', () => {
  it('kills every bound PTY under the storage id and drops the dock state', () => {
    const sid = customModuleStorageId(MODULE_ID)
    localStorage.setItem(`openground.embterm.${sid}:custom:1`, 'pty-a')
    localStorage.setItem(`openground.embterm.${sid}:custom:2`, 'pty-b')
    localStorage.setItem(
      `openground.dockterm.${sid}:custom`,
      JSON.stringify({ open: true, tabs: ['1', '2'], activeId: '2' }),
    )
    // An unrelated binding must survive.
    localStorage.setItem('openground.embterm.other:custom:1', 'pty-z')

    killEmbeddedTerminals(sid)

    const deletes = calls.filter(c => c.method === 'DELETE').map(c => c.url).sort()
    expect(deletes).toEqual(['/api/terminal/pty-a', '/api/terminal/pty-b'])
    expect(
      Object.keys(localStorage).filter(k => k.includes(sid)),
    ).toHaveLength(0)
    expect(localStorage.getItem('openground.embterm.other:custom:1')).toBe('pty-z')
  })
})

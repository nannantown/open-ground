// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { StrictMode } from 'react'
import { render, act, screen } from '@testing-library/react'

// Retired side docks must neither render nor revive saved sessions.

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
// Cover the retired delayed paste as well as the remaining source poll.
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

describe('custom tabs without side terminals', () => {
  it.each(['owner', 'tester', 'none'] as const)('does not render or launch a dock for %s, even with saved open state', async role => {
    const key = `openground.dockterm.${customModuleStorageId(MODULE_ID)}:custom`
    const saved = JSON.stringify({ open: true, tabs: ['1'], activeId: '1' })
    localStorage.setItem(key, saved)
    await act(async () => {
      // Old create-flow props deliberately exercise the retired entry point.
      render(
        <StrictMode>
          <CustomModuleView module={MODULE} projectPath="/tmp/proj" {...{ role, setup: true }} />
        </StrictMode>,
      )
    })
    await act(async () => { vi.advanceTimersByTime(PASTE_DELAY_MS * 3) })
    expect(screen.queryByTitle('projectPanel.dockOpen')).toBeNull()
    expect(screen.queryByTitle('projectPanel.dockClose')).toBeNull()
    expect(spawns()).toHaveLength(0)
    expect(pastes()).toHaveLength(0)
    expect(calls.filter(c => c.method === 'DELETE')).toHaveLength(0)
    expect(localStorage.getItem(key)).toBe(saved)
    expect(calls.some(c => c.url.endsWith('/source'))).toBe(true)
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

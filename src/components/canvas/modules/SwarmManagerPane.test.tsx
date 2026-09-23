// @vitest-environment jsdom
//
// The manager's (司令官) seat: status + ONE quiet start/stop, nothing else
// (owner decision 2026-09-23 — the owner talks only to the president).

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { messages } from '@/i18n/messages'
import { SwarmManagerPane, commanderSeatState } from './SwarmManagerPane'

// Key-echo `t` that also records a key missing from EITHER real dictionary, so
// a label that exists only in this file cannot pass unnoticed.
const missingKeys = new Set<string>()
const noteKey = (k: string) => {
  if (!(k in messages.en) || !(k in messages.ja)) missingKeys.add(k)
  return k
}

vi.mock('@/i18n/I18nContext', () => ({
  useT: () => ({
    t: (k: string) => noteKey(k),
    lang: 'en',
    setLang: () => {},
    toggleLang: () => {},
  }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}))

afterEach(() => cleanup())

const mount = (status: Parameters<typeof SwarmManagerPane>[0]['status'], busy = false) => {
  const calls = { launch: 0, stop: 0, restart: 0 }
  const view = render(
    <SwarmManagerPane
      status={status}
      busy={busy}
      onLaunch={() => calls.launch++}
      onStop={() => calls.stop++}
      onRestart={() => calls.restart++}
    />,
  )
  return { ...view, calls }
}

describe('commanderSeatState', () => {
  it('is three words: no desk / a closed desk / anything live', () => {
    expect(commanderSeatState(null)).toBe('absent')
    expect(commanderSeatState('exited')).toBe('stopped')
    expect(commanderSeatState('working')).toBe('running')
    expect(commanderSeatState('waiting')).toBe('running')
    expect(commanderSeatState('starting')).toBe('running')
  })
})

describe("the manager's seat", () => {
  it('with no desk: says "not there" and its one button launches', () => {
    const { getByText, getAllByRole, calls } = mount(null)
    getByText('projectPanel.swarm.manager.stateAbsent')
    const buttons = getAllByRole('button')
    expect(buttons).toHaveLength(1)
    fireEvent.click(buttons[0])
    expect(calls).toEqual({ launch: 1, stop: 0, restart: 0 })
  })

  it('with a live desk: says "running" and its one button stops', () => {
    const { getByText, getAllByRole, calls } = mount('working')
    getByText('projectPanel.swarm.manager.stateRunning')
    fireEvent.click(getAllByRole('button')[0])
    expect(calls).toEqual({ launch: 0, stop: 1, restart: 0 })
  })

  it('with a closed desk: says "stopped" and its one button restarts', () => {
    const { getByText, getAllByRole, calls } = mount('exited')
    getByText('projectPanel.swarm.manager.stateStopped')
    fireEvent.click(getAllByRole('button')[0])
    expect(calls).toEqual({ launch: 0, stop: 0, restart: 1 })
  })

  it('carries no conversation, no command box and no dashboard', () => {
    const { container } = mount('working')
    expect(container.querySelector('textarea, input, aside, svg[role="img"]')).toBeNull()
  })

  it('is disabled while a start / stop is in flight', () => {
    const { getAllByRole, calls } = mount('working', true)
    const b = getAllByRole('button')[0] as HTMLButtonElement
    expect(b.disabled).toBe(true)
    fireEvent.click(b)
    expect(calls.stop).toBe(0)
  })

  it('renders only labels that exist in BOTH locales', () => {
    for (const s of [null, 'working', 'exited'] as const) {
      mount(s)
      cleanup()
    }
    expect(Array.from(missingKeys)).toEqual([])
  })
})

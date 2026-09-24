// @vitest-environment jsdom
//
// The manager's (司令官) seat: status + ONE quiet start/stop (owner decision
// 2026-09-23 — the owner talks only to the president), and since 2026-09-24 the
// desk's polled conversation plus a folded, hard-to-misfire send-a-word box.

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

const mount = (
  status: Parameters<typeof SwarmManagerPane>[0]['status'],
  busy = false,
  sdkSessionId?: string,
) => {
  const calls = { launch: 0, stop: 0, restart: 0 }
  const view = render(
    <SwarmManagerPane
      status={status}
      busy={busy}
      onLaunch={() => calls.launch++}
      onStop={() => calls.stop++}
      onRestart={() => calls.restart++}
      sdkSessionId={sdkSessionId}
      projectPath="/p"
    />,
  )
  return { ...view, calls }
}

/** Record every request; answer the tail with one said line, the relay with `say`. */
const stubFetch = (say: Record<string, unknown> = { delivered: true, runtime: 'sdk' }) => {
  const reqs: { url: string; body?: string }[] = []
  vi.stubGlobal('fetch', (input: string, init?: RequestInit) => {
    reqs.push({ url: input, body: init?.body as string | undefined })
    const body = input.includes('/tail?')
      ? { frames: [{ seq: 1, ev: { kind: 'text', text: 'merging swarm/x now' } }], seq: 1, reaped: false }
      : say
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
  })
  return reqs
}
afterEach(() => vi.unstubAllGlobals())

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
  it('with no desk: says "not there", its start button launches, the send box stays folded', () => {
    const { getByText, getAllByRole, calls } = mount(null)
    getByText('projectPanel.swarm.manager.stateAbsent')
    const buttons = getAllByRole('button')
    expect(buttons.map((b) => b.textContent)).toEqual([
      'projectPanel.swarm.manager.start',
      'projectPanel.swarm.say.open',
    ])
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

  it('a PTY (id-less) desk shows the hint, no feed and no open input', () => {
    const { container, getByText } = mount('working')
    getByText('projectPanel.swarm.manager.conversationHint')
    expect(container.querySelector('[data-seat-feed]')).toBeNull()
    expect(container.querySelector('textarea, input, aside, svg[role="img"]')).toBeNull()
  })

  it("an SDK desk shows what it said, polled from its tail — the owner reads the manager's words", async () => {
    const reqs = stubFetch()
    const { findByText } = mount('working', false, 'mgr-1')
    await findByText('merging swarm/x now')
    expect(reqs[0].url).toBe('/api/sdk-session/mgr-1/tail?path=%2Fp&after=0&limit=80')
  })

  it('sends a word only on purpose: plain Enter does not send, ⌘+Enter goes to manager/say', async () => {
    const reqs = stubFetch({ delivered: true, runtime: 'sdk', woke: true })
    const { getByText, container, findByText } = mount(null)
    fireEvent.click(getByText('projectPanel.swarm.say.open'))
    const box = container.querySelector('textarea')!
    fireEvent.change(box, { target: { value: '状況を教えて' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(reqs.filter((r) => r.url.includes('manager/say'))).toHaveLength(0)
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true })
    await findByText('projectPanel.swarm.say.woke')
    const say = reqs.filter((r) => r.url === '/api/swarm/manager/say')
    expect(say).toHaveLength(1)
    expect(JSON.parse(say[0].body!)).toEqual({ path: '/p', text: '状況を教えて' })
    // Delivered ⇒ folded again.
    expect(container.querySelector('textarea')).toBeNull()
  })

  it('a held (undelivered) word keeps the text and says so', async () => {
    stubFetch({ delivered: false, runtime: 'pty', heldBecause: 'generating' })
    const { getByText, container, findByText } = mount('working')
    fireEvent.click(getByText('projectPanel.swarm.say.open'))
    const box = container.querySelector('textarea')!
    fireEvent.change(box, { target: { value: 'merge it' } })
    fireEvent.click(getByText('projectPanel.swarm.say.send'))
    await findByText('projectPanel.swarm.say.held')
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('merge it')
  })

  it('a word the desk REFUSED (closed under us) is not called "busy, try later"', async () => {
    stubFetch({ delivered: false, runtime: 'sdk' })
    const { getByText, container, findByText } = mount('working')
    fireEvent.click(getByText('projectPanel.swarm.say.open'))
    fireEvent.change(container.querySelector('textarea')!, { target: { value: 'merge it' } })
    fireEvent.click(getByText('projectPanel.swarm.say.send'))
    await findByText('projectPanel.swarm.say.failed')
    expect(container.textContent).not.toContain('projectPanel.swarm.say.held')
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

// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'

// DOM-level guard for the needs-attention feed. The pure derivation
// (swarmOverseerFeed.test.ts) proves the FILTER is right; this file proves the
// PANE IS WIRED TO IT — the gap an adversarial pass measured on 2026-08-04, when
// all 17 pure tests stayed green with the dismissal set no longer reaching the
// component at all. What is asserted here is what the owner can see: a row is in
// the document, or it is not.
//
// The escalation inbox child polls its own owner-gated endpoint, so it is
// stubbed out — this file is about the alert list, not the inbox.
vi.mock('@/i18n/I18nContext', () => ({ useT: () => ({ t: (k: string) => k }) }))
// The stub reports a SUCCESSFUL read, like the real inbox does once its poll
// answers — otherwise every case below would render the "cannot read the inbox"
// state instead of the quiet one.
vi.mock('./SwarmEscalationsPane', () => ({
  SwarmEscalationsPane: ({ onLoadedChange }: { onLoadedChange?: (v: boolean) => void }) => {
    onLoadedChange?.(true)
    return null
  },
}))

import { SwarmOverseerPane } from './SwarmOverseerPane'
import { DEFAULT_ENGINE, type SwarmFatalView } from './useSwarmEngine'

const fatal = (over: Partial<SwarmFatalView> & { id: string }): SwarmFatalView => ({
  event: 'all-workers-down',
  detail: `detail ${over.id}`,
  createdAt: Date.parse('2026-08-04T00:00:00.000Z'),
  branch: `swarm/${over.id}`,
  ...over,
})

const renderPane = (props: {
  fatalNotifications: SwarmFatalView[]
  handledFatalIds?: ReadonlySet<string>
  onMarkFatalHandled?: (id: string) => void
}) =>
  render(
    <SwarmOverseerPane
      projectPath="/proj"
      engine={DEFAULT_ENGINE}
      fatalNotifications={props.fatalNotifications}
      handledFatalIds={props.handledFatalIds ?? new Set()}
      onMarkFatalHandled={props.onMarkFatalHandled ?? (() => {})}
      openCount={0}
      onOpenCountChange={() => {}}
    />,
  )

describe('SwarmOverseerPane — what the owner actually sees in the alert list', () => {
  it('draws a row per un-dismissed fatal, and the quiet state when there are none', () => {
    const withNone = renderPane({ fatalNotifications: [] })
    // The quiet state is a real claim ("nothing needs you"), so pin that it is
    // reachable at all — it was NOT, for the life of an install, before the
    // dismissal existed.
    expect(withNone.container.textContent).toContain('projectPanel.swarm.overseer.emptyTitle')
    withNone.unmount()

    const withOne = renderPane({ fatalNotifications: [fatal({ id: 'n1' })] })
    expect(withOne.container.textContent).toContain('detail n1')
    expect(withOne.container.textContent).not.toContain('projectPanel.swarm.overseer.emptyTitle')
  })

  it('a dismissed row is ABSENT FROM THE DOM (the session set reaches the pane)', () => {
    const { container } = renderPane({
      fatalNotifications: [fatal({ id: 'n1' }), fatal({ id: 'n2' })],
      handledFatalIds: new Set(['n1']),
    })
    expect(container.textContent).not.toContain('detail n1')
    expect(container.textContent).toContain('detail n2')
  })

  it('a row the SERVER marked handled is absent too, with an empty session set', () => {
    const { container } = renderPane({
      fatalNotifications: [fatal({ id: 'n1', handled: true }), fatal({ id: 'n2' })],
      handledFatalIds: new Set(),
    })
    expect(container.textContent).not.toContain('detail n1')
    expect(container.textContent).toContain('detail n2')
  })

  it('dismissing every row reaches the quiet state — the feed CAN go quiet', () => {
    const { container } = renderPane({
      fatalNotifications: [fatal({ id: 'n1' }), fatal({ id: 'n2', handled: true })],
      handledFatalIds: new Set(['n1']),
    })
    expect(container.textContent).toContain('projectPanel.swarm.overseer.emptyTitle')
  })

  it('the 対応済み button reports the row id (the click is wired to the right row)', () => {
    const seen: string[] = []
    const { container } = renderPane({
      fatalNotifications: [fatal({ id: 'n1' }), fatal({ id: 'n2' })],
      onMarkFatalHandled: (id) => seen.push(id),
    })
    const buttons = container.querySelectorAll('button')
    expect(buttons).toHaveLength(2) // one per alert row
    ;(buttons[1] as HTMLButtonElement).click()
    expect(seen).toEqual(['n2'])
  })

  it('says it CANNOT READ the inbox rather than "nothing needs you"', async () => {
    // The inbox swallows a failed read (a 403 from a degraded owner-role lookup,
    // a network fault), leaving its list empty — which used to render as the
    // reassuring shield. An assurance built from no information is the worst
    // kind on an unattended system.
    vi.resetModules()
    vi.doMock('./SwarmEscalationsPane', () => ({ SwarmEscalationsPane: () => null }))
    const { SwarmOverseerPane: Pane } = await import('./SwarmOverseerPane')
    const { container } = render(
      <Pane
        projectPath="/proj"
        engine={DEFAULT_ENGINE}
        fatalNotifications={[]}
        handledFatalIds={new Set()}
        onMarkFatalHandled={() => {}}
        openCount={0}
        onOpenCountChange={() => {}}
      />,
    )
    expect(container.textContent).toContain('projectPanel.swarm.overseer.inboxUnknownTitle')
    expect(container.textContent).not.toContain('projectPanel.swarm.overseer.emptyTitle')
    vi.doUnmock('./SwarmEscalationsPane')
  })

  it('an event with no label still renders — with its raw name', () => {
    // The four events this client used to discard included guard-unwired, which
    // means no worker can start at all. An unfamiliar row is a question the
    // owner can ask; a missing row is a failure they never learn about.
    const { container } = renderPane({
      fatalNotifications: [fatal({ id: 'n1', event: 'a-brand-new-server-event' })],
    })
    expect(container.textContent).toContain('a-brand-new-server-event')
  })
})

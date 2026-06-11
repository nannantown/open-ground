// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import type { ProjectData, ProjectMeta, ProjectTask } from '@/lib/types'

// Layered Escape contract for the Board detail drawer (BoardModule):
//   1. Esc with an xterm-owned element focused → NOTHING (Esc is claude's
//      interrupt key; never blur the terminal, never close anything)
//   2. Esc in a drawer field → revert to saved value + blur; drawer stays
//      open; the event never reaches a window BUBBLE listener (App.tsx's
//      Escape would bounce the user to Ground)
//   3. Esc in the assignee add-input → ITS OWN handler wins (cancel the add,
//      input unmounts, drawer stays open)
//   4. Esc with nothing focused → drawer closes; App's bubble listener
//      suppressed (capture-phase hop)
//   5. Esc with an overlay open ([data-esc-overlay]) → the drawer yields
//   6. Esc mid-IME composition → nothing
// Events are dispatched FROM the focused element with bubbles:true (real
// keyboard semantics), so the capture-vs-bubble ordering is actually pinned —
// a stand-in "App" bubble listener on window asserts suppression.

vi.mock('@/i18n/I18nContext', () => ({ useT: () => ({ t: (k: string) => k }) }))
vi.mock('@/lib/api-client', () => ({
  api: { api: { settings: { $get: () => Promise.resolve({ json: () => Promise.resolve({}) }) } } },
}))

import { BoardModule } from './BoardModule'

const task: ProjectTask = {
  id: 't1',
  title: 'Saved title',
  done: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  boardColumn: 'todo',
}

const data: ProjectData = {
  description: '',
  tasks: [task],
  notes: '',
  updatedAt: '',
} as ProjectData

const project = { id: 'p1', name: 'proj', path: '/tmp/proj' } as ProjectMeta

// session: true renders the drawer in Session mode (terminal slot exists →
// the conversation pane mounts); default Draft mode shows the full fields.
const renderDrawer = (opts: { session?: boolean } = {}) => {
  const onOpenDetail = vi.fn()
  const persist = vi.fn()
  const utils = render(
    <BoardModule
      data={data}
      project={project}
      persist={persist}
      detailId="t1"
      onOpenDetail={onOpenDetail}
      renderConversation={() => (
        <div className="xterm">
          <textarea data-testid="xterm-helper" />
        </div>
      )}
      hasTerminalSlot={() => opts.session ?? false}
      liveTerminalId={() => null}
      onDeleteTask={vi.fn()}
      onLaunchTask={vi.fn()}
    />,
  )
  return { ...utils, onOpenDetail, persist }
}

/** Dispatch Escape FROM `from` (bubbles like a real key press) with a
 *  stand-in App listener on window-bubble. Returns whether App saw it. */
const pressEscape = (from: Element | Window): { appSawIt: boolean } => {
  const app = vi.fn()
  window.addEventListener('keydown', app) // bubble, like App.tsx's handler
  // fireEvent = a real bubbling native event, wrapped in act() so React state
  // updates (e.g. the assignee input unmounting) flush before we assert.
  fireEvent.keyDown(from, { key: 'Escape' })
  window.removeEventListener('keydown', app)
  return { appSawIt: app.mock.calls.length > 0 }
}

beforeEach(() => localStorage.clear())
afterEach(cleanup)

describe('BoardModule drawer — layered Escape', () => {
  it('1. ignores Esc while an xterm element is focused (no close, no blur, App still sees it)', () => {
    // Session mode — the conversation pane (and its xterm) only mounts once
    // the task has a terminal slot.
    const { getByTestId, onOpenDetail } = renderDrawer({ session: true })
    const helper = getByTestId('xterm-helper')
    helper.focus()

    const { appSawIt } = pressEscape(helper)
    expect(document.activeElement).toBe(helper)
    expect(onOpenDetail).not.toHaveBeenCalled()
    expect(appSawIt).toBe(true) // we never touched the event
  })

  it('2. reverts + blurs a drawer field, drawer stays open, App suppressed', () => {
    const { container, onOpenDetail, persist } = renderDrawer()
    const title = container.querySelector<HTMLInputElement>(
      'input[placeholder="board.detail.titlePlaceholder"]',
    )
    expect(title).toBeTruthy()
    if (!title) return
    title.focus()
    title.value = 'half-typed junk'

    const { appSawIt } = pressEscape(title)
    expect(title.value).toBe('Saved title')
    expect(document.activeElement).not.toBe(title)
    expect(onOpenDetail).not.toHaveBeenCalled()
    expect(persist).not.toHaveBeenCalled()
    expect(appSawIt).toBe(false) // aside onKeyDown stopPropagation
  })

  it("3. assignee add-input keeps its OWN Escape (cancel add, input unmounts, drawer open)", () => {
    const { container, getByPlaceholderText, getByText, onOpenDetail } = renderDrawer()
    fireEvent.click(getByText('board.detail.assigneeAdd'))
    const input = getByPlaceholderText('board.detail.assigneeAddPlaceholder') as HTMLInputElement
    input.focus()
    input.value = 'Kok' // half-typed name

    const { appSawIt } = pressEscape(input)
    // The input's element-level handler ran: add cancelled → input unmounted.
    expect(
      container.querySelector('input[placeholder="board.detail.assigneeAddPlaceholder"]'),
    ).toBeNull()
    expect(onOpenDetail).not.toHaveBeenCalled() // drawer untouched
    expect(appSawIt).toBe(false)
  })

  it('4. closes the drawer when nothing is focused; App suppressed (panel stays open)', () => {
    const { onOpenDetail } = renderDrawer()
    ;(document.activeElement as HTMLElement | null)?.blur?.()

    const { appSawIt } = pressEscape(document.body)
    expect(onOpenDetail).toHaveBeenCalledWith(null)
    expect(appSawIt).toBe(false)
  })

  it('5. yields to an open overlay — drawer does NOT close under a modal', () => {
    const { onOpenDetail } = renderDrawer()
    const overlay = document.createElement('div')
    overlay.setAttribute('data-esc-overlay', '')
    document.body.appendChild(overlay)
    try {
      ;(document.activeElement as HTMLElement | null)?.blur?.()
      const { appSawIt } = pressEscape(document.body)
      expect(onOpenDetail).not.toHaveBeenCalled()
      expect(appSawIt).toBe(true) // untouched — the overlay's own handler owns it
    } finally {
      overlay.remove()
    }
  })

  it('6. does nothing mid-IME composition', () => {
    const { onOpenDetail } = renderDrawer()
    fireEvent.keyDown(document.body, { key: 'Escape', isComposing: true })
    expect(onOpenDetail).not.toHaveBeenCalled()
  })
})

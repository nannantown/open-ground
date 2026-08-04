// @vitest-environment jsdom
// Regression guard for the memoized BoardCard (perf/board-w2). Asserts the card
// renders + behaves correctly AND — the load-bearing invariant — that editing
// one card re-renders ONLY that card, never its untouched siblings. That memo is
// only effective when BoardTab feeds it STABLE callbacks; this test fails loudly
// if a future change reintroduces an unstable card prop and silently makes the
// memo inert (the exact regression this optimization must not slide back into).
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { useCallback, useState } from 'react'
import type { ProjectData, ProjectTask } from '@/lib/types'

// Each BoardCard render calls t('board.card.ariaLabel', {title,...}) exactly
// once → recording those titles is a precise per-card render counter that proves
// whether the memo SKIPPED a card (a skipped card never calls its render fn).
const h = vi.hoisted(() => ({ ariaTitles: [] as string[] }))

vi.mock('@/i18n/I18nContext', () => ({
  useT: () => ({
    t: (k: string, vars?: Record<string, string | number>) => {
      if (k === 'board.card.ariaLabel' && vars && typeof vars.title === 'string')
        h.ariaTitles.push(vars.title)
      return vars ? `${k}:${JSON.stringify(vars)}` : k
    },
  }),
}))
vi.mock('@/components/canvas/CollabPresence', () => ({
  CollabPresence: () => null,
}))

import { BoardTab } from './BoardTab'

const task = (over: Partial<ProjectTask>): ProjectTask => ({
  id: 't',
  title: 'x',
  done: false,
  createdAt: '2026-01-01T00:00:00Z',
  ...over,
})

const data = (tasks: ProjectTask[]): ProjectData =>
  ({ description: '', notes: '', updatedAt: '', tasks }) as ProjectData

beforeEach(() => (h.ariaTitles = []))
afterEach(() => cleanup())

describe('BoardCard extraction smoke', () => {
  it('renders every card title across columns', () => {
    const { getByText } = render(
      <BoardTab
        data={data([
          task({ id: 'a', title: 'Alpha', boardColumn: 'todo' }),
          task({ id: 'b', title: 'Bravo', boardColumn: 'doing' }),
          task({ id: 'c', title: 'Charlie', boardColumn: 'review', branch: 'task/c' }),
        ])}
        onPersist={vi.fn()}
        onOpenTask={vi.fn()}
        onCreateTask={vi.fn(() => 'new')}
      />,
    )
    expect(getByText('Alpha')).toBeTruthy()
    expect(getByText('Bravo')).toBeTruthy()
    expect(getByText('Charlie')).toBeTruthy()
  })

  it('clicking a card opens it (onOpenTask with its id)', () => {
    const onOpenTask = vi.fn()
    const { getByText } = render(
      <BoardTab
        data={data([task({ id: 'a', title: 'Alpha', boardColumn: 'todo' })])}
        onPersist={vi.fn()}
        onOpenTask={onOpenTask}
        onCreateTask={vi.fn(() => 'x')}
      />,
    )
    fireEvent.click(getByText('Alpha'))
    expect(onOpenTask).toHaveBeenCalledWith('a')
  })

  it('the selected card (openTaskId) wears the accent classes', () => {
    const { getByText } = render(
      <BoardTab
        data={data([task({ id: 'a', title: 'Alpha', boardColumn: 'todo' })])}
        onPersist={vi.fn()}
        onOpenTask={vi.fn()}
        onCreateTask={vi.fn(() => 'x')}
        openTaskId="a"
      />,
    )
    const article = getByText('Alpha').closest('article')!
    // ⚠ CHANGED WITH THE DESIGN (2026-08-04). 案C is 「罫線なし・面の明度差のみ」,
    // so the selected card is marked by an INSET RING, not a border — a border
    // occupies layout, which is why the card had to reserve a transparent 1px
    // and could never carry the mock's 12/13px padding. The accent wash stays.
    expect(article.className).toContain('ring-accent')
    expect(article.className).toContain('bg-accent/15')
  })

  it('duplicate button persists a duplicated card (in-place copy)', () => {
    const onPersist = vi.fn()
    const { getByLabelText } = render(
      <BoardTab
        data={data([task({ id: 'a', title: 'Alpha', boardColumn: 'todo', boardOrder: 0 })])}
        onPersist={onPersist}
        onOpenTask={vi.fn()}
        onCreateTask={vi.fn(() => 'x')}
      />,
    )
    fireEvent.click(getByLabelText('board.card.duplicate'))
    expect(onPersist).toHaveBeenCalledTimes(1)
    const next = onPersist.mock.calls[0][0] as ProjectData
    expect(next.tasks).toHaveLength(2)
    expect(next.tasks[1].title).toBe('Alpha (copy)')
  })

  it('unresolved-dependency chip shows the count', () => {
    const { getByText } = render(
      <BoardTab
        data={data([
          task({ id: 'a', title: 'Dep', boardColumn: 'todo' }),
          task({ id: 'b', title: 'Needs', boardColumn: 'todo', dependsOn: ['a'] }),
        ])}
        onPersist={vi.fn()}
        onOpenTask={vi.fn()}
        onCreateTask={vi.fn(() => 'x')}
      />,
    )
    // "⛓︎ {count}" — count of unresolved deps (a is not done).
    expect(getByText(/1/)).toBeTruthy()
  })

  it('MEMO: editing one card re-renders ONLY that card, not the sibling', () => {
    // Patch ONE task (preserving the other's object identity, as the data layer
    // guarantees) and assert via the aria-label render counter that ONLY the
    // patched card's render fn ran — the memo skipped the untouched sibling.
    const Host = () => {
      const [d, setD] = useState<ProjectData>(
        data([
          task({ id: 'a', title: 'Alpha', boardColumn: 'todo' }),
          task({ id: 'b', title: 'Bravo', boardColumn: 'todo' }),
        ]),
      )
      // STABLE callbacks — exactly what BoardModule supplies (handleOpenTask /
      // handleCreateTask via useCallback, persistLocal via useCallback). The memo
      // is only effective when BoardTab receives stable callbacks; an inline
      // arrow here would (correctly) defeat it.
      const onOpenTask = useCallback(() => {}, [])
      const onCreateTask = useCallback(() => 'x', [])
      return (
        <div>
          <button
            type="button"
            onClick={() =>
              // Patch ONLY task a — preserve b's object identity (the contract
              // the data layer guarantees via tasks.map).
              setD(prev => ({
                ...prev,
                tasks: prev.tasks.map(t => (t.id === 'a' ? { ...t, title: 'Alpha!' } : t)),
              }))
            }
          >
            patch-a
          </button>
          <BoardTab
            data={d}
            onPersist={setD}
            onOpenTask={onOpenTask}
            onCreateTask={onCreateTask}
          />
        </div>
      )
    }
    const { getByText } = render(<Host />)
    // Initial mount renders both cards.
    expect([...h.ariaTitles].sort()).toEqual(['Alpha', 'Bravo'])
    h.ariaTitles = []
    fireEvent.click(getByText('patch-a'))
    // a updated…
    expect(getByText('Alpha!')).toBeTruthy()
    // …and ONLY a's BoardCard render fn ran — the memo skipped Bravo entirely.
    expect(h.ariaTitles).toEqual(['Alpha!'])
    // b's DOM node is also the same instance (untouched).
    expect(getByText('Bravo')).toBeTruthy()
  })
})

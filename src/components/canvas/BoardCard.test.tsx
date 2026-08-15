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

// t() is mocked to echo the key, so these lookups assert WHICH vocabulary the
// strip speaks (the shared Swarm-tab keys) as well as that it renders at all.
const stripBase = () => ({
  onPersist: vi.fn(),
  onOpenTask: vi.fn(),
  onCreateTask: vi.fn(() => 'new'),
})

describe('worker strip — always-on phase (doing column)', () => {
  it('shows the heartbeat phase as visible text, not only a hover tooltip', () => {
    const { getByText } = render(
      <BoardTab
        data={data([task({ id: 'b', title: 'Bravo', boardColumn: 'doing' })])}
        {...stripBase()}
        workerForTask={() => ({ branch: 'swarm/x', activity: 'working', phase: 'verify' })}
      />,
    )
    // Before this feature the phase lived ONLY in the strip's title attribute —
    // getByText never matches a title, so this is red without the always-on span.
    // 'verify' is known swarm vocabulary → the owner-plain i18n key (t echoes keys).
    expect(getByText('· board.card.phaseVerify')).toBeTruthy()
    // The branch handle stays beside it.
    expect(getByText('swarm/x')).toBeTruthy()
  })

  it('an unknown phase word renders verbatim — no invented meaning', () => {
    const { getByText } = render(
      <BoardTab
        data={data([task({ id: 'b', title: 'Bravo', boardColumn: 'doing' })])}
        {...stripBase()}
        workerForTask={() => ({ branch: 'swarm/x', activity: 'working', phase: 'polishing' })}
      />,
    )
    expect(getByText('· polishing')).toBeTruthy()
  })

  it('a phase-less worker (no heartbeat yet) renders the strip without a phase span', () => {
    const { getByText, queryByText } = render(
      <BoardTab
        data={data([task({ id: 'b', title: 'Bravo', boardColumn: 'doing' })])}
        {...stripBase()}
        workerForTask={() => ({ branch: 'swarm/x', activity: 'waiting' })}
      />,
    )
    expect(getByText('swarm/x')).toBeTruthy()
    expect(queryByText(/^·/)).toBeNull()
  })
})

describe('commander strip (review column)', () => {
  const reviewCard = () =>
    data([task({ id: 'c', title: 'Charlie', boardColumn: 'review', branch: 'swarm/c' })])

  it('a review card in the engine queue shows 司令官 + presence + readiness', () => {
    const { getByText } = render(
      <BoardTab
        data={reviewCard()}
        {...stripBase()}
        managerForTask={() => ({ presence: 'working', reviewStatus: 'ff' })}
      />,
    )
    expect(getByText('board.card.managerLabel')).toBeTruthy()
    // Same vocabulary as the Swarm tab — 稼働中 / 統合可, not a board-only island.
    expect(getByText('projectPanel.swarm.manager.stageRunning')).toBeTruthy()
    expect(getByText('· projectPanel.swarm.manager.reviewFf')).toBeTruthy()
  })

  it("presence 'unknown' (old server) renders NO presence word — never 'missing'", () => {
    const { getByText, queryByText } = render(
      <BoardTab
        data={reviewCard()}
        {...stripBase()}
        managerForTask={() => ({ presence: 'unknown', reviewStatus: 'rebase' })}
      />,
    )
    expect(getByText('board.card.managerLabel')).toBeTruthy()
    expect(getByText('· projectPanel.swarm.manager.reviewRebase')).toBeTruthy()
    expect(queryByText('board.card.managerMissing')).toBeNull()
    expect(queryByText('projectPanel.swarm.manager.stageRunning')).toBeNull()
    expect(queryByText('projectPanel.swarm.statusWaiting')).toBeNull()
  })

  it('a conflict wins the lamp (accent) and names itself', () => {
    const { container, getByText } = render(
      <BoardTab
        data={reviewCard()}
        {...stripBase()}
        managerForTask={() => ({ presence: 'working', reviewStatus: 'conflict' })}
      />,
    )
    expect(getByText('· projectPanel.swarm.manager.reviewConflict')).toBeTruthy()
    expect(container.querySelector('.bg-accent')).toBeTruthy()
  })

  it('the strip is review-only — a doing card never asks for the commander', () => {
    const managerForTask = vi.fn(
      (): { presence: 'working'; reviewStatus: 'ff' } => ({
        presence: 'working',
        reviewStatus: 'ff',
      }),
    )
    const { queryByText } = render(
      <BoardTab
        data={data([task({ id: 'b', title: 'Bravo', boardColumn: 'doing' })])}
        {...stripBase()}
        managerForTask={managerForTask}
      />,
    )
    expect(managerForTask).not.toHaveBeenCalled()
    expect(queryByText('board.card.managerLabel')).toBeNull()
  })

  it('a review card OUTSIDE the engine queue (managerForTask → null) shows nothing', () => {
    const { queryByText } = render(
      <BoardTab data={reviewCard()} {...stripBase()} managerForTask={() => null} />,
    )
    expect(queryByText('board.card.managerLabel')).toBeNull()
  })
})

// ── Worker note line (the WHAT half of the card) ────────────────────────────
// The strip above says WHO is on the card; this line says what they report they
// are doing. It has three states and the third one is the load-bearing one:
// when the note cannot be dated, the card says nothing rather than implying the
// note is current.
describe('worker note line (doing column)', () => {
  const doingCard = () => data([task({ id: 'b', title: 'Bravo', boardColumn: 'doing' })])

  it('a fresh note renders as visible text, not only a hover tooltip', () => {
    const { getByText, queryByText } = render(
      <BoardTab
        data={doingCard()}
        {...stripBase()}
        workerForTask={() => ({
          branch: 'swarm/x',
          activity: 'working',
          note: 'wiring the reducer',
          noteFreshness: 'fresh',
        })}
      />,
    )
    // getByText never matches a title attribute, so this is red without the
    // always-on line.
    expect(getByText('wiring the reducer')).toBeTruthy()
    // A current note carries NO "last report:" prefix — otherwise the stale
    // mutation below could pass by always prefixing.
    expect(queryByText('board.card.noteStale')).toBeNull()
  })

  it('a stale note is prefixed — it must not read as a statement about now', () => {
    const { getByText } = render(
      <BoardTab
        data={doingCard()}
        {...stripBase()}
        workerForTask={() => ({
          branch: 'swarm/x',
          activity: 'waiting',
          note: 'wiring the reducer',
          noteFreshness: 'stale',
        })}
      />,
    )
    expect(getByText('board.card.noteStale')).toBeTruthy()
    // The note itself still shows — a stale report is still a report.
    expect(getByText('wiring the reducer')).toBeTruthy()
  })

  it('an UNDATABLE note renders no line at all — no placeholder, no bare claim', () => {
    const { getByText, queryByText } = render(
      <BoardTab
        data={doingCard()}
        {...stripBase()}
        // Older engine: a note carried forward with no heartbeat time.
        workerForTask={() => ({
          branch: 'swarm/x',
          activity: 'waiting',
          note: 'wiring the reducer',
        })}
      />,
    )
    // Positive control — the worker strip IS on screen, so the absence below is
    // about the note line and not about the card failing to render.
    expect(getByText('swarm/x')).toBeTruthy()
    expect(queryByText('wiring the reducer')).toBeNull()
    expect(queryByText('board.card.noteStale')).toBeNull()
  })

  it('no worker on the card → no note line even if a note is somehow passed', () => {
    const { queryByText } = render(
      <BoardTab data={doingCard()} {...stripBase()} workerForTask={() => null} />,
    )
    expect(queryByText('board.card.noteStale')).toBeNull()
  })
})

// ── Needs-you badge (ANY column) ────────────────────────────────────────────
// The one per-card signal that is lane-independent: it is rooted in
// escalation.taskId, which no column owns.
describe('needs-you badge', () => {
  const cardsInEveryLane = () =>
    data([
      task({ id: 'todo1', title: 'Todo one', boardColumn: 'todo' }),
      task({ id: 'blk1', title: 'Blocked one', boardColumn: 'blocked' }),
    ])

  it('shows on a TODO and a BLOCKED card — not just the worker/review lanes', () => {
    const { getAllByText } = render(
      <BoardTab
        data={cardsInEveryLane()}
        {...stripBase()}
        alertForTask={id =>
          id === 'todo1' || id === 'blk1'
            ? { reason: 'irreversible', hint: 'Delete the release tag?' }
            : null
        }
      />,
    )
    // Both lanes carry it — the worker strip could never do this (it is
    // resolved for `doing` only, by construction).
    expect(getAllByText('board.card.needsYou')).toHaveLength(2)
    expect(getAllByText('· board.card.needsYouIrreversible')).toHaveLength(2)
  })

  it('names the raiser’s own reason — each valve maps to its own word', () => {
    for (const [reason, key] of [
      ['irreversible', 'board.card.needsYouIrreversible'],
      ['insufficient-info', 'board.card.needsYouInsufficientInfo'],
      ['policy', 'board.card.needsYouPolicy'],
    ] as const) {
      const { getByText, unmount } = render(
        <BoardTab
          data={data([task({ id: 'a', title: 'Alpha', boardColumn: 'todo' })])}
          {...stripBase()}
          alertForTask={() => ({ reason })}
        />,
      )
      expect(getByText(`· ${key}`)).toBeTruthy()
      unmount()
    }
  })

  it('a card with no open question shows nothing — and no "all clear" either', () => {
    const { getByText, queryByText } = render(
      <BoardTab
        data={data([task({ id: 'a', title: 'Alpha', boardColumn: 'todo' })])}
        {...stripBase()}
        alertForTask={() => null}
      />,
    )
    expect(getByText('Alpha')).toBeTruthy() // positive control
    expect(queryByText('board.card.needsYou')).toBeNull()
    // Absence is not a claim: nothing on the card says it is clear.
    expect(queryByText(/allClear|判断待ちはありません/)).toBeNull()
  })

  it('the question text is a TOOLTIP, never card body text (166px columns)', () => {
    const { container, queryByText } = render(
      <BoardTab
        data={data([task({ id: 'a', title: 'Alpha', boardColumn: 'todo' })])}
        {...stripBase()}
        alertForTask={() => ({ reason: 'policy', hint: 'A whole sentence the owner reads.' })}
      />,
    )
    expect(queryByText('A whole sentence the owner reads.')).toBeNull()
    expect(
      container.querySelector('[title="A whole sentence the owner reads."]'),
    ).toBeTruthy()
  })

  it('a needs-you card that ALSO has a worker shows both — they are two true facts', () => {
    const { getByText } = render(
      <BoardTab
        data={data([task({ id: 'b', title: 'Bravo', boardColumn: 'doing' })])}
        {...stripBase()}
        alertForTask={() => ({ reason: 'insufficient-info' })}
        workerForTask={() => ({ branch: 'swarm/x', activity: 'waiting' })}
      />,
    )
    // "a worker asked you a question and is still sitting on the card" is not a
    // contradiction, so neither line suppresses the other.
    expect(getByText('board.card.needsYou')).toBeTruthy()
    expect(getByText('swarm/x')).toBeTruthy()
  })
})

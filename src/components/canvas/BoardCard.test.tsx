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
import type { BoardColumn, ProjectData, ProjectTask } from '@/lib/types'

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

import { BoardTab, parseCollapsed, toggleCollapsed } from './BoardTab'

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

// ── Collapsed columns (owner, 2026-08-26) ───────────────────────────────────
// A collapsed lane gives its `flex-1` width back to the lanes still open — that
// is the point, and it is what buys a card room to carry the model it runs on.
// What it must NOT do is take the lane's STATE with it. 判断待ち is the lane
// where not noticing stops everything: nothing on the board moves until the
// owner answers. So a rail keeps the lamp and the count.
describe('collapsed column rail', () => {
  const laneCards = () =>
    data([
      task({ id: 'b1', title: 'Blocked one', boardColumn: 'blocked' }),
      task({ id: 'b2', title: 'Blocked two', boardColumn: 'blocked' }),
      task({ id: 'd1', title: 'Doing one', boardColumn: 'doing' }),
    ])

  // The i18n mock renders a parameterised key as `key:{json}` (see its vi.mock
  // above), so titles are matched through the same shape rather than hand-typed.
  const titleFor = (key: string, name: string): string =>
    `${key}:${JSON.stringify({ name })}`
  const collapse = (name: string, view: ReturnType<typeof render>): void => {
    fireEvent.click(view.getByTitle(titleFor('board.col.collapse', name)))
  }

  it('collapsing hides the lane’s CARDS but never its count', () => {
    const view = render(<BoardTab data={laneCards()} {...stripBase()} />)
    expect(view.getByText('Blocked one')).toBeTruthy()
    collapse('board.col.blocked', view)
    // The cards are gone from the board…
    expect(view.queryByText('Blocked one')).toBeNull()
    expect(view.queryByText('Blocked two')).toBeNull()
    // …and the rail still says how many are waiting on you. A mutation that
    // drops the count (or renders `display:none`) turns this red.
    const rail = view.getByTitle(titleFor('board.col.expand', 'board.col.blocked'))
    expect(rail.textContent).toContain('2')
  })

  it('the other lanes keep rendering — collapsing one is not collapsing the board', () => {
    const view = render(<BoardTab data={laneCards()} {...stripBase()} />)
    collapse('board.col.blocked', view)
    expect(view.getByText('Doing one')).toBeTruthy()
  })

  it('the rail toggles back open', () => {
    const view = render(<BoardTab data={laneCards()} {...stripBase()} />)
    collapse('board.col.blocked', view)
    fireEvent.click(view.getByTitle(titleFor('board.col.expand', 'board.col.blocked')))
    expect(view.getByText('Blocked one')).toBeTruthy()
  })
})

// ── The collapsed set, as pure logic ────────────────────────────────────────
describe('toggleCollapsed / parseCollapsed', () => {
  it('toggles membership without mutating the input', () => {
    const start: BoardColumn[] = ['done']
    expect(toggleCollapsed(start, 'blocked')).toEqual(['done', 'blocked'])
    expect(toggleCollapsed(['done', 'blocked'], 'done')).toEqual(['blocked'])
    expect(start).toEqual(['done']) // untouched
  })

  it('a stale or hand-edited stored value degrades per entry, never throws', () => {
    expect(parseCollapsed(null)).toEqual([])
    expect(parseCollapsed('')).toEqual([])
    // 'archived' is not a column any more; 'done' beside it still survives.
    expect(parseCollapsed('done, archived , blocked')).toEqual(['done', 'blocked'])
    expect(parseCollapsed('garbage')).toEqual([])
  })
})

// ── Card body preview ───────────────────────────────────────────────────────
// The first two lines of a card's own notes. A DISPATCHED card's notes open with
// the brief the worker was given (【背景】…), which at two lines of a ~260px card
// is always cut mid-path and tells the owner nothing — so the preview is not
// drawn once a worker owns the card (owner, 2026-08-23). An undispatched card's
// notes are usually short and readable, so there it stays.
//
// The two cases below have to move in OPPOSITE directions, which is the point:
// a mutation that simply always-hides or always-shows the preview fails one of
// them.
describe('card body preview', () => {
  const BRIEF = '【背景】 既存レポート docs/research/20260815-fde.md を踏まえ'
  const doingWithNotes = () =>
    data([task({ id: 'b', title: 'Bravo', boardColumn: 'doing', notes: BRIEF })])

  it('a worker-owned card does NOT preview its notes — they only ever truncate', () => {
    const { getByText, queryByText } = render(
      <BoardTab
        data={doingWithNotes()}
        {...stripBase()}
        workerForTask={() => ({ branch: 'swarm/x', activity: 'working' })}
      />,
    )
    // Positive control — the card IS rendered (title + strip), so the absence
    // below is about the preview, not a card that failed to draw.
    expect(getByText('Bravo')).toBeTruthy()
    expect(getByText('projectPanel.swarm.manager.stageRunning')).toBeTruthy()
    expect(queryByText(BRIEF)).toBeNull()
  })

  it('the SAME card with no worker DOES preview its notes', () => {
    const { getByText } = render(
      <BoardTab data={doingWithNotes()} {...stripBase()} workerForTask={() => null} />,
    )
    expect(getByText(BRIEF)).toBeTruthy()
  })
})

// ── Worker strip (doing column) ─────────────────────────────────────────────
// ONE row, and the tests below exist to keep it one row. The strip used to end
// with the branch handle, and a separate row under it carried the worker's own
// report; on a ~260px card both were always cut ("swarm/f…", a half sentence),
// so they told the owner nothing while costing two of the card's rows. The
// owner asked for the card to carry only what can actually be read
// (2026-08-23): title, who is on it, and where they are in the run.
//
// What moved did NOT vanish — branch and report are in the strip's tooltip, and
// in full in the Swarm tab. So each test below pins BOTH halves: gone from the
// body, still reachable.
describe('worker strip (doing column)', () => {
  it('shows the heartbeat phase as visible text — the one "what is it doing" that fits', () => {
    const { getByText } = render(
      <BoardTab
        data={data([task({ id: 'b', title: 'Bravo', boardColumn: 'doing' })])}
        {...stripBase()}
        workerForTask={() => ({ branch: 'swarm/x', activity: 'working', phase: 'verify' })}
      />,
    )
    // 'verify' is known swarm vocabulary → the owner-plain i18n key (t echoes keys).
    expect(getByText('· board.card.phaseVerify')).toBeTruthy()
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
    // Positive control — the strip IS on screen (its activity word), so the
    // absence below is about the phase span and not a card that failed to render.
    expect(getByText('projectPanel.swarm.statusWaiting')).toBeTruthy()
    expect(queryByText(/^·/)).toBeNull()
  })

  it('⚠ the BRANCH is not card body text — it only ever truncated to noise', () => {
    const { getByText, queryByText } = render(
      <BoardTab
        data={data([task({ id: 'b', title: 'Bravo', boardColumn: 'doing' })])}
        {...stripBase()}
        workerForTask={() => ({ branch: 'swarm/x', activity: 'working', phase: 'verify' })}
      />,
    )
    // getByText never matches a title attribute, so re-adding the branch span
    // turns this red.
    expect(queryByText('swarm/x')).toBeNull()
    // …and it is not LOST: the tooltip still names which worker owns the card.
    expect(getByText('· board.card.phaseVerify').closest('div')?.getAttribute('title')).toBe(
      'swarm/x',
    )
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
    // The lamp is a FIGURE now (the owl), not a coloured dot, so the assertion
    // moved from a class to what the figure SAYS — which is also the only thing
    // a reader who cannot see it gets. 'asking' is the loudest state in the set
    // and the one reserved for a claim on the owner.
    expect(
      container.querySelector(
        '[aria-label="board.card.managerLabel projectPanel.swarm.manager.reviewConflict"]',
      ),
    ).toBeTruthy()
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
// ── What the worker is running on (owner, 2026-08-26) ───────────────────────
// The owner asked for the MODEL and the EFFORT by name. The alternative on the
// table was a weight badge (「重」/「軽」) — rejected as too abstract: the weight
// bucket is an internal routing detail (a keyword match on the card's own text),
// and what is worth checking at a glance is whether THIS card got the tier it
// deserved. Both are short fixed tokens, so the pair fits where the branch and
// the report did not.
describe('worker run tier on the card', () => {
  const doing = () => data([task({ id: 'b', title: 'Bravo', boardColumn: 'doing' })])

  it('prints model/effort verbatim — not a weight word', () => {
    const { getByText, queryByText } = render(
      <BoardTab
        data={doing()}
        {...stripBase()}
        workerForTask={() => ({
          branch: 'swarm/x',
          activity: 'working',
          phase: 'implement',
          model: 'opus',
          effort: 'high',
        })}
      />,
    )
    expect(getByText('opus/high')).toBeTruthy()
    // The rejected alternative must not creep back in.
    expect(queryByText('重')).toBeNull()
    expect(queryByText('軽')).toBeNull()
  })

  it('model alone still prints when the effort is unknown — half a truth, not none', () => {
    const { getByText } = render(
      <BoardTab
        data={doing()}
        {...stripBase()}
        workerForTask={() => ({ branch: 'swarm/x', activity: 'working', model: 'fable' })}
      />,
    )
    expect(getByText('fable')).toBeTruthy()
  })

  it('⚠ a worker the engine never dispatched prints NOTHING — no guessed tier', () => {
    const { getByText, queryByText } = render(
      <BoardTab
        data={doing()}
        {...stripBase()}
        // A curl-direct spawn: the engine tracked no model for it.
        workerForTask={() => ({ branch: 'swarm/x', activity: 'working', phase: 'implement' })}
      />,
    )
    // Positive control — the strip IS up, so the absence is about the tier.
    expect(getByText('· board.card.phaseImplement')).toBeTruthy()
    expect(queryByText(/\/(high|medium|low|max)$/)).toBeNull()
    expect(queryByText('opus')).toBeNull()
  })
})

// ── Worker note (doing column) ──────────────────────────────────────────────
// The worker's own report of what it is doing. It was its own visible row until
// 2026-08-23; at two lines of ~260px it only ever showed a cut half-sentence, so
// the owner had it removed from the card. It now rides in the strip's tooltip.
//
// ⚠ THE FRESHNESS RULE SURVIVED THE MOVE, and these tests are what hold it
// there: a note rendered bare IS a claim that it is true NOW, and that is just
// as true inside a tooltip as it was in a row. So — fresh prints as-is, stale
// carries 「最後の報告:」, and an UNDATABLE note appears nowhere at all (we
// cannot say when it was true, and a placeholder would be the same claim with
// fewer words).
describe('worker note — tooltip only, freshness rule intact (doing column)', () => {
  const doingCard = () => data([task({ id: 'b', title: 'Bravo', boardColumn: 'doing' })])

  // The strip's OWN title — reached from its activity word, whose parent IS the
  // strip div. (A bare querySelector('[title]') picks up the column header
  // instead and would pass against the wrong element.)
  const stripTitle = (activityLabel: HTMLElement): string | null =>
    activityLabel.parentElement?.getAttribute('title') ?? null

  it('a fresh note rides in the tooltip, unprefixed — and never as card body text', () => {
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
    // Body text: gone. Re-adding the note row turns this red.
    expect(queryByText('wiring the reducer')).toBeNull()
    // Tooltip: present, and carrying NO "last report:" prefix — otherwise the
    // stale case below could pass by always prefixing.
    expect(stripTitle(getByText('projectPanel.swarm.manager.stageRunning'))).toBe(
      'swarm/x — wiring the reducer',
    )
  })

  it('a stale note is STILL prefixed — it must not read as a statement about now', () => {
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
    expect(stripTitle(getByText('projectPanel.swarm.statusWaiting'))).toBe(
      'swarm/x — board.card.noteStale wiring the reducer',
    )
  })

  it('an UNDATABLE note appears NOWHERE — not in the body, not in the tooltip', () => {
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
    // The tooltip still names the worker, so the absence is about the note.
    expect(stripTitle(getByText('projectPanel.swarm.statusWaiting'))).toBe('swarm/x')
    expect(queryByText('wiring the reducer')).toBeNull()
    expect(queryByText('board.card.noteStale')).toBeNull()
  })

  it('no worker on the card → no note anywhere even if a note is somehow passed', () => {
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
    // contradiction, so neither line suppresses the other. (The strip is read by
    // its activity word now — the branch handle left the card body in 2026-08-23.)
    expect(getByText('board.card.needsYou')).toBeTruthy()
    expect(getByText('projectPanel.swarm.statusWaiting')).toBeTruthy()
  })
})

// ─── the swarm figures on a card ─────────────────────────────────────────────
//
// The owner asked for the three roles as characters with per-state animation
// (2026-08-15), so the card's status lamps became figures: a rabbit for the
// worker, an owl for the commander. At 16px what a reader takes in first is HOW
// it moves, and a screen reader takes in neither — so the only assertion worth
// making here is on the accessible name, which is the one channel that carries
// role AND state in words. A figure whose name says only "Worker" would be a
// picture that means something to exactly half the room.
describe('the swarm figures say who and what, in words', () => {
  const nameOf = (c: HTMLElement, label: string) => c.querySelector(`[aria-label="${label}"]`)
  const reviewCard = () =>
    data([task({ id: 'c', title: 'Charlie', boardColumn: 'review', branch: 'swarm/c' })])

  it('draws the WORKER as a figure that names its activity', () => {
    const { container } = render(
      <BoardTab
        data={data([task({ id: 'b', title: 'Bravo', boardColumn: 'doing' })])}
        {...stripBase()}
        workerForTask={() => ({ branch: 'swarm/x', activity: 'working' })}
      />,
    )
    expect(
      nameOf(container, 'board.card.workerLabel projectPanel.swarm.manager.stageRunning'),
    ).toBeTruthy()
  })

  it('ASKING outranks the activity — a worker waiting on YOU is not just "waiting"', () => {
    // spriteStateFor's rule, at the surface that made it necessary: the worker's
    // own activity is a fact about the process, and an unanswered question is a
    // fact about the owner. The second one is what they need to see.
    const { container } = render(
      <BoardTab
        data={data([task({ id: 'b', title: 'Bravo', boardColumn: 'doing' })])}
        {...stripBase()}
        alertForTask={() => ({ reason: 'insufficient-info' })}
        workerForTask={() => ({ branch: 'swarm/x', activity: 'working' })}
      />,
    )
    expect(nameOf(container, 'board.card.workerLabel board.card.needsYou')).toBeTruthy()
    expect(
      nameOf(container, 'board.card.workerLabel projectPanel.swarm.manager.stageRunning'),
    ).toBeNull()
  })

  it('draws the COMMANDER as a figure on a review card', () => {
    const { container } = render(
      <BoardTab
        data={reviewCard()}
        {...stripBase()}
        managerForTask={() => ({ presence: 'working', reviewStatus: 'ff' })}
      />,
    )
    expect(
      nameOf(container, 'board.card.managerLabel projectPanel.swarm.manager.stageRunning'),
    ).toBeTruthy()
  })

  it('draws NO commander figure when there is no commander to draw', () => {
    // `off` is the one tone with no figure: every state the owl has is a claim
    // that it is there, so a missing commander keeps the plain dot.
    const { container } = render(
      <BoardTab
        data={reviewCard()}
        {...stripBase()}
        managerForTask={() => ({ presence: 'missing', reviewStatus: 'unknown' })}
      />,
    )
    expect(container.querySelector('[aria-label^="board.card.managerLabel"]')).toBeNull()
    expect(container.querySelector('.bg-ink-faint')).toBeTruthy()
  })

  it('a card with no swarm on it draws no figure at all', () => {
    const { container } = render(
      <BoardTab data={data([task({ id: 'b', title: 'Bravo' })])} {...stripBase()} />,
    )
    expect(container.querySelector('[aria-label^="board.card.workerLabel"]')).toBeNull()
    expect(container.querySelector('[aria-label^="board.card.managerLabel"]')).toBeNull()
  })
})

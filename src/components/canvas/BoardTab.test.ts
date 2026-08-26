import { describe, it, expect } from 'vitest'
import {
  assigneeMatches,
  boardColumnKeys,
  columnOf,
  byColumnOrder,
  byDoneOrder,
  columnSorter,
  withDoneCleared,
  withCardDuplicated,
  withCardMoved,
  reviewBranchesOf,
} from './BoardTab'
import type { ProjectData, ProjectTask } from '@/lib/types'

const task = (over: Partial<ProjectTask>): ProjectTask => ({
  id: 't',
  title: 'x',
  done: false,
  createdAt: '2026-01-01T00:00:00Z',
  ...over,
})

describe('columnOf (back-compat)', () => {
  it('defaults a column-less task to todo', () => {
    expect(columnOf(task({}))).toBe('todo')
  })
  it('falls back to the done flag when no explicit column', () => {
    expect(columnOf(task({ done: true }))).toBe('done')
  })
  it('respects an explicit column over the done flag', () => {
    expect(columnOf(task({ done: true, boardColumn: 'doing' }))).toBe('doing')
  })
  it('keeps an explicit review-column card in review (always-shown lane)', () => {
    expect(columnOf(task({ boardColumn: 'review' }))).toBe('review')
  })
})

describe('boardColumnKeys (always all five lanes)', () => {
  it('returns the five fixed lanes with review between doing and done', () => {
    expect(boardColumnKeys()).toEqual([
      'todo',
      'doing',
      'review',
      'done',
      'blocked',
    ])
  })
})

describe('assigneeMatches (Mine-only filter compare)', () => {
  it('matches case-insensitively with trimmed whitespace', () => {
    expect(assigneeMatches('  Alice ', 'alice')).toBe(true)
    expect(assigneeMatches('ALICE', ' Alice ')).toBe(true)
  })
  it('does not match different names', () => {
    expect(assigneeMatches('alice', 'bob')).toBe(false)
  })
  it('never matches when either side is empty or unset', () => {
    expect(assigneeMatches(undefined, 'alice')).toBe(false)
    expect(assigneeMatches('alice', undefined)).toBe(false)
    expect(assigneeMatches('alice', null)).toBe(false)
    expect(assigneeMatches('', '')).toBe(false)
    expect(assigneeMatches('   ', '   ')).toBe(false)
  })
})

describe('withDoneCleared (Done-column bulk clear)', () => {
  const projectData = (tasks: ProjectTask[]): ProjectData => ({
    description: '',
    notes: '',
    updatedAt: '2026-01-01T00:00:00Z',
    tasks,
  })

  it('removes explicit done-column cards and legacy done-flag cards', () => {
    const keepTodo = task({ id: 'todo' })
    const keepDoing = task({ id: 'doing', boardColumn: 'doing' })
    const explicitDone = task({ id: 'd1', boardColumn: 'done' })
    const legacyDone = task({ id: 'd2', done: true })
    const next = withDoneCleared(
      projectData([keepTodo, explicitDone, keepDoing, legacyDone]),
    )
    expect(next.tasks.map(t => t.id)).toEqual(['todo', 'doing'])
  })

  it('keeps a done-flagged card that explicitly sits in another column', () => {
    const reopened = task({ id: 'r', done: true, boardColumn: 'doing' })
    expect(withDoneCleared(projectData([reopened])).tasks.map(t => t.id)).toEqual(['r'])
  })

  it('is a no-op shape-wise with nothing in Done — other fields preserved', () => {
    const keep = task({ id: 'a' })
    const data = projectData([keep])
    const next = withDoneCleared(data)
    expect(next.tasks).toEqual([keep])
    expect(next.description).toBe(data.description)
    expect(next.updatedAt).toBe(data.updatedAt)
  })
})

describe('withCardDuplicated (card duplication — F020)', () => {
  const projectData = (tasks: ProjectTask[]): ProjectData => ({
    description: '',
    notes: '',
    updatedAt: '2026-01-01T00:00:00Z',
    tasks,
  })

  it('inserts the copy directly after the source, in the same column', () => {
    const a = task({ id: 'a', title: 'A', boardColumn: 'doing', boardOrder: 0 })
    const b = task({ id: 'b', title: 'B', boardColumn: 'doing', boardOrder: 1 })
    const next = withCardDuplicated(projectData([a, b]), 'a')
    expect(next.tasks).toHaveLength(3)
    const dup = next.tasks[1]
    expect(next.tasks[0].id).toBe('a')
    expect(next.tasks[2].id).toBe('b')
    expect(dup.boardColumn).toBe('doing')
    expect(dup.title).toBe('A (copy)')
  })

  it('renumbers boardOrder 0..n: copy right below the source, the rest pushed down', () => {
    const a = task({ id: 'a', boardColumn: 'todo', boardOrder: 0 })
    const b = task({ id: 'b', boardColumn: 'todo', boardOrder: 1 })
    const c = task({ id: 'c', boardColumn: 'todo', boardOrder: 2 })
    const next = withCardDuplicated(projectData([a, b, c]), 'a')
    const byId = new Map(next.tasks.map(t => [t.id, t]))
    const dup = next.tasks.find(t => !['a', 'b', 'c'].includes(t.id))!
    expect(byId.get('a')!.boardOrder).toBe(0)
    expect(dup.boardOrder).toBe(1)
    expect(byId.get('b')!.boardOrder).toBe(2)
    expect(byId.get('c')!.boardOrder).toBe(3)
  })

  it('copies notes + assignee; mints a fresh id', () => {
    const src = task({ id: 'src', title: 'T', notes: 'plan', assignee: 'alice' })
    const next = withCardDuplicated(projectData([src]), 'src')
    const dup = next.tasks[1]
    expect(dup.notes).toBe('plan')
    expect(dup.assignee).toBe('alice')
    expect(dup.id).not.toBe('src')
    expect(dup.id.length).toBeGreaterThan(0)
  })

  it('does NOT copy branch / prUrl / reviewedBy / titleAuto / done — new work', () => {
    const src = task({
      id: 'src',
      title: 'T',
      branch: 'task/x',
      prUrl: 'https://example.com/pr/1',
      reviewedBy: 'bob',
      titleAuto: true,
      done: true,
      boardColumn: 'review',
    })
    const next = withCardDuplicated(projectData([src]), 'src')
    const dup = next.tasks[1]
    expect(dup.branch).toBeUndefined()
    expect(dup.prUrl).toBeUndefined()
    expect(dup.reviewedBy).toBeUndefined()
    expect(dup.titleAuto).toBeUndefined()
    expect(dup.done).toBe(false)
    // …but it still lands in the source's column.
    expect(dup.boardColumn).toBe('review')
  })

  it('pins a legacy done-flag card\'s copy to the done column explicitly (done mirrors the column)', () => {
    const legacy = task({ id: 'legacy', done: true }) // no explicit boardColumn
    const next = withCardDuplicated(projectData([legacy]), 'legacy')
    const dup = next.tasks[1]
    expect(dup.boardColumn).toBe('done')
    // done stays in sync with the column (the moveCard invariant) — a copy
    // sitting in Done must read as done, not as an open card parked there.
    expect(dup.done).toBe(true)
    expect(columnOf(dup)).toBe('done')
  })

  it('keeps the copy of a non-done card open (done: false) even when the source is done-flagged elsewhere', () => {
    const src = task({ id: 'src', done: true, boardColumn: 'review' })
    const next = withCardDuplicated(projectData([src]), 'src')
    const dup = next.tasks[1]
    expect(dup.boardColumn).toBe('review')
    expect(dup.done).toBe(false)
  })

  it('leaves other columns\' boardOrder untouched', () => {
    const src = task({ id: 'src', boardColumn: 'todo', boardOrder: 0 })
    const other = task({ id: 'other', boardColumn: 'doing', boardOrder: 7 })
    const next = withCardDuplicated(projectData([src, other]), 'src')
    expect(next.tasks.find(t => t.id === 'other')!.boardOrder).toBe(7)
  })

  it('returns the data unchanged for an unknown taskId', () => {
    const data = projectData([task({ id: 'a' })])
    expect(withCardDuplicated(data, 'nope')).toBe(data)
  })
})

describe('withCardMoved (drag/drop + merged-chip move — full-column renumbering)', () => {
  const projectData = (tasks: ProjectTask[]): ProjectData => ({
    description: '',
    notes: '',
    updatedAt: '2026-01-01T00:00:00Z',
    tasks,
  })
  const orderOf = (d: ProjectData, id: string) =>
    d.tasks.find(t => t.id === id)!.boardOrder

  it('moves into a column before a card, renumbering the whole column 0..n', () => {
    const a = task({ id: 'a', boardColumn: 'todo', boardOrder: 0 })
    const b = task({ id: 'b', boardColumn: 'todo', boardOrder: 1 })
    const m = task({ id: 'm', boardColumn: 'doing', boardOrder: 0 })
    const next = withCardMoved(projectData([a, b, m]), 'm', 'todo', 'b')
    expect(next.tasks.find(t => t.id === 'm')).toMatchObject({
      boardColumn: 'todo',
      boardOrder: 1,
      done: false,
    })
    expect(orderOf(next, 'a')).toBe(0)
    expect(orderOf(next, 'b')).toBe(2)
  })

  it('renumbers over the FULL column, not a filtered view: hidden cards never collide', () => {
    // h0/h2 are "hidden" by a search / Mine-only filter in the UI — the
    // helper sees ALL of them and must hand out unique orders.
    const h0 = task({ id: 'h0', boardColumn: 'done', boardOrder: 0, done: true })
    const v1 = task({ id: 'v1', boardColumn: 'done', boardOrder: 1, done: true })
    const h2 = task({ id: 'h2', boardColumn: 'done', boardOrder: 2, done: true })
    const v3 = task({ id: 'v3', boardColumn: 'done', boardOrder: 3, done: true })
    const m = task({ id: 'm', boardColumn: 'doing', boardOrder: 0 })
    // The UI drops m before v3 (a VISIBLE card) — in the full column that is
    // the slot between h2 and v3.
    const next = withCardMoved(projectData([h0, v1, h2, v3, m]), 'm', 'done', 'v3')
    expect(['h0', 'v1', 'h2', 'm', 'v3'].map(id => orderOf(next, id))).toEqual([
      0, 1, 2, 3, 4,
    ])
    const orders = next.tasks
      .filter(t => columnOf(t) === 'done')
      .map(t => t.boardOrder)
    expect(new Set(orders).size).toBe(orders.length) // all unique
  })

  it('a null beforeId (drop at the end / merged-chip "→ Done") appends after EVERY card, hidden included', () => {
    const hidden = task({ id: 'hidden', boardColumn: 'done', boardOrder: 5, done: true })
    const m = task({ id: 'm', boardColumn: 'review', boardOrder: 0, branch: 'task/x' })
    const next = withCardMoved(projectData([hidden, m]), 'm', 'done', null)
    expect(orderOf(next, 'hidden')).toBe(0)
    expect(next.tasks.find(t => t.id === 'm')).toMatchObject({
      boardColumn: 'done',
      boardOrder: 1,
      done: true,
    })
  })

  it('syncs done with the column and clears reviewedBy on rework moves', () => {
    const m = task({
      id: 'm',
      boardColumn: 'review',
      boardOrder: 0,
      reviewedBy: 'alice',
    })
    const back = withCardMoved(projectData([m]), 'm', 'doing', null)
    expect(back.tasks[0]).toMatchObject({ boardColumn: 'doing', done: false })
    expect(back.tasks[0].reviewedBy).toBeUndefined()
    const done = withCardMoved(projectData([m]), 'm', 'done', null)
    expect(done.tasks[0]).toMatchObject({ boardColumn: 'done', done: true })
    expect(done.tasks[0].reviewedBy).toBe('alice') // kept for Done — the stamp survives
  })

  it('keeps a review-column card in review — never folded into doing (review lane always shown)', () => {
    // The review lane is always shown, so a card in 'review' groups by columnOf
    // directly: moving another card into doing slots in an EMPTY doing column,
    // independent of the review card (no fold-into-doing renumber).
    const parked = task({ id: 'parked', boardColumn: 'review', boardOrder: 0 })
    const m = task({ id: 'm', boardColumn: 'todo', boardOrder: 0 })
    const next = withCardMoved(projectData([parked, m]), 'm', 'doing', null)
    expect(next.tasks.find(t => t.id === 'parked')!.boardColumn).toBe('review')
    expect(orderOf(next, 'parked')).toBe(0)
    expect(next.tasks.find(t => t.id === 'm')).toMatchObject({
      boardColumn: 'doing',
      boardOrder: 0,
    })
  })

  it('returns the data unchanged for an unknown id', () => {
    const data = projectData([task({ id: 'a' })])
    expect(withCardMoved(data, 'nope', 'done', null)).toBe(data)
  })
})

describe('reviewBranchesOf (merged-detection poll input — B018)', () => {
  it('collects only branch-carrying cards sitting in the review column', () => {
    const tasks = [
      task({ id: 'a', boardColumn: 'review', branch: 'task/a' }),
      task({ id: 'b', boardColumn: 'review' }), // no branch → excluded
      task({ id: 'c', boardColumn: 'doing', branch: 'task/c' }), // wrong column
      task({ id: 'd', boardColumn: 'done', branch: 'task/d' }), // wrong column
    ]
    expect(reviewBranchesOf(tasks)).toEqual(['task/a'])
  })

  it('dedupes, trims and sorts (stable identity for the effect dependency)', () => {
    const tasks = [
      task({ id: 'a', boardColumn: 'review', branch: ' task/z ' }),
      task({ id: 'b', boardColumn: 'review', branch: 'task/z' }),
      task({ id: 'c', boardColumn: 'review', branch: 'task/a' }),
      task({ id: 'd', boardColumn: 'review', branch: '   ' }), // blank → excluded
    ]
    expect(reviewBranchesOf(tasks)).toEqual(['task/a', 'task/z'])
  })

  it('caps the list at the API limit of 50', () => {
    const tasks = Array.from({ length: 60 }, (_, i) =>
      task({ id: `t${i}`, boardColumn: 'review', branch: `task/b${String(i).padStart(2, '0')}` }),
    )
    expect(reviewBranchesOf(tasks)).toHaveLength(50)
  })

  it('ignores the legacy done-flag fallback — only explicit review counts', () => {
    const tasks = [task({ id: 'a', done: true, branch: 'task/a' })] // columnOf → done
    expect(reviewBranchesOf(tasks)).toEqual([])
  })
})

describe('byColumnOrder (priority within a column)', () => {
  it('sorts by boardOrder ascending (top = highest priority)', () => {
    const a = task({ id: 'a', boardOrder: 2 })
    const b = task({ id: 'b', boardOrder: 0 })
    const c = task({ id: 'c', boardOrder: 1 })
    expect([a, b, c].sort(byColumnOrder).map(t => t.id)).toEqual(['b', 'c', 'a'])
  })

  it('places ordered cards before un-ordered ones, the rest NEWEST-first', () => {
    // The tiebreak flipped 2026-08-26 (owner: 新しいものが一番上に). The drag
    // order still wins — these four lanes are queues, and in todo the
    // arrangement is the owner's priority statement.
    const ordered = task({ id: 'o', boardOrder: 5 })
    const oldNoOrder = task({ id: 'old', createdAt: '2026-01-01T00:00:00Z' })
    const newNoOrder = task({ id: 'new', createdAt: '2026-02-01T00:00:00Z' })
    expect(
      [oldNoOrder, ordered, newNoOrder].sort(byColumnOrder).map(t => t.id),
    ).toEqual(['o', 'new', 'old'])
  })
})

describe('byDoneOrder / columnSorter — 完了 is a record, not a queue', () => {
  it('完了 sorts NEWEST first and ignores boardOrder entirely', () => {
    // ⚠ The case that made the owner ask. A card lands in 完了 by being moved
    // there, which APPENDS it (boardOrder = n) — so honouring boardOrder buried
    // each new completion at the bottom of the lane. Flipping only the tiebreak
    // would not have helped: every one of these cards HAS a boardOrder.
    const first = task({ id: 'first', boardOrder: 0, createdAt: '2026-01-01T00:00:00Z' })
    const middle = task({ id: 'middle', boardOrder: 1, createdAt: '2026-02-01T00:00:00Z' })
    const newest = task({ id: 'newest', boardOrder: 2, createdAt: '2026-03-01T00:00:00Z' })
    expect([first, middle, newest].sort(byDoneOrder).map(t => t.id)).toEqual([
      'newest',
      'middle',
      'first',
    ])
  })

  it('columnSorter routes 完了 to the record order and every other lane to the queue order', () => {
    const ordered = task({ id: 'o', boardOrder: 5, createdAt: '2026-01-01T00:00:00Z' })
    const newNoOrder = task({ id: 'new', createdAt: '2026-02-01T00:00:00Z' })
    // A queue lane keeps the hand-placed card on top…
    expect([newNoOrder, ordered].sort(columnSorter('todo')).map(t => t.id)).toEqual(['o', 'new'])
    // …while 完了 answers by date alone.
    expect([newNoOrder, ordered].sort(columnSorter('done')).map(t => t.id)).toEqual(['new', 'o'])
  })

  it('every lane agrees on ONE rule: the newest thing you have not placed is on top', () => {
    const older = task({ id: 'older', createdAt: '2026-01-01T00:00:00Z' })
    const newer = task({ id: 'newer', createdAt: '2026-02-01T00:00:00Z' })
    for (const col of boardColumnKeys()) {
      expect([older, newer].sort(columnSorter(col)).map(t => t.id)).toEqual(['newer', 'older'])
    }
  })

  it('same-timestamp cards keep their order instead of being REVERSED', () => {
    // ⚠ The bug this file caught on 2026-08-26. A date comparator written as
    // `a < b ? 1 : -1` answers -1 for BOTH (a,b) and (b,a) when the dates are
    // equal — not an order, and V8 hands back a shuffled/reversed run rather
    // than leaving it alone (five equal cards came out 4,3,2,0,1, which broke
    // the drop-slot renumbering in withCardMoved). Same second = same string,
    // and swarm creates several cards per second, so this is the common case.
    const same = ['a', 'b', 'c', 'd', 'e'].map(id =>
      task({ id, createdAt: '2026-01-01T00:00:00Z' }),
    )
    for (const col of boardColumnKeys()) {
      expect([...same].sort(columnSorter(col)).map(t => t.id)).toEqual([
        'a',
        'b',
        'c',
        'd',
        'e',
      ])
    }
    // and the comparator itself is symmetric on a tie
    expect(byDoneOrder(same[0], same[1])).toBe(0)
    expect(byDoneOrder(same[1], same[0])).toBe(0)
    expect(byColumnOrder(same[0], same[1])).toBe(0)
  })
})

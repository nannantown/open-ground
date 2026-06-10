import { describe, it, expect } from 'vitest'
import {
  assigneeMatches,
  boardColumnKeys,
  columnOf,
  displayColumnOf,
  byColumnOrder,
} from './BoardTab'
import type { ProjectTask } from '@/lib/types'

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
})

describe('boardColumnKeys (review column derivation)', () => {
  it('omits review when the flag is off', () => {
    expect(boardColumnKeys(false)).toEqual(['todo', 'doing', 'done', 'blocked'])
  })
  it('slots review between doing and done when the flag is on', () => {
    expect(boardColumnKeys(true)).toEqual([
      'todo',
      'doing',
      'review',
      'done',
      'blocked',
    ])
  })
})

describe('displayColumnOf (review fold-into-doing rule)', () => {
  it('keeps a review card in review when the flag is on', () => {
    expect(displayColumnOf(task({ boardColumn: 'review' }), true)).toBe('review')
  })
  it('folds a review card into doing when the flag is off — never lost', () => {
    expect(displayColumnOf(task({ boardColumn: 'review' }), false)).toBe('doing')
  })
  it('leaves non-review cards alone regardless of the flag', () => {
    expect(displayColumnOf(task({ boardColumn: 'doing' }), false)).toBe('doing')
    expect(displayColumnOf(task({ done: true }), false)).toBe('done')
    expect(displayColumnOf(task({}), true)).toBe('todo')
  })
})

describe('assigneeMatches (Mine-only filter compare)', () => {
  it('matches case-insensitively with trimmed whitespace', () => {
    expect(assigneeMatches('  Koki ', 'koki')).toBe(true)
    expect(assigneeMatches('KOKI', ' Koki ')).toBe(true)
  })
  it('does not match different names', () => {
    expect(assigneeMatches('koki', 'naniwa')).toBe(false)
  })
  it('never matches when either side is empty or unset', () => {
    expect(assigneeMatches(undefined, 'koki')).toBe(false)
    expect(assigneeMatches('koki', undefined)).toBe(false)
    expect(assigneeMatches('koki', null)).toBe(false)
    expect(assigneeMatches('', '')).toBe(false)
    expect(assigneeMatches('   ', '   ')).toBe(false)
  })
})

describe('byColumnOrder (priority within a column)', () => {
  it('sorts by boardOrder ascending (top = highest priority)', () => {
    const a = task({ id: 'a', boardOrder: 2 })
    const b = task({ id: 'b', boardOrder: 0 })
    const c = task({ id: 'c', boardOrder: 1 })
    expect([a, b, c].sort(byColumnOrder).map(t => t.id)).toEqual(['b', 'c', 'a'])
  })

  it('places ordered cards before un-ordered ones, the rest oldest-first', () => {
    const ordered = task({ id: 'o', boardOrder: 5 })
    const oldNoOrder = task({ id: 'old', createdAt: '2026-01-01T00:00:00Z' })
    const newNoOrder = task({ id: 'new', createdAt: '2026-02-01T00:00:00Z' })
    expect(
      [newNoOrder, ordered, oldNoOrder].sort(byColumnOrder).map(t => t.id),
    ).toEqual(['o', 'old', 'new'])
  })
})

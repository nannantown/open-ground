import { describe, it, expect } from 'vitest'
import type { ProjectTask } from './types'
import {
  unresolvedDeps,
  dependencyCandidates,
  dependencyCycleIds,
  localDateString,
  isOverdue,
  formatDueShort,
} from './boardDeps'

const card = (id: string, over: Partial<ProjectTask> = {}): ProjectTask => ({
  id,
  title: `Task ${id}`,
  done: false,
  createdAt: '2026-06-10T00:00:00.000Z',
  ...over,
})

describe('unresolvedDeps', () => {
  it('returns the not-done dependencies that exist on the board', () => {
    const tasks = [card('a'), card('b'), card('c', { dependsOn: ['a', 'b'] })]
    expect(unresolvedDeps(tasks[2], tasks).map(t => t.id)).toEqual(['a', 'b'])
  })

  it('excludes done dependencies — both the done flag and the done column', () => {
    const tasks = [
      card('a', { done: true }),
      card('b', { boardColumn: 'done' }),
      card('c'),
      card('d', { dependsOn: ['a', 'b', 'c'] }),
    ]
    expect(unresolvedDeps(tasks[3], tasks).map(t => t.id)).toEqual(['c'])
  })

  it('silently skips ids of deleted cards (data untouched, render skips)', () => {
    const tasks = [card('a'), card('b', { dependsOn: ['gone', 'a'] })]
    expect(unresolvedDeps(tasks[1], tasks).map(t => t.id)).toEqual(['a'])
  })

  it('ignores a self-reference and handles missing dependsOn', () => {
    const tasks = [card('a', { dependsOn: ['a'] }), card('b')]
    expect(unresolvedDeps(tasks[0], tasks)).toEqual([])
    expect(unresolvedDeps(tasks[1], tasks)).toEqual([])
  })
})

describe('dependencyCandidates', () => {
  it('offers other cards, excluding self and existing dependencies', () => {
    const tasks = [card('a', { dependsOn: ['b'] }), card('b'), card('c')]
    expect(dependencyCandidates(tasks[0], tasks).map(t => t.id)).toEqual(['c'])
  })

  it('excludes cards that depend on this task (one-level cycle check)', () => {
    const tasks = [card('a'), card('b', { dependsOn: ['a'] }), card('c')]
    expect(dependencyCandidates(tasks[0], tasks).map(t => t.id)).toEqual(['c'])
  })
})

describe('dependencyCycleIds — deadlock detection (B025 / cycle→warn)', () => {
  const ids = (tasks: ProjectTask[]) => Array.from(dependencyCycleIds(tasks)).sort()

  it('returns nothing for an acyclic board (linear chain c→b→a)', () => {
    const tasks = [card('a'), card('b', { dependsOn: ['a'] }), card('c', { dependsOn: ['b'] })]
    expect(ids(tasks)).toEqual([])
  })

  it('returns nothing for a diamond (shared prerequisite, no loop)', () => {
    // d→{b,c}, b→a, c→a — a is reached two ways but nothing points back.
    const tasks = [
      card('a'),
      card('b', { dependsOn: ['a'] }),
      card('c', { dependsOn: ['a'] }),
      card('d', { dependsOn: ['b', 'c'] }),
    ]
    expect(ids(tasks)).toEqual([])
  })

  it('flags BOTH cards of a 2-cycle (a→b→a)', () => {
    const tasks = [card('a', { dependsOn: ['b'] }), card('b', { dependsOn: ['a'] })]
    expect(ids(tasks)).toEqual(['a', 'b'])
  })

  it('flags every card of a 3-cycle (a→b→c→a)', () => {
    const tasks = [
      card('a', { dependsOn: ['b'] }),
      card('b', { dependsOn: ['c'] }),
      card('c', { dependsOn: ['a'] }),
    ]
    expect(ids(tasks)).toEqual(['a', 'b', 'c'])
  })

  it('ignores a self-reference (a→a is a data quirk, not a deadlock)', () => {
    const tasks = [card('a', { dependsOn: ['a'] }), card('b')]
    expect(ids(tasks)).toEqual([])
  })

  it('ignores a dead edge to a deleted/typo prerequisite id', () => {
    const tasks = [card('a', { dependsOn: ['ghost'] }), card('b', { dependsOn: ['a'] })]
    expect(ids(tasks)).toEqual([])
  })

  it('does NOT flag a card that only points INTO a cycle without being on it', () => {
    // d→a, and a↔b is the loop. d waits on the loop but is not itself on it.
    const tasks = [
      card('a', { dependsOn: ['b'] }),
      card('b', { dependsOn: ['a'] }),
      card('d', { dependsOn: ['a'] }),
    ]
    expect(ids(tasks)).toEqual(['a', 'b'])
  })

  it('reports two disjoint cycles together', () => {
    const tasks = [
      card('a', { dependsOn: ['b'] }),
      card('b', { dependsOn: ['a'] }),
      card('c', { dependsOn: ['d'] }),
      card('d', { dependsOn: ['c'] }),
    ]
    expect(ids(tasks)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('flags a card reachable only via a CROSS edge, order-independently (review-A)', () => {
    // 1→2, 2→[3,4], 3→1, 4→3. Node 4 sits on the loop 1→2→4→3→1, so the whole
    // SCC {1,2,3,4} is on a cycle REGARDLESS of node 2's dependsOn order. The
    // old back-edge DFS returned {1,2,3} for order [3,4] — silently dropping the
    // deadlocked node 4 (no ⚠, an unseen infinite wait) — and {1,2,3,4} for
    // [4,3], i.e. non-deterministic. This is the exact regression that bounced
    // the card; it must hold for BOTH orders.
    const graph = (node2Deps: string[]) => [
      card('1', { dependsOn: ['2'] }),
      card('2', { dependsOn: node2Deps }),
      card('3', { dependsOn: ['1'] }),
      card('4', { dependsOn: ['3'] }),
    ]
    expect(ids(graph(['3', '4']))).toEqual(['1', '2', '3', '4'])
    expect(ids(graph(['4', '3']))).toEqual(['1', '2', '3', '4'])
    // …and independent of the TASK array order too (SCC, not finish-order).
    const shuffled = [
      card('4', { dependsOn: ['3'] }),
      card('2', { dependsOn: ['3', '4'] }),
      card('1', { dependsOn: ['2'] }),
      card('3', { dependsOn: ['1'] }),
    ]
    expect(ids(shuffled)).toEqual(['1', '2', '3', '4'])
  })

  it('merges overlapping cycles that share a node into one set', () => {
    // a↔b and b↔c share node b — all three are mutually reachable, one SCC.
    const tasks = [
      card('a', { dependsOn: ['b'] }),
      card('b', { dependsOn: ['a', 'c'] }),
      card('c', { dependsOn: ['b'] }),
    ]
    expect(ids(tasks)).toEqual(['a', 'b', 'c'])
  })
})

describe('due date helpers', () => {
  // Local-time boundary: 23:59 on June 15 is still June 15.
  const now = new Date(2026, 5, 15, 23, 59, 0)

  it('localDateString formats local time as YYYY-MM-DD', () => {
    expect(localDateString(now)).toBe('2026-06-15')
    expect(localDateString(new Date(2026, 0, 5, 0, 0, 0))).toBe('2026-01-05')
  })

  it('isOverdue: today (inclusive) and earlier are overdue, tomorrow is not', () => {
    expect(isOverdue('2026-06-15', now)).toBe(true) // due today = overdue
    expect(isOverdue('2026-06-14', now)).toBe(true)
    expect(isOverdue('2026-06-16', now)).toBe(false)
    // Early morning of the due day is still overdue (date, not time, decides).
    expect(isOverdue('2026-06-15', new Date(2026, 5, 15, 0, 0, 1))).toBe(true)
  })

  it('formatDueShort renders M/D without leading zeros', () => {
    expect(formatDueShort('2026-06-15')).toBe('6/15')
    expect(formatDueShort('2026-12-01')).toBe('12/1')
    expect(formatDueShort('not-a-date')).toBe('not-a-date')
  })
})

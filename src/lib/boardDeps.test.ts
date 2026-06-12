import { describe, it, expect } from 'vitest'
import type { ProjectTask } from './types'
import {
  unresolvedDeps,
  dependencyCandidates,
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

import { describe, it, expect } from 'vitest'
import { classifyTerminal, deriveCardStatus, columnOf, byColumnOrder } from './BoardTab'
import type { ProjectTask, RunEntry, RunSession } from '@/lib/types'

const entry = (over: Partial<RunEntry>): RunEntry => ({
  projectId: 'p',
  projectName: 'P',
  projectPath: '/p',
  status: 'done',
  log: '',
  targetedTasks: [],
  ...over,
})
const session = (entries: RunEntry[]): RunSession => ({
  id: 's',
  startedAt: '2026-01-01T00:00:00Z',
  entries,
})

describe('classifyTerminal (board-run advance gate)', () => {
  it('treats a running/pending entry as live', () => {
    expect(classifyTerminal(session([entry({ status: 'running' })]))).toBe('live')
    expect(classifyTerminal(session([entry({ status: 'pending' })]))).toBe('live')
  })

  it('treats an unobserved run (no entries / undefined) as live', () => {
    expect(classifyTerminal(undefined)).toBe('live')
    expect(classifyTerminal(session([]))).toBe('live')
  })

  it('done + taskComplete=true → done', () => {
    expect(
      classifyTerminal(session([entry({ status: 'done', parsedResult: { taskComplete: true } as never })])),
    ).toBe('done')
  })

  it('done WITHOUT taskComplete (auto-loop exhausted / question) → blocked', () => {
    expect(classifyTerminal(session([entry({ status: 'done' })]))).toBe('blocked')
    expect(
      classifyTerminal(session([entry({ status: 'done', parsedResult: { taskComplete: false } as never })])),
    ).toBe('blocked')
  })

  it('merge conflict / failed-fatal → blocked even if status done', () => {
    expect(classifyTerminal(session([entry({ status: 'done', mergeStatus: 'conflict' })]))).toBe('blocked')
    expect(classifyTerminal(session([entry({ status: 'done', mergeStatus: 'failed-fatal' })]))).toBe('blocked')
  })

  it('error → blocked, cancelled → cancelled', () => {
    expect(classifyTerminal(session([entry({ status: 'error' })]))).toBe('blocked')
    expect(classifyTerminal(session([entry({ status: 'cancelled' })]))).toBe('cancelled')
  })

  it('a live entry anywhere in the list wins over a settled head', () => {
    // entries[0] settled but a later entry still running → still live
    expect(
      classifyTerminal(session([entry({ status: 'done' }), entry({ status: 'running' })])),
    ).toBe('live')
  })
})

describe('deriveCardStatus (badge)', () => {
  it('maps run states to badge states', () => {
    expect(deriveCardStatus(undefined)).toBe('idle')
    expect(deriveCardStatus(session([entry({ status: 'running' })]))).toBe('running')
    expect(deriveCardStatus(session([entry({ status: 'pending' })]))).toBe('queued')
    expect(deriveCardStatus(session([entry({ status: 'done' })]))).toBe('done')
    expect(deriveCardStatus(session([entry({ status: 'error' })]))).toBe('error')
    expect(deriveCardStatus(session([entry({ status: 'done', mergeStatus: 'conflict' })]))).toBe('conflict')
  })
})

describe('columnOf (back-compat)', () => {
  const task = (over: Partial<ProjectTask>): ProjectTask => ({
    id: 't', title: 'x', done: false, milestoneId: null, createdAt: '', ...over,
  })
  it('defaults a column-less task to todo', () => {
    expect(columnOf(task({}))).toBe('todo')
  })
  it('falls back to done flag when no explicit column (Chats-completed task)', () => {
    expect(columnOf(task({ done: true }))).toBe('done')
  })
  it('respects an explicit column over the done flag', () => {
    expect(columnOf(task({ boardColumn: 'doing', done: true }))).toBe('doing')
  })
})

describe('byColumnOrder (priority within a column)', () => {
  const task = (over: Partial<ProjectTask>): ProjectTask => ({
    id: 't', title: 'x', done: false, milestoneId: null, createdAt: '', ...over,
  })
  it('sorts by boardOrder ascending (top = highest priority)', () => {
    const cards = [
      task({ id: 'c', boardOrder: 2 }),
      task({ id: 'a', boardOrder: 0 }),
      task({ id: 'b', boardOrder: 1 }),
    ].sort(byColumnOrder)
    expect(cards.map(t => t.id)).toEqual(['a', 'b', 'c'])
  })
  it('places ordered cards before un-ordered ones, the rest oldest-first', () => {
    const cards = [
      task({ id: 'old', boardOrder: undefined, createdAt: '2026-01-01' }),
      task({ id: 'new', boardOrder: undefined, createdAt: '2026-02-01' }),
      task({ id: 'ranked', boardOrder: 5 }),
    ].sort(byColumnOrder)
    expect(cards.map(t => t.id)).toEqual(['ranked', 'old', 'new'])
  })
})

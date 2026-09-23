import { describe, it, expect, beforeEach } from 'vitest'
import { observeBoardProgress, progressEvents, resetSupplyProgressState } from './supplyProgress'
import { peekSupplyImportant, peekSupplyProgress, resetSupplyNoticeState } from './supplyNotice'
import type { ProjectTask } from '../types'

// The 社長's progress lane: Board column moves become plain sentences, with no
// model involved. Asserted on what actually lands in the desk's queues.

const P = '/repo/progress-test'
const card = (id: string, title: string, boardColumn: ProjectTask['boardColumn']): ProjectTask =>
  ({ id, title, boardColumn, done: boardColumn === 'done', createdAt: '2026-09-23T00:00:00Z' }) as ProjectTask

beforeEach(() => {
  resetSupplyNoticeState()
  resetSupplyProgressState()
})

describe('observeBoardProgress', () => {
  it('records a baseline on first sight and reports nothing', () => {
    expect(observeBoardProgress(P, [card('a', 'ログイン', 'doing')])).toEqual([])
    expect(peekSupplyProgress().size).toBe(0)
  })

  it('reports start, review and rework as progress; a stop as important', () => {
    observeBoardProgress(P, [
      card('a', 'ログイン', 'todo'),
      card('b', '検索', 'doing'),
      card('c', '通知', 'review'),
      card('d', '決済画面', 'doing'),
    ])
    observeBoardProgress(P, [
      card('a', 'ログイン', 'doing'),
      card('b', '検索', 'review'),
      card('c', '通知', 'doing'),
      card('d', '決済画面', 'blocked'),
    ])
    const items = peekSupplyProgress().get(P) ?? []
    expect(items).toEqual([
      '「ログイン」に取りかかりました',
      '「検索」ができて、確認中です',
      '「通知」は確認で直しが入り、やり直し中です',
    ])
    const important = peekSupplyImportant().get(P) ?? []
    expect(important).toHaveLength(1)
    expect(important[0]).toContain('「決済画面」が途中で止まり')
  })

  it('does not report a card that did not move, or one that landed (sweepLanded reports it)', () => {
    observeBoardProgress(P, [card('a', 'ログイン', 'review')])
    const ev = observeBoardProgress(P, [card('a', 'ログイン', 'done')])
    expect(ev).toEqual([])
    observeBoardProgress(P, [card('a', 'ログイン', 'done')])
    expect(peekSupplyProgress().size).toBe(0)
    expect(peekSupplyImportant().size).toBe(0)
  })

  it('progressEvents is pure over a given previous map', () => {
    const prev = new Map([['x', 'todo']])
    expect(progressEvents(prev, [card('x', 'X', 'doing')])).toEqual([
      { kind: 'progress', text: '「X」に取りかかりました' },
    ])
  })
})

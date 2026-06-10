import { describe, it, expect } from 'vitest'
import { boardDiffDigest } from './boardDigest'
import { messages } from '@/i18n/messages'
import type { ProjectTask } from '@/lib/types'

// Renders through the REAL catalog (same `{var}` interpolation as
// I18nContext.t) so a renamed/missing digest key fails here, not silently at
// runtime via the key-itself fallback.
const tFor =
  (lang: 'en' | 'ja') =>
  (key: string, vars?: Record<string, string | number>): string => {
    const tpl = messages[lang][key]
    if (!tpl) throw new Error(`missing i18n key: ${key}`)
    let s = tpl
    for (const [k, v] of Object.entries(vars ?? {})) {
      s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
    }
    return s
  }
const t = tFor('en')

let seq = 0
const task = (over: Partial<ProjectTask> = {}): ProjectTask => ({
  id: over.id ?? `task-${++seq}`,
  title: 'task',
  done: false,
  createdAt: '2026-06-10T00:00:00.000Z',
  ...over,
})

describe('boardDiffDigest', () => {
  it('returns null when nothing changed', () => {
    const a = task({ id: 'a' })
    const b = task({ id: 'b', boardColumn: 'doing' })
    expect(boardDiffDigest([a, b], [a, b], t)).toBeNull()
  })

  it('returns null for two empty boards', () => {
    expect(boardDiffDigest([], [], t)).toBeNull()
  })

  it('ignores non-board edits (title/notes churn)', () => {
    const before = [task({ id: 'a', title: 'old' })]
    const after = [task({ id: 'a', title: 'new', notes: 'edited' })]
    expect(boardDiffDigest(before, after, t)).toBeNull()
  })

  it('counts added cards (plural)', () => {
    const before = [task({ id: 'a' })]
    const after = [...before, task({ id: 'b' }), task({ id: 'c' })]
    expect(boardDiffDigest(before, after, t)).toBe('+2 cards')
  })

  it('uses the singular form for one added card', () => {
    const before: ProjectTask[] = []
    const after = [task({ id: 'a' })]
    expect(boardDiffDigest(before, after, t)).toBe('+1 card')
  })

  it('lists distinct assignees of ADDED cards only', () => {
    const before = [task({ id: 'a', assignee: 'Koki' })]
    const after = [
      ...before,
      task({ id: 'b', assignee: 'Yuki' }),
      task({ id: 'c', assignee: 'Yuki' }),
      task({ id: 'd', assignee: 'Mei' }),
    ]
    expect(boardDiffDigest(before, after, t)).toBe('+3 cards (Yuki, Mei)')
  })

  it('lists the assignee on a single added card', () => {
    expect(boardDiffDigest([], [task({ id: 'a', assignee: 'Yuki' })], t)).toBe(
      '+1 card (Yuki)',
    )
  })

  it('omits the assignee list when added cards have none (or blank)', () => {
    const after = [task({ id: 'a', assignee: '  ' }), task({ id: 'b' })]
    expect(boardDiffDigest([], after, t)).toBe('+2 cards')
  })

  it('counts newly done cards', () => {
    const before = [task({ id: 'a' }), task({ id: 'b', done: true })]
    const after = [
      task({ id: 'a', done: true, boardColumn: 'done' }),
      task({ id: 'b', done: true }),
    ]
    // A newly-done card is counted once — not also as a column move.
    expect(boardDiffDigest(before, after, t)).toBe('1 done')
  })

  it('does not count an already-done card again', () => {
    const before = [task({ id: 'a', done: true, boardColumn: 'done' })]
    const after = [task({ id: 'a', done: true, boardColumn: 'done' })]
    expect(boardDiffDigest(before, after, t)).toBeNull()
  })

  it('counts column moves', () => {
    const before = [task({ id: 'a', boardColumn: 'todo' }), task({ id: 'b' })]
    const after = [
      task({ id: 'a', boardColumn: 'doing' }),
      task({ id: 'b', boardColumn: 'review' }),
    ]
    expect(boardDiffDigest(before, after, t)).toBe('2 moved')
  })

  it('treats an undefined column as todo (a materialised key is not a move)', () => {
    const before = [task({ id: 'a' })] // boardColumn undefined = todo
    const after = [task({ id: 'a', boardColumn: 'todo' })]
    expect(boardDiffDigest(before, after, t)).toBeNull()
  })

  it('counts removed cards', () => {
    const before = [task({ id: 'a' }), task({ id: 'b' }), task({ id: 'c' })]
    const after = [task({ id: 'a' })]
    expect(boardDiffDigest(before, after, t)).toBe('2 removed')
  })

  it('joins mixed changes in added · done · moved · removed order', () => {
    const before = [
      task({ id: 'stay' }),
      task({ id: 'finish', boardColumn: 'doing' }),
      task({ id: 'move', boardColumn: 'todo' }),
      task({ id: 'gone' }),
    ]
    const after = [
      task({ id: 'stay' }),
      task({ id: 'finish', done: true, boardColumn: 'done' }),
      task({ id: 'move', boardColumn: 'doing' }),
      task({ id: 'new1', assignee: 'Yuki' }),
      task({ id: 'new2', assignee: 'Yuki' }),
    ]
    expect(boardDiffDigest(before, after, t)).toBe(
      '+2 cards (Yuki) · 1 done · 1 moved · 1 removed',
    )
  })

  it('renders the Japanese catalog too', () => {
    const ja = tFor('ja')
    const before = [task({ id: 'move', boardColumn: 'todo' }), task({ id: 'fin' })]
    const after = [
      task({ id: 'move', boardColumn: 'doing' }),
      task({ id: 'fin', done: true }),
      task({ id: 'new1', assignee: 'Yuki' }),
      task({ id: 'new2' }),
    ]
    expect(boardDiffDigest(before, after, ja)).toBe(
      'カード+2（Yuki） · 完了1 · 移動1',
    )
  })
})

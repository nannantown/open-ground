import { describe, it, expect } from 'vitest'
import { assigneeCandidates, withRegisteredAssignee } from './assignees'
import type { ProjectData, ProjectTask } from './types'

const task = (id: string, assignee?: string): ProjectTask => ({
  id,
  title: id,
  done: false,
  createdAt: '2026-06-10T00:00:00.000Z',
  boardColumn: 'todo',
  ...(assignee ? { assignee } : {}),
})

const data = (over: Partial<ProjectData> = {}): ProjectData => ({
  description: '',
  tasks: [],
  notes: '',
  updatedAt: '',
  ...over,
})

describe('assigneeCandidates (list-driven)', () => {
  it('orders: registered members → me → the current assignee', () => {
    const out = assigneeCandidates(
      { config: { members: ['Yuki', 'Ken'] } },
      'Koki',
      'Mana',
    )
    expect(out).toEqual(['Yuki', 'Ken', 'Koki', 'Mana'])
  })

  it('does NOT derive names from other cards — the list is the list', () => {
    const out = assigneeCandidates({ config: { members: ['Yuki'] } }, null, null)
    expect(out).toEqual(['Yuki'])
  })

  it('dedupes case-insensitively, first casing wins', () => {
    const out = assigneeCandidates({ config: { members: ['yuki'] } }, 'YUKI', 'Yuki')
    expect(out).toEqual(['yuki'])
  })

  it('drops blanks and trims', () => {
    const out = assigneeCandidates({ config: { members: ['  Ken  ', ''] } }, '  ', null)
    expect(out).toEqual(['Ken'])
  })
})

describe('withRegisteredAssignee', () => {
  it('registers the new name into config.members AND assigns the card', () => {
    const next = withRegisteredAssignee(
      data({ tasks: [task('a')], config: { members: ['Yuki'] } }),
      'a',
      'Sora',
    )
    expect(next.config?.members).toEqual(['Yuki', 'Sora'])
    expect(next.tasks[0].assignee).toBe('Sora')
  })

  it('creates the member list when none exists', () => {
    const next = withRegisteredAssignee(data({ tasks: [task('a')] }), 'a', 'Sora')
    expect(next.config?.members).toEqual(['Sora'])
  })

  it('does not duplicate an existing member; the registered casing wins', () => {
    const next = withRegisteredAssignee(
      data({ tasks: [task('a')], config: { members: ['Sora'] } }),
      'a',
      'sora',
    )
    expect(next.config?.members).toEqual(['Sora'])
    expect(next.tasks[0].assignee).toBe('Sora')
  })

  it('blank input is a no-op', () => {
    const before = data({ tasks: [task('a', 'Yuki')] })
    expect(withRegisteredAssignee(before, 'a', '   ')).toBe(before)
  })

  it('only the targeted card is assigned', () => {
    const next = withRegisteredAssignee(
      data({ tasks: [task('a'), task('b', 'Yuki')] }),
      'a',
      'Sora',
    )
    expect(next.tasks[1].assignee).toBe('Yuki')
  })
})

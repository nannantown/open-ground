import { describe, it, expect } from 'vitest'
import { reconcileExternalData } from '@/lib/projectDataReconcile'
import type { ProjectData, ProjectTask } from '@/lib/types'

// The dual-writer policy that powers ProjectPanel's live board refresh: an
// external CLI/API write to tasks.json must be ADOPTED within one poll, our own
// echo must NOT roll the board back, and a pending local edit must win its round
// (so the user's typing is never lost). These cases lock that contract.

const card = (id: string, boardColumn: ProjectTask['boardColumn']): ProjectTask => ({
  id,
  title: id,
  done: boardColumn === 'done',
  createdAt: '2026-06-24T00:00:00.000Z',
  boardColumn,
})

const data = (tasks: ProjectTask[], updatedAt: string): ProjectData =>
  ({ tasks, updatedAt } as ProjectData)

describe('reconcileExternalData — dual-writer adoption policy', () => {
  it('ADOPTS an external boardColumn change (the swarm-board.sh move case)', () => {
    const loaded = data([card('x', 'doing')], 'U0')
    const lastSavedJson = JSON.stringify(loaded)
    // External writer moved x → done and bumped the CAS token.
    const fetched = data([card('x', 'done')], 'U1')

    const decision = reconcileExternalData({ current: loaded, lastSavedJson, fetched })
    expect(decision.kind).toBe('adopt')
    if (decision.kind !== 'adopt') return
    expect(decision.data.tasks.find(t => t.id === 'x')?.boardColumn).toBe('done')
    expect(decision.json).toBe(JSON.stringify(fetched))
  })

  it('ADOPTS a content change even when updatedAt is unchanged (byte compare, not token)', () => {
    const loaded = data([card('x', 'todo')], 'U0')
    const lastSavedJson = JSON.stringify(loaded)
    // A misbehaving writer changed the column but reused the token — still caught.
    const fetched = data([card('x', 'review')], 'U0')

    const decision = reconcileExternalData({ current: loaded, lastSavedJson, fetched })
    expect(decision.kind).toBe('adopt')
  })

  it('treats our OWN echo as a no-op (no setData → no undo-stack wipe / no rollback)', () => {
    const loaded = data([card('x', 'doing')], 'U0')
    const lastSavedJson = JSON.stringify(loaded)
    // The poll re-GETs the very bytes we last adopted — a different object with
    // identical content. Must NOT adopt (would churn the tasks array identity).
    const fetched = data([card('x', 'doing')], 'U0')
    expect(fetched).not.toBe(loaded)

    const decision = reconcileExternalData({ current: loaded, lastSavedJson, fetched })
    expect(decision.kind).toBe('echo')
  })

  it('SKIPS while a local edit is unsaved — local wins this round (no clobber of typing)', () => {
    const lastSaved = data([card('x', 'todo')], 'U0')
    const lastSavedJson = JSON.stringify(lastSaved)
    // The user dragged x → doing locally; the debounced persist has not flushed.
    const current = data([card('x', 'doing')], 'U0')
    // Meanwhile an external writer also moved things.
    const fetched = data([card('x', 'done')], 'U1')

    const decision = reconcileExternalData({ current, lastSavedJson, fetched })
    expect(decision.kind).toBe('skip-local-edit')
  })

  it('adopts on the FIRST load (current null) when fetched differs from the seed', () => {
    const decision = reconcileExternalData({
      current: null,
      lastSavedJson: '',
      fetched: data([card('x', 'todo')], 'U0'),
    })
    expect(decision.kind).toBe('adopt')
  })
})

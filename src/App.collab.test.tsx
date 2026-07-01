// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { shouldShowEmptyState, nextSelectionOnOpenOwned } from '@/App'

// These two pure helpers back the Ground's collab/member behaviour in App.tsx.
// They are exported so the decisions can be locked here without rendering the
// whole App (App pulls in the entire canvas tree — a known full-render gap).
// Both bugs they fix only appear on a collab build for a member who has shared
// (member) cards on the Ground.

describe('shouldShowEmptyState — first-run overlay must not hide shared cards', () => {
  // Bug 1: the EmptyState overlay's backdrop is inset-0 and captures clicks, so
  // showing it while the Ground has shared cards both hides them and blocks the
  // clicks. A member who joined a shared project but owns zero folders must NOT
  // get the overlay.
  it('HIDES the overlay for a member with only shared cards (the bug case)', () => {
    expect(
      shouldShowEmptyState({ ownedCount: 0, collabEnabled: true, sharedCount: 2 }),
    ).toBe(false)
  })

  it('SHOWS the overlay when the Ground is truly empty on a collab build', () => {
    expect(
      shouldShowEmptyState({ ownedCount: 0, collabEnabled: true, sharedCount: 0 }),
    ).toBe(true)
  })

  it('keeps the original collab-off behaviour (ownedCount === 0 only)', () => {
    // Default build: collab off → shared count is irrelevant, overlay shows iff
    // there are no owned projects. Byte-for-byte the old `projects.length === 0`.
    expect(
      shouldShowEmptyState({ ownedCount: 0, collabEnabled: false, sharedCount: 0 }),
    ).toBe(true)
    expect(
      shouldShowEmptyState({ ownedCount: 0, collabEnabled: false, sharedCount: 5 }),
    ).toBe(true)
    expect(
      shouldShowEmptyState({ ownedCount: 1, collabEnabled: false, sharedCount: 0 }),
    ).toBe(false)
  })

  it('never shows the overlay once any owned project exists', () => {
    expect(
      shouldShowEmptyState({ ownedCount: 3, collabEnabled: true, sharedCount: 0 }),
    ).toBe(false)
    expect(
      shouldShowEmptyState({ ownedCount: 3, collabEnabled: true, sharedCount: 2 }),
    ).toBe(false)
  })
})

describe('nextSelectionOnOpenOwned — opening an owned project clears the shared panel', () => {
  it('selects the owned id and clears openShared', () => {
    expect(nextSelectionOnOpenOwned('p1')).toEqual({
      selectedIds: ['p1'],
      openShared: null,
    })
  })

  // Bug 2 end-to-end through the real helper + the real ProjectPanel decision
  // (project={openShared ? null : singleSelected}; openShared wins). Without the
  // fix the member panel stayed pinned over the owned project the user jumped to.
  it('flips ProjectPanel from the member body to the owner body', () => {
    const ownedCard = { id: 'p1' }
    type Shared = { id: string; label: string }

    // Starting state: a member is viewing a shared project (openShared set). The
    // panel shows the member body (project resolves to null).
    let openShared: Shared | null = { id: 'c9', label: 'Shared' }
    const panelProjectBefore = openShared ? null : ownedCard
    expect(panelProjectBefore).toBeNull()

    // The user opens an owned project (⌘K jump / New / Import / card click).
    const sel = nextSelectionOnOpenOwned(ownedCard.id)
    openShared = sel.openShared
    const singleSelected = sel.selectedIds[0] === ownedCard.id ? ownedCard : null

    // Now the panel shows the OWNER body — the shared panel no longer sticks.
    const panelProjectAfter = openShared ? null : singleSelected
    expect(panelProjectAfter).toBe(ownedCard)
  })
})

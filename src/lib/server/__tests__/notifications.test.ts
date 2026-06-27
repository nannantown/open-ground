// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { getNotificationState, markNotificationsRead } from '../store'

// The in-app notification READ-STATE store (~/.openground/notifications.json). HOME
// is isolated to a tmp dir by setup-home.ts, so these touch a throwaway file, not
// the real home. Marking read is MONOTONIC (union) — that's the invariant the
// "unread survives re-login but never resurfaces" UX rests on. Order-independent:
// each case uses unique ids and asserts membership, not a global exact set.

describe('notification read-state store', () => {
  it('persists ids and UNIONs on re-mark (monotonic, deduped)', async () => {
    const a = 'collab-invite:nt-a'
    const b = 'collab-invite:nt-b'
    const c = 'collab-invite:nt-c'

    await markNotificationsRead([a, b])
    const afterFirst = (await getNotificationState()).readIds
    expect(afterFirst).toContain(a)
    expect(afterFirst).toContain(b)

    // Re-mark b (dup) + add c → union, no duplicate b.
    const merged = await markNotificationsRead([b, c])
    expect(merged).toContain(a)
    expect(merged).toContain(b)
    expect(merged).toContain(c)
    expect(merged.filter((x) => x === b)).toHaveLength(1)

    // Persisted across reads (survives a "re-login" = a fresh getNotificationState).
    expect((await getNotificationState()).readIds).toEqual(merged)
  })

  it('ignores empty / non-string ids (no-op, leaves the set unchanged)', async () => {
    const before = (await getNotificationState()).readIds
    const after = await markNotificationsRead(['', ...([42, null] as unknown as string[])])
    expect([...after].sort()).toEqual([...before].sort())
  })

  it('dedupes within a single call', async () => {
    const x = 'collab-invite:nt-dup'
    const merged = await markNotificationsRead([x, x, x])
    expect(merged.filter((v) => v === x)).toHaveLength(1)
  })
})

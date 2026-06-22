import { describe, it, expect } from 'vitest'
import { reconcileCanvasElements } from './canvasMerge'
import type { CanvasElement } from './types'

// Pure-function contract for the OCC conflict merge. This is the unit that
// backs completion conditions (d) — a stale client save keeps AI-appended
// elements AND the client's edits AND never resurrects a client deletion — and
// (e) — an AI tweak to a client-untouched element survives. `base` = what the
// client loaded; `local` = the client's current edits; `server` = base + what
// an AI job appended/tweaked since.

const txt = (id: string, x = 0, y = 0, text = id): CanvasElement => ({
  id,
  type: 'text',
  x,
  y,
  text,
})
const screen = (id: string, source: string): CanvasElement => ({
  id,
  type: 'screen',
  x: 0,
  y: 0,
  width: 400,
  height: 300,
  text: source,
})
const ids = (els: CanvasElement[]) => els.map((e) => e.id)

describe('reconcileCanvasElements (OCC 3-way merge)', () => {
  // ── Condition (d): the headline scenario ──────────────────────────────────
  it('keeps AI-appended elements, keeps client edits, and does NOT resurrect a client deletion', () => {
    const base = [txt('a'), txt('b'), txt('c')]
    // Client moved `a`, deleted `b`, kept `c`.
    const local = [{ ...txt('a'), x: 999 }, txt('c')]
    // An AI job appended `d` → the server is base + d.
    const server = [txt('a'), txt('b'), txt('c'), txt('d', 1200)]

    const out = reconcileCanvasElements(base, local, server)

    // b stays deleted (not resurrected); a keeps the client's move; c kept; d (AI) kept.
    expect(ids(out).sort()).toEqual(['a', 'c', 'd'])
    expect(out.find((e) => e.id === 'a')?.x).toBe(999) // client edit preserved
    expect(out.some((e) => e.id === 'b')).toBe(false) // deletion not resurrected
    expect(out.some((e) => e.id === 'd')).toBe(true) // AI append preserved
  })

  // ── Condition (e): a tweak to an element the client left alone survives ────
  it('applies an AI tweak to an element the client did not touch (tweak wins)', () => {
    const base = [screen('s1', 'OLD')]
    const local = [screen('s1', 'OLD')] // client never touched s1
    const server = [screen('s1', 'NEW')] // AI tweak rewrote the source

    const out = reconcileCanvasElements(base, local, server)
    expect(out).toHaveLength(1)
    expect(out[0].text).toBe('NEW') // the tweak is preserved, not clobbered
  })

  // Regression for the undefined-vs-absent-key trap: the client's in-memory copy
  // can carry an `undefined`-valued field (the inspector clears a field by
  // patching `{ field: undefined }`) that the JSON-sourced base/server lack. The
  // element is otherwise UNCHANGED by the client, so the AI tweak must still win
  // — deepEqual must treat the undefined key as absent, not as a difference.
  it('preserves an AI tweak when the untouched local element has an undefined-valued key absent from the JSON base', () => {
    const base = [screen('s1', 'OLD')] // JSON-shaped: no fillImageId key
    // Client's in-memory copy: identical EXCEPT an explicit undefined field.
    const local = [{ ...screen('s1', 'OLD'), fillImageId: undefined } as CanvasElement]
    const server = [screen('s1', 'NEW')] // AI tweaked the source
    const out = reconcileCanvasElements(base, local, server)
    expect(out).toHaveLength(1)
    expect(out[0].text).toBe('NEW') // tweak preserved, not dropped
  })

  it('keeps the client edit when BOTH the client and the AI changed the same element (last-writer = client)', () => {
    const base = [screen('s1', 'OLD')]
    const local = [screen('s1', 'CLIENT-EDIT')] // client edited s1 locally
    const server = [screen('s1', 'AI-TWEAK')] // AI also tweaked s1

    const out = reconcileCanvasElements(base, local, server)
    expect(out[0].text).toBe('CLIENT-EDIT') // the client's active edit wins
  })

  it('a tweak on an element the client DELETED is not resurrected', () => {
    const base = [screen('s1', 'OLD')]
    const local: CanvasElement[] = [] // client deleted s1
    const server = [screen('s1', 'NEW')] // AI tweaked it (still present server-side)

    const out = reconcileCanvasElements(base, local, server)
    expect(out).toHaveLength(0) // deletion wins over the tweak
  })

  // ── No-conflict / additive cases ──────────────────────────────────────────
  it('pure AI append with no local change yields base + appended', () => {
    const base = [txt('a')]
    const out = reconcileCanvasElements(base, [txt('a')], [txt('a'), txt('b')])
    expect(ids(out)).toEqual(['a', 'b'])
  })

  it('preserves a client-added element alongside an AI append', () => {
    const base = [txt('a')]
    const local = [txt('a'), txt('x')] // client added x (not yet saved)
    const server = [txt('a'), txt('b')] // AI appended b
    const out = reconcileCanvasElements(base, local, server)
    expect(ids(out).sort()).toEqual(['a', 'b', 'x'])
  })

  it('does not duplicate an element present in both local and server', () => {
    // The client already reflected the AI append locally (same id) before saving.
    const base = [txt('a')]
    const local = [txt('a'), txt('b', 1200)]
    const server = [txt('a'), txt('b', 1200)]
    const out = reconcileCanvasElements(base, local, server)
    expect(ids(out)).toEqual(['a', 'b']) // b appears exactly once
  })

  it('keeps client order, appends AI-only elements at the end', () => {
    const base = [txt('a'), txt('b')]
    const local = [txt('b'), txt('a')] // client reordered
    const server = [txt('a'), txt('b'), txt('z', 1200)]
    const out = reconcileCanvasElements(base, local, server)
    expect(ids(out)).toEqual(['b', 'a', 'z'])
  })

  it('handles empty inputs', () => {
    expect(reconcileCanvasElements([], [], [])).toEqual([])
    expect(ids(reconcileCanvasElements([], [], [txt('a')]))).toEqual(['a']) // AI append onto empty
    expect(reconcileCanvasElements([txt('a')], [], [txt('a')])).toEqual([]) // client cleared canvas
  })
})

import { describe, it, expect } from 'vitest'
import { createProjectRunGate } from './projectRunGate'

// Flush the microtask queue so a just-resolved acquire() promise settles.
const tick = () => new Promise<void>((r) => setTimeout(r, 0))

describe('createProjectRunGate', () => {
  it('lets runs up to the cap start immediately, parks the rest', async () => {
    const gate = createProjectRunGate(() => 2)
    const r1 = await gate.acquire('p')
    const r2 = await gate.acquire('p')
    expect(gate.active('p')).toBe(2)

    // Third over the cap — must not resolve until a slot frees.
    let third: (() => void) | null = null
    void gate.acquire('p').then((rel) => { third = rel })
    await tick()
    expect(third).toBeNull()
    expect(gate.waiting('p')).toBe(1)
    expect(gate.active('p')).toBe(2)

    // Free one slot → the parked run gets it (FIFO), active stays at cap.
    r1()
    await tick()
    expect(third).not.toBeNull()
    expect(gate.waiting('p')).toBe(0)
    expect(gate.active('p')).toBe(2)

    r2()
    third!()
    await tick()
    expect(gate.active('p')).toBe(0)
  })

  it('chains releases through the whole FIFO queue', async () => {
    const gate = createProjectRunGate(() => 1)
    const rels: Array<() => void> = []
    const got: number[] = []
    const first = await gate.acquire('p')
    for (let i = 0; i < 3; i++) {
      const n = i
      void gate.acquire('p').then((rel) => { got.push(n); rels.push(rel) })
    }
    await tick()
    expect(got).toEqual([])
    first()
    await tick()
    expect(got).toEqual([0])
    rels.shift()!()
    await tick()
    expect(got).toEqual([0, 1])
    rels.shift()!()
    await tick()
    expect(got).toEqual([0, 1, 2])
    rels.shift()!()
    await tick()
    expect(gate.active('p')).toBe(0)
    expect(gate.waiting('p')).toBe(0)
  })

  it('isolates cap per project', async () => {
    const gate = createProjectRunGate(() => 1)
    const a = await gate.acquire('a')
    // Different project — not gated by project "a"'s held slot.
    let bStarted = false
    void gate.acquire('b').then(() => { bStarted = true })
    await tick()
    expect(bStarted).toBe(true)
    expect(gate.active('a')).toBe(1)
    expect(gate.active('b')).toBe(1)
    a()
    await tick()
    expect(gate.active('a')).toBe(0)
  })

  it('double-release is a no-op (never drives count negative or leaks a slot)', async () => {
    const gate = createProjectRunGate(() => 1)
    const rel = await gate.acquire('p')
    expect(gate.active('p')).toBe(1)
    rel()
    rel() // second call must do nothing
    await tick()
    expect(gate.active('p')).toBe(0)
    // A waiter parked after the double-release still gets a clean slot.
    const rel2 = await gate.acquire('p')
    expect(gate.active('p')).toBe(1)
    rel2()
  })

  it('clamps a misconfigured cap of 0 to 1 (no deadlock)', async () => {
    const gate = createProjectRunGate(() => 0)
    const rel = await gate.acquire('p')
    expect(gate.active('p')).toBe(1)
    rel()
  })

  it('reads the cap dynamically per acquire', async () => {
    let cap = 1
    const gate = createProjectRunGate(() => cap)
    const r1 = await gate.acquire('p')
    let secondStarted = false
    void gate.acquire('p').then(() => { secondStarted = true })
    await tick()
    expect(secondStarted).toBe(false) // cap 1, slot held

    // Raise the cap; the parked waiter does NOT retroactively start (slots only
    // free on release), but a *new* acquire sees the higher cap.
    cap = 3
    let thirdStarted = false
    void gate.acquire('p').then(() => { thirdStarted = true })
    await tick()
    expect(thirdStarted).toBe(true)
    expect(gate.active('p')).toBe(2)
    r1()
    await tick()
    // Releasing r1 hands its slot to the first parked waiter.
    expect(secondStarted).toBe(true)
  })
})

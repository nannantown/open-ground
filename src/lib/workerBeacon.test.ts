import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import { workerBeaconStatus } from './workerBeacon'
import type { ClaudeBeaconStatus } from '@/lib/types'

// The regression this file exists for: when ClaudeBeaconStatus gained 'idle',
// SwarmModule's three `===` comparisons fell through to `exited`, so a LIVE,
// parked worker was reported to the owner as dead. tsc could not see it —
// an unmatched `===` is not a type error.

describe('workerBeaconStatus — a live worker is never reported dead', () => {
  it('a PARKED worker reads 待機中, not 終了 (the regression)', () => {
    expect(workerBeaconStatus({ status: 'idle', seen: true, exited: false })).toBe('waiting')
    // …including the first time we see it, before it has ever painted.
    expect(workerBeaconStatus({ status: 'idle', seen: false, exited: false })).toBe('waiting')
  })

  it('never says `exited` while the pool still lists the PTY', () => {
    // The pool listing it at all IS the evidence of a live process. Only an
    // observed exit, or absence from the pool, may claim otherwise.
    for (const status of ['working', 'waiting', 'idle'] as const) {
      expect(
        workerBeaconStatus({ status, seen: true, exited: false }),
        `pool listed ${status} but the row claimed it was gone`,
      ).not.toBe('exited')
    }
  })

  it('an observed exit wins over any pool verdict', () => {
    expect(workerBeaconStatus({ status: 'working', seen: true, exited: true })).toBe('exited')
  })

  it('absent from the pool: seen once ⇒ exited, never seen ⇒ starting', () => {
    expect(workerBeaconStatus({ status: undefined, seen: true, exited: false })).toBe('exited')
    expect(workerBeaconStatus({ status: undefined, seen: false, exited: false })).toBe('starting')
  })

  it('working is passed through', () => {
    expect(workerBeaconStatus({ status: 'working', seen: true, exited: false })).toBe('working')
  })

  // ─── the STRUCTURAL half ──────────────────────────────────────────────────
  // The mapping is a Record keyed by the union, so an added beacon value is a
  // BUILD error rather than a silent fall-through. This proves the claim by
  // reading the union out of the contract file and checking every member is
  // handled — with a self-check, so a parser that returns [] cannot make it
  // pass vacuously.
  it('handles EVERY member of ClaudeBeaconStatus, read from types.ts', () => {
    const src = readFileSync(path.join(process.cwd(), 'src/lib/types.ts'), 'utf8')
    const decl = 'export type ClaudeBeaconStatus ='
    const start = src.indexOf(decl)
    expect(start, 'ClaudeBeaconStatus not found — renamed or moved?').toBeGreaterThan(-1)
    const body = src.slice(start + decl.length).split('\n')[0]
    const members = Array.from(body.matchAll(/'([^']+)'/g), (m) => m[1])
    // Self-check: the parser really found something.
    expect(members.length).toBeGreaterThanOrEqual(3)
    expect(members).toContain('idle')

    for (const m of members) {
      const out = workerBeaconStatus({
        status: m as ClaudeBeaconStatus,
        seen: true,
        exited: false,
      })
      expect(
        ['working', 'waiting', 'starting'],
        `beacon '${m}' has no worker word — it would read as 終了`,
      ).toContain(out)
    }
  })
})

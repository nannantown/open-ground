// swarmOverseerFatalLabels.test.ts — STRUCTURAL GUARD tying the Overseer tab's
// fatal-event label map to the server's `SwarmFatalEvent` union.
//
// WHY THIS EXISTS (2026-08-04, found in the 5th adversarial cycle): the client
// carried a HAND-WRITTEN list of 7 event names while the server union had 11,
// and nothing joined them. The four missing names — `guard-unwired`,
// `manager-unrevivable`, `engine-resume-suppressed`, `data-integrity` — were
// dropped by the sanitizer without a trace, so the Overseer pane drew its "all
// quiet, nothing needs you" state while, e.g., the deny veto could not be
// verified and NO worker could start at all. A registration list fails by
// SILENCE; CLAUDE.md names that as the direction to avoid.
//
// The fix has two halves, and this file guards the second:
//   1. RUNTIME (useSwarmEngine.sanitizeFatalNotifications): no allowlist at all
//      — any non-empty event name renders, unlabelled ones with their raw name.
//      Guarded by useSwarmEngine.test.ts ("KEEPS an event this build has no
//      label for").
//   2. TRANSLATION (here): every union member should still get a human label.
//      A new server event with no entry fails THIS test — loudly, at build
//      time, naming the missing key — instead of shipping a slug to the owner.
//
// The union is parsed out of src/lib/types.ts rather than imported as values,
// because a TS type has no runtime representation. Parsing means a member added
// to types.ts is picked up here automatically — nothing to remember to update.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ANOMALY_LABEL, FATAL_EVENT_LABEL } from './SwarmOverseerPane'
import { messages } from '@/i18n/messages'

const TYPES_PATH = path.join(process.cwd(), 'src/lib/types.ts')

/** Extract the string-literal members of `export type <name> = 'a' | 'b' | …`. */
const readUnion = (name: string): string[] => {
  const src = readFileSync(TYPES_PATH, 'utf8')
  const start = src.indexOf(`export type ${name} =`)
  expect(start, `${name} union not found in src/lib/types.ts — did it move or get renamed?`).toBeGreaterThan(-1)
  // The union runs until the next top-level declaration (a blank line followed
  // by `/**` or `export`). Comments INSIDE the union carry prose in quotes
  // ("'data-integrity' is NOT a swarm event"), so members are matched only on
  // lines whose first non-space character is the `|` separator.
  const rest = src.slice(start)
  const end = rest.search(/\n\/\*\*|\nexport /)
  const body = end > -1 ? rest.slice(0, end) : rest
  const members: string[] = []
  for (const line of body.split('\n')) {
    const m = /^\s*\|\s*'([^']+)'/.exec(line)
    if (m) members.push(m[1])
  }
  return members
}

const readFatalEventUnion = () => readUnion('SwarmFatalEvent')
const readAnomalyKindUnion = () => readUnion('OrchestratorAnomalyKind')

describe('Overseer fatal-event labels vs the server union', () => {
  it('parses a plausible union out of types.ts (the parser itself is load-bearing)', () => {
    const members = readFatalEventUnion()
    // If the parse silently returned [] or 1 member, the coverage test below
    // would pass vacuously — exactly the "guard that guards nothing" shape.
    expect(members.length).toBeGreaterThanOrEqual(9)
    expect(members).toContain('rework-exhausted')
    expect(members).toContain('data-integrity')
    expect(new Set(members).size).toBe(members.length)
  })

  it('labels EVERY server fatal event — a new one must not reach the owner as a raw slug', () => {
    const missing = readFatalEventUnion().filter((e) => !FATAL_EVENT_LABEL[e])
    expect(
      missing,
      `These SwarmFatalEvent members have no label in SwarmOverseerPane.FATAL_EVENT_LABEL: ${missing.join(
        ', ',
      )}. Add an entry + the en/ja message keys. (The pane will still SHOW the row — it renders the raw name — but the owner deserves a sentence.)`,
    ).toEqual([])
  })

  it('every label key resolves in both locales — a key with no translation renders as the key itself', () => {
    for (const key of [...Object.values(FATAL_EVENT_LABEL), ...Object.values(ANOMALY_LABEL)]) {
      expect(messages.en[key], `missing en text for ${key}`).toBeTruthy()
      expect(messages.ja[key], `missing ja text for ${key}`).toBeTruthy()
    }
  })
})

// The SAME structural check for engine ANOMALIES, whose hand-kept client list
// dropped a server kind twice on record ('no-heartbeat' invisible until
// 2026-07-14; 'recover-review' four days later). The runtime allowlist is gone —
// an unlabelled kind now renders with its raw name — and this is what makes a
// missing LABEL loud instead of leaving the owner a slug.
describe('Overseer anomaly labels vs the server union', () => {
  it('parses a plausible union out of types.ts', () => {
    const members = readAnomalyKindUnion()
    expect(members.length).toBeGreaterThanOrEqual(8)
    expect(members).toContain('orphan-doing')
    expect(members).toContain('no-heartbeat')
    expect(new Set(members).size).toBe(members.length)
  })

  it('labels EVERY server anomaly kind', () => {
    const missing = readAnomalyKindUnion().filter((k) => !ANOMALY_LABEL[k])
    expect(
      missing,
      `These OrchestratorAnomalyKind members have no entry in SwarmOverseerPane.ANOMALY_LABEL: ${missing.join(
        ', ',
      )}. Add one plus the en/ja message keys.`,
    ).toEqual([])
  })
})

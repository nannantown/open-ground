import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  readEngineIntent,
  writeEngineIntent,
  patchEngineIntent,
} from './swarmEnginePersistence'
import { addImportedProjectEntry } from './registry'

// ─── engine.json: a write must never DROP a field it did not mention ─────────
//
// THE INCIDENT (2026-08-03 overnight review, two live features losing state):
// writeEngineIntent atomically REPLACED the file, so the three call sites that
// name only {desiredRunning, selfSupply, overseer} erased every optional field:
//   • `supplyDesired` — the supply desk's boot auto-resume, shipped that same
//     day, was silently disarmed by the very next autonomy toggle.
//   • `selfSupplyDayKey`/`selfSupplyDayCount` — the daily cap that exists
//     BECAUSE a restart must not hand self-supply a fresh budget (0729) was
//     reset by any patch call, so the loop could propose up to 2× the cap.
// Neither threw, logged, or failed a test: an optional field that vanishes
// reads exactly like one that was never set.
//
// THE STRUCTURAL FIX (this file pins it): optional fields are preserve-by-
// default inside writeEngineIntent, and the OPTIONAL KEY LIST IS READ OUT OF
// THE INTERFACE — so a field added tomorrow is covered without anyone
// remembering to extend this test. That inversion is the point: the old shape
// failed by SILENCE (a missing key), this one fails LOUDLY (a new key is
// enumerated and checked whether or not the author thought about persistence).

const SRC = readFileSync(resolve(__dirname, 'swarmEnginePersistence.ts'), 'utf8')

/** Optional keys of the EngineIntent interface, parsed from the source. */
const optionalIntentKeys = (): string[] => {
  const start = SRC.indexOf('export interface EngineIntent {')
  const body = SRC.slice(start, SRC.indexOf('\n}', start))
  return Array.from(body.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*)\?:/gm)).map((m) => m[1])
}

/** A representative non-empty value per known optional key. A NEW optional key
 *  with no sample here fails the coverage test below — deliberately: the author
 *  of the new field is the person who knows what a live value looks like. */
const SAMPLE: Record<string, unknown> = {
  supplyDesired: true,
  // The commander desk's boot auto-resume (2026-08-26) — the twin of
  // supplyDesired, added after an update restart orphaned a running swarm.
  managerDesired: true,
  selfSupplyDayKey: '2026-08-03',
  selfSupplyDayCount: 7,
  // The review-waiting clock (2026-08-14) — branch → first-seen epoch ms.
  reviewWaitingSince: { 'swarm/a': 1_700_000_000_000, 'swarm/b': 1_700_000_060_000 },
}

describe('engine.json write regime — optional fields survive a write that omits them', () => {
  let projectPath: string

  beforeEach(async () => {
    // A REGISTERED project: projectDataFile resolves through the registry UUID.
    // HOME is isolated by the global test setup, so this never touches the real
    // ~/.openground.
    projectPath = await mkdtemp(join(tmpdir(), 'og-engine-intent-'))
    await addImportedProjectEntry(projectPath)
  })

  it('every optional key in the interface has a sample here (a new field cannot slip through unchecked)', () => {
    const keys = optionalIntentKeys()
    expect(keys.length).toBeGreaterThanOrEqual(3)
    for (const k of keys) {
      expect(SAMPLE, `EngineIntent.${k} is optional but has no sample in this test`).toHaveProperty(k)
    }
  })

  it('a three-flag full write PRESERVES every optional field (the incident, generalised)', async () => {
    await writeEngineIntent(projectPath, {
      desiredRunning: true,
      selfSupply: true,
      overseer: false,
      ...(SAMPLE as object),
    })
    // The shape the three orchestrator call sites use — the one that erased.
    await writeEngineIntent(projectPath, {
      desiredRunning: false,
      selfSupply: true,
      overseer: false,
    })
    const after = (await readEngineIntent(projectPath)) as unknown as Record<string, unknown>
    for (const k of optionalIntentKeys()) {
      expect(after[k], `${k} was dropped by a write that did not mention it`).toEqual(SAMPLE[k])
    }
    // …and the stated flags DID change (the merge must not freeze the file).
    expect(after.desiredRunning).toBe(false)
  })

  it('patchEngineIntent preserves the optional fields it does not name', async () => {
    await writeEngineIntent(projectPath, {
      desiredRunning: true,
      selfSupply: true,
      overseer: true,
      ...(SAMPLE as object),
    })
    await patchEngineIntent(projectPath, { overseer: false })
    const after = (await readEngineIntent(projectPath)) as unknown as Record<string, unknown>
    for (const k of optionalIntentKeys()) {
      expect(after[k], `${k} was dropped by an unrelated patch`).toEqual(SAMPLE[k])
    }
    expect(after.overseer).toBe(false)
  })

  it('an explicit false/null still CLEARS — preserve-by-default must not make a field unclearable', async () => {
    await writeEngineIntent(projectPath, {
      desiredRunning: true,
      selfSupply: false,
      overseer: false,
      ...(SAMPLE as object),
    })
    // The supply STOP route's shape.
    await patchEngineIntent(projectPath, { supplyDesired: false })
    expect((await readEngineIntent(projectPath)).supplyDesired).toBeUndefined()
    // …and the commander STOP route's, which has the same obligation: a desk the
    // owner just closed must not be resurrected by the next boot's auto-resume.
    await patchEngineIntent(projectPath, { managerDesired: false })
    expect((await readEngineIntent(projectPath)).managerDesired).toBeUndefined()
    // A new UTC day resets the counter through the same door.
    await patchEngineIntent(projectPath, { selfSupplyDayCount: 0 })
    expect((await readEngineIntent(projectPath)).selfSupplyDayCount).toBe(0)
    // The other optional field is untouched by those clears.
    expect((await readEngineIntent(projectPath)).selfSupplyDayKey).toBe(SAMPLE.selfSupplyDayKey)
  })
})

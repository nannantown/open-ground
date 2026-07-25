// card 2b — the OVERSEER RESTORE REMINDER, server side.
//
// Card 2 made a restart bring the drain back on its own, but deliberately NOT the
// overseer (it wakes an AI, types into running work, deletes branches — a restart is
// its one kill switch with no substitute layer: OVERSEER_DESIGN.md K2 / L9-③, pinned
// by swarmOrchestrator.resumeEngines.test.ts). This file pins the OTHER half of that
// decision: the asymmetry must be VISIBLE and one click from being undone, instead of
// silently dropped.
//
// Every test here is written to go RED under a specific mutation, named in its title
// or body — a green suite that survives reverting the fix proves nothing:
//   · `dismissOverseerReminder` → `setOverseer(path,false)`   (the d1d6d704 no-op trap)
//   · `startOrchestrator`'s patch → `persistEngineIntent`     (record erased on 再開)
//   · dropping `engine.autonomyResumed = true` in resumeEngines
//   · dropping the `overseerIntent` read in getOrchestratorState
//
// What it does NOT touch: the arm CONDITIONS. resumeEngines still never arms from
// disk, and setOverseer still refuses to arm a stopped engine — this card adds a
// display, never a new way in. Those invariants keep their own pins elsewhere.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import {
  resumeEngines,
  getOrchestratorState,
  startOrchestrator,
  stopOrchestrator,
  setOverseer,
  dismissOverseerReminder,
  defaultDeps,
  __resetOrchestratorForTests,
  type OrchestratorDeps,
  type IntegrationDeps,
  type AnomalyDeps,
} from './swarmOrchestrator'
import { writeEngineIntent, readEngineIntent } from './swarmEnginePersistence'
import { canonicalize } from './canonicalize'
import { forgetSwarmManualStop, forgetSwarmAutonomy } from './store'
import { settingsFile, engineBootsFile } from './paths'

// Real fs + canonicalize + settings I/O under parallel-vitest load can exceed the
// 5s default (reference_vitest_5s_default_is_the_flake_root). Pinned to the canonical
// ceiling (vitest.config.ts's 60s) — a shorter value here silently re-caps the global.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const preflightMock = vi.hoisted(() => ({ ok: true }))
vi.mock('./claudePreflight', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./claudePreflight')>()
  return {
    ...actual,
    claudeRunPreflight: async () => (preflightMock.ok ? { ok: true } : { ok: false, body: { error: 'not ready' } }),
  }
})

// A resumed/started engine kicks runEnginePass fire-and-forget; with the REAL
// defaultDeps() that reaches fetchTasks' loopback HTTP call (no server here). An
// empty-board stub keeps the pass from touching any other dep — zero cards ⇒ dispatch
// / monitor / integrate never spawn, move or verify anything.
const safeDeps = (): OrchestratorDeps & IntegrationDeps & AnomalyDeps => ({
  ...defaultDeps(),
  fetchTasks: async () => [],
})

let proj = ''

beforeEach(async () => {
  __resetOrchestratorForTests()
  preflightMock.ok = true
  proj = await mkdtemp(join(tmpdir(), 'og-overseer-banner-'))
  await writeFile(
    settingsFile(),
    JSON.stringify({
      projects: [{ id: randomUUID(), path: proj, addedAt: '2026-01-01T00:00:00.000Z' }],
    }),
  )
  await rm(engineBootsFile(), { recursive: true, force: true })
})

afterEach(async () => {
  __resetOrchestratorForTests()
  const key = await canonicalize(proj)
  await forgetSwarmManualStop(key)
  await forgetSwarmAutonomy(key)
  await rm(proj, { recursive: true, force: true })
  await writeFile(settingsFile(), JSON.stringify({ projects: [] }))
  await rm(engineBootsFile(), { recursive: true, force: true })
})

/** The state the banner is written for: engine.json remembers the overseer was
 *  armed, and the drain is running while the overseer is NOT.
 *
 *  Built with `startOrchestrator` rather than a full `resumeEngines` boot on
 *  purpose — the two produce the SAME observable state for these tests (running
 *  engine + `overseer:true` on disk + overseer disarmed), and the boot path drags in
 *  the roster reconcile + resume-candidate adoption, which under parallel-vitest
 *  load pushed single cases past 60s. The boot-specific facts (a resume never arms
 *  the overseer; `autonomyResumed` is set) are pinned with the REAL resume below and
 *  in swarmOrchestrator.resumeEngines.test.ts, so nothing is lost by keeping the
 *  cheap path here. */
const runningWithRememberedOverseer = async () => {
  await writeEngineIntent(proj, { desiredRunning: true, selfSupply: false, overseer: true })
  await startOrchestrator(proj, safeDeps())
  return getOrchestratorState(proj, safeDeps())
}

/** The real thing: a BOOT RESUME of a project whose engine.json remembers both the
 *  drain and the overseer. Used only where the boot path itself is the subject. */
const bootResumeWithRememberedOverseer = async () => {
  await writeEngineIntent(proj, { desiredRunning: true, selfSupply: false, overseer: true })
  await resumeEngines(safeDeps(), { listProjectPaths: async () => [proj] })
  return getOrchestratorState(proj, safeDeps())
}

describe('overseerRemembered — surfacing the restart asymmetry (完了条件1)', () => {
  it('surfaces engine.json\'s raw overseer:true while the overseer itself stays OFF — the banner\'s exact condition', async () => {
    const state = await runningWithRememberedOverseer()
    // The drain is on...
    expect(state.running).toBe(true)
    // ...the overseer did NOT (the invariant this card must not weaken)...
    expect(state.overseer).toBe(false)
    // ...and the fact that it WAS on is now visible, which is what card 2 dropped.
    // MUTATION: delete the `overseerIntent` read in getOrchestratorState ⇒ red.
    expect(state.overseerRemembered).toBe(true)
  })

  it('surfaces it with NO in-memory engine at all — the raw post-restart case the banner exists for', async () => {
    // Resume suppressed (preflight down): nothing in store.engines, but the record
    // on disk is still the owner's last intent. The banner must still appear —
    // reading it only off a live engine would lose exactly this case.
    preflightMock.ok = false
    await writeEngineIntent(proj, { desiredRunning: true, selfSupply: false, overseer: true })
    await resumeEngines(safeDeps(), { listProjectPaths: async () => [proj] })
    const state = await getOrchestratorState(proj, safeDeps())
    expect(state.running).toBe(false)
    expect(state.overseerRemembered).toBe(true)
  })

  it('stays false for a project that never armed the overseer (no false banner)', async () => {
    await writeEngineIntent(proj, { desiredRunning: true, selfSupply: false, overseer: false })
    await resumeEngines(safeDeps(), { listProjectPaths: async () => [proj] })
    const state = await getOrchestratorState(proj, safeDeps())
    expect(state.overseerRemembered).toBe(false)
  })

  it('stays false for a project with no engine.json at all (never started)', async () => {
    const state = await getOrchestratorState(proj, safeDeps())
    expect(state.overseerRemembered).toBe(false)
    expect(state.running).toBe(false)
  })
})

describe('[戻す] really arms — the one click has to do the thing (完了条件1)', () => {
  it('arming from the banner state turns the overseer ON and hides the banner', async () => {
    const booted = await runningWithRememberedOverseer()
    expect(booted.overseer).toBe(false) // banner up

    const armed = await setOverseer(proj, true, safeDeps())

    // The actual arm — not a cosmetic flag. MUTATION: wire the button to a no-op
    // (or to dismissOverseerReminder) ⇒ red here.
    expect(armed.overseer).toBe(true)
    // And it is the SAME thing GET reports, so the UI doesn't just believe an ack.
    const polled = await getOrchestratorState(proj, safeDeps())
    expect(polled.overseer).toBe(true)
    // Banner condition (`overseerRemembered && !overseer`) is now false ⇒ hidden,
    // while the record itself stays true so the NEXT restart still offers it.
    expect(polled.overseerRemembered).toBe(true)
    expect((await readEngineIntent(proj)).overseer).toBe(true)
  })

  it('a REFUSED arm (engine not running — the D1 gate) leaves the banner up instead of blanking it', async () => {
    // Resume suppressed ⇒ no running engine. setOverseer must still refuse (that gate
    // is untouched by this card), and the reminder must survive the refusal — a
    // banner that vanished on a refused click would strand the owner.
    preflightMock.ok = false
    await writeEngineIntent(proj, { desiredRunning: true, selfSupply: false, overseer: true })
    await resumeEngines(safeDeps(), { listProjectPaths: async () => [proj] })

    const refused = await setOverseer(proj, true, safeDeps())
    expect(refused.overseer).toBe(false) // D1: arming needs a running engine
    expect(refused.overseerRemembered).toBe(true) // ...and the offer is still standing
    expect((await readEngineIntent(proj)).overseer).toBe(true)
  })
})

describe('[×] dismiss is NOT a no-op (完了条件2 — the d1d6d704 trap, one toggle over)', () => {
  it('the trap is REAL: setOverseer(false) in the banner state writes NOTHING — this is why dismiss needs its own action', async () => {
    await runningWithRememberedOverseer()
    expect((await readEngineIntent(proj)).overseer).toBe(true)

    // What the "obvious" implementation would do. The overseer is ALREADY disarmed
    // while the banner is up, so setOverseer's change-guard skips its whole body —
    // including the persist. The record survives, the next poll re-shows the banner,
    // and [×] is a button the owner can press forever. (Verbatim d1d6d704, one
    // toggle over.) This assertion documents the trap and is what makes the next
    // test's pass meaningful rather than accidental.
    const viaToggle = await setOverseer(proj, false, safeDeps())
    expect(viaToggle.overseer).toBe(false) // "looks right"...
    expect((await readEngineIntent(proj)).overseer).toBe(true) // ...but nothing changed

    // Reading it back through the real poll: the banner would still be there.
    expect((await getOrchestratorState(proj, safeDeps())).overseerRemembered).toBe(true)
  })

  it('dismissOverseerReminder DOES clear the record — the banner is gone for good', async () => {
    await runningWithRememberedOverseer()

    const after = await dismissOverseerReminder(proj, safeDeps())

    // MUTATION: implement this as `setOverseer(projectPath, false)` ⇒ both of these
    // go red (the test above shows why: that path never reaches the persist).
    expect((await readEngineIntent(proj)).overseer).toBe(false)
    expect(after.overseerRemembered).toBe(false)
    // ...and it stays gone across the poll, which is where the old bug showed up.
    expect((await getOrchestratorState(proj, safeDeps())).overseerRemembered).toBe(false)
  })

  it('dismissing does not stop the engine or touch any OTHER intent — declining a banner is not a shutdown', async () => {
    await writeEngineIntent(proj, { desiredRunning: true, selfSupply: true, overseer: true })
    await resumeEngines(safeDeps(), { listProjectPaths: async () => [proj] })

    const after = await dismissOverseerReminder(proj, safeDeps())

    expect(after.running).toBe(true)
    expect(after.selfSupply).toBe(true)
    // The neighbouring fields on disk are untouched — patch, not a full write.
    const intent = await readEngineIntent(proj)
    expect(intent.desiredRunning).toBe(true)
    expect(intent.selfSupply).toBe(true)
    expect(intent.overseer).toBe(false)
  })

  it('works with NO in-memory engine (the common post-restart case) and is idempotent', async () => {
    preflightMock.ok = false
    await writeEngineIntent(proj, { desiredRunning: true, selfSupply: false, overseer: true })
    await resumeEngines(safeDeps(), { listProjectPaths: async () => [proj] })

    const first = await dismissOverseerReminder(proj, safeDeps())
    expect(first.overseerRemembered).toBe(false)
    expect((await readEngineIntent(proj)).overseer).toBe(false)
    // desiredRunning must survive — dismissing a reminder is not a stop, even when
    // there is no engine object to protect it.
    expect((await readEngineIntent(proj)).desiredRunning).toBe(true)

    const second = await dismissOverseerReminder(proj, safeDeps())
    expect(second.overseerRemembered).toBe(false)
  })
})

describe('the record survives long enough to be pressed', () => {
  it('turning autonomy ON does NOT erase the overseer record — the suppressed-boot path where the banner mattered most', async () => {
    // Boot resume suppressed ⇒ the owner sees BOTH banners and presses 再開 first.
    // MUTATION: restore `persistEngineIntent(engine, projectPath)` in
    // startOrchestrator ⇒ red (a full write derives `overseer` from this fresh
    // engine's in-memory false and wipes the record before it can be used).
    preflightMock.ok = false
    await writeEngineIntent(proj, { desiredRunning: true, selfSupply: false, overseer: true })
    await resumeEngines(safeDeps(), { listProjectPaths: async () => [proj] })
    expect((await getOrchestratorState(proj, safeDeps())).running).toBe(false) // resume suppressed
    preflightMock.ok = true // the owner fixed the environment, then pressed ON

    const started = await startOrchestrator(proj, safeDeps())
    expect(started.running).toBe(true)
    expect(started.overseerRemembered).toBe(true)
    expect((await readEngineIntent(proj)).overseer).toBe(true)
    // ...and the drain intent it DOES own was still written.
    expect((await readEngineIntent(proj)).desiredRunning).toBe(true)
    // The offer is still live: one click and the overseer is back.
    expect((await setOverseer(proj, true, safeDeps())).overseer).toBe(true)
  })

  it('an explicit autonomy OFF clears it (the D1 asymmetry) — nothing left to restore', async () => {
    await runningWithRememberedOverseer()
    const stopped = await stopOrchestrator(proj, safeDeps())
    expect(stopped.overseerRemembered).toBe(false)
    expect((await readEngineIntent(proj)).overseer).toBe(false)
  })
})

describe('autonomyResumed — "this was restored" stays visible after card 2 (完了条件5)', () => {
  it('is true for a boot-resumed engine, where the old !running reminder can no longer fire', async () => {
    // The REAL boot path — this test's whole subject, so no cheap substitute here.
    const state = await bootResumeWithRememberedOverseer()
    expect(state.running).toBe(true)
    // ...and the resume STILL did not arm the overseer (the invariant this card
    // must not weaken — its primary pin is in swarmOrchestrator.resumeEngines.test.ts).
    expect(state.overseer).toBe(false)
    // The old banner condition — dead for a resumed project since card 2. Pinned so
    // nobody "fixes" the new notice by reviving a condition that cannot be true here.
    expect(state.autonomyRemembered && !state.running).toBe(false)
    // MUTATION: drop `engine.autonomyResumed = true` in resumeEngines ⇒ red.
    expect(state.autonomyResumed).toBe(true)
  })

  it('is FALSE after a plain manual ON — a manual start restored nothing and must not claim to have', async () => {
    const started = await startOrchestrator(proj, safeDeps())
    expect(started.running).toBe(true)
    expect(started.autonomyResumed).toBe(false)
    expect((await getOrchestratorState(proj, safeDeps())).autonomyResumed).toBe(false)
  })

  it('is cleared once the owner touches the power switch — the notice never outlives the fact', async () => {
    expect((await bootResumeWithRememberedOverseer()).autonomyResumed).toBe(true)
    // OFF, then ON by hand: this engine's state is the owner's now, not a restored one.
    await stopOrchestrator(proj, safeDeps())
    const restarted = await startOrchestrator(proj, safeDeps())
    expect(restarted.running).toBe(true)
    expect(restarted.autonomyResumed).toBe(false)
    expect((await getOrchestratorState(proj, safeDeps())).autonomyResumed).toBe(false)
  })

  it('is false for a never-started project', async () => {
    expect((await getOrchestratorState(proj, safeDeps())).autonomyResumed).toBe(false)
  })
})

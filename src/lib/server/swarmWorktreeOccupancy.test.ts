// ONE DESK PER WORKTREE — the guard that was missing on 2026-08-03.
//
// WHAT HAPPENED (observed on the owner's machine, 0.11.49, packaged app):
// a card was sent back review→doing while its SDK worker was still editing
// files. A restart came in for that card. spawnSwarmWorker's RESTART path
// reuses the existing worktree and asked NOTHING about who was already there,
// so a second claude started in the same directory, on the same `swarm/*`
// branch. It degraded to PTY because the SDK slot read 1/1 full — held by the
// very worker nobody had looked for — and the engine log carried no `dispatch:`
// line, because the engine had not dispatched it. Two claudes, one working tree,
// invisible in the one place anyone was watching.
//
// The owner found it by noticing an unexpected Remote Control session on their
// phone. Nine review rounds, the full suite, tsc and lint had all been green.
//
// WHY THESE TESTS ARE SHAPED LIKE THIS
// The failure was never "the check returned the wrong answer" — it was "there
// was no check, and the only check nearby would have been PTY-shaped". So the
// tests below assert the two things that actually failed:
//   1. occupancy is judged from BOTH pools (an SDK-only occupant must count —
//      it holds no terminalId, which is exactly why a PTY-shaped test misses it)
//   2. the spawn REFUSES rather than proceeding
//
// Proven RED against the pre-fix source (2026-08-03): with the
// `liveDeskOccupies` gate deleted from spawnSwarmWorker, the two spawn tests
// fail; with `isDirOccupied`'s separator dropped, the sibling test fails; with
// `canonicalLiveDeskCwds` left un-canonicalized, the symlink test fails.

import { describe, it, expect } from 'vitest'
import { sep } from 'path'
import { canonicalLiveDeskCwds, isDirOccupied, liveDeskOccupies } from './liveDesks'

const WT = `${sep}wt${sep}swarm${sep}card-a`

describe('isDirOccupied — the one place the comparison is written', () => {
  it('a desk sitting AT the worktree occupies it', () => {
    expect(isDirOccupied([WT], WT)).toBe(true)
  })

  it('a desk that cd-ed DEEPER into the worktree still occupies it', () => {
    // A worker running a build from a subdirectory is still in the tree. Reading
    // this as "free" is what would let a second claude in behind it.
    expect(isDirOccupied([`${WT}${sep}src${sep}lib`], WT)).toBe(true)
  })

  it('a SIBLING whose name merely starts the same way does NOT occupy it', () => {
    // The separator in the prefix test is load-bearing: without it `card-a2`
    // would lock `card-a`, and every restart in the project would be refused —
    // a guard that blocks everything gets deleted, which is how the hole reopens.
    expect(isDirOccupied([`${WT}2`], WT)).toBe(false)
    expect(isDirOccupied([`${WT}-old`], WT)).toBe(false)
  })

  it('an empty pool occupies nothing', () => {
    expect(isDirOccupied([], WT)).toBe(false)
  })
})

describe('canonicalLiveDeskCwds — symlinks must not read as "free"', () => {
  it('canonicalizes every cwd before it is compared', async () => {
    // ~/.openground is routinely a symlinked home on this machine, and the two
    // pools store whatever spawn cwd they were handed. Comparing raw against
    // canonical is how an occupied tree reads as empty — the same failure
    // worktreeCleanup's guard was built to prevent, in the other direction.
    const canon = async (p: string) => p.replace(`${sep}sym`, `${sep}real`)
    const cwds = await canonicalLiveDeskCwds({
      listCwds: () => [`${sep}sym${sep}wt${sep}a`, `${sep}real${sep}wt${sep}b`],
      canon,
    })
    expect(cwds).toEqual([`${sep}real${sep}wt${sep}a`, `${sep}real${sep}wt${sep}b`])
  })

  it('an occupant whose POOL cwd is the symlinked form still counts as occupying', async () => {
    // The direction matters, and the first version of this test had it backwards:
    // it canonicalized the DIR only, which the fix does anyway, so the assertion
    // stayed green with `canonicalLiveDeskCwds` gutted (measured 2026-08-03).
    // Production stores the RAW spawn cwd in each pool (createTerminal keeps
    // opts.cwd verbatim), so the symlinked form is on the OCCUPANT side — which
    // is the side that has to be canonicalized for the comparison to land.
    const canon = async (p: string) => p.replace(`${sep}sym`, `${sep}real`)
    await expect(
      liveDeskOccupies(`${sep}real${sep}wt${sep}a`, {
        listCwds: () => [`${sep}sym${sep}wt${sep}a`],
        canon,
      }),
    ).resolves.toBe(true)
  })
})

describe('liveDeskOccupies asks BOTH pools', () => {
  it('an SDK-only occupant counts — it holds no terminalId to be found by', async () => {
    // THE ACTUAL 0803 SHAPE. The incumbent was an SDK session; any check built on
    // the PTY pool sees an empty directory and says "go ahead".
    await expect(
      liveDeskOccupies(WT, { listCwds: () => [WT], canon: async (p) => p }),
    ).resolves.toBe(true)
  })

  it('a free worktree is free', async () => {
    await expect(
      liveDeskOccupies(WT, { listCwds: () => [], canon: async (p) => p }),
    ).resolves.toBe(false)
  })
})

describe('the RESTART path refuses to seat a second desk', () => {
  it('spawnSwarmWorker consults liveDeskOccupies and throws WorktreeOccupiedError', async () => {
    // A SOURCE PIN, not a behavioural run: reaching the real spawn needs a git
    // repo, a registered project, the guard wiring and a launchable claude — a
    // mock deep enough to get there would be asserting against the mock. What
    // must never regress is narrow and checkable: the restart branch asks the
    // both-pools seam, and refuses on yes.
    const { readFileSync } = await import('fs')
    const src = readFileSync(new URL('./swarmWorker.ts', import.meta.url), 'utf8')
      .replace(/\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
    expect(src, 'the restart path must ask the both-pools seam').toMatch(
      /opts\.worktree && \(await liveDeskOccupies\(worktree\)\)/,
    )
    expect(src, 'and refuse, not warn').toMatch(/throw new WorktreeOccupiedError\(worktree\)/)
    // It must be the SEAM, never a PTY-shaped stand-in — that substitution is
    // precisely the defect, and it would leave every assertion above still green.
    expect(
      src,
      'a PTY-only occupancy test would miss an SDK incumbent — the 0803 bug exactly',
    ).not.toMatch(/listActiveTerminalCwds\(\)[\s\S]{0,80}worktree/)
  })

  it('the route reports the refusal as 409, not 500', async () => {
    // A 500 reads as "the server fell over" and invites a retry loop against a
    // healthy, occupied worktree — which is how one twin becomes several.
    const { readFileSync } = await import('fs')
    const src = readFileSync(
      new URL('../../../server/routes/swarm.ts', import.meta.url),
      'utf8',
    )
    expect(src).toMatch(/e instanceof WorktreeOccupiedError/)
    expect(src).toMatch(/occupied: true \}, 409\)/)
  })
})

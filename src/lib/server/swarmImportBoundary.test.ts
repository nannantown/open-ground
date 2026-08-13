// THE IMPORT BOUNDARY IS AN EXEMPTION LIST. THIS PINS WHICH WAY IT MAY MOVE.
//
// `.eslintrc.cjs` bans every direct import of a desk pool (`terminal.ts` /
// `sdkSession.ts`) and then exempts three sets of files. Two of them are
// structural — the seams, and the files that belong to one runtime by
// construction. The third, BOTH_POOLS_DEBT, is a list of engine files that
// reach both pools directly today and should route through the seams instead.
//
// A debt list with nothing holding it is a place to put the next violation. So:
// it may SHRINK freely, and it may not GROW without changing the number below,
// which is a visible edit in a diff and cannot be done by accident.
//
// (This is the OPEN_BUDGET shape from workerAddressingInventory.test.ts, applied
//  to the other allowlist. Same reason: an allowlist nobody counts stops being
//  an allowlist and becomes a habit.)

import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import { join } from 'path'
import { SEAMS, PTY_BY_DESIGN, BOTH_POOLS_DEBT } from '../../../scripts/importBoundary.cjs'

const repoRoot = join(__dirname, '..', '..', '..')

// THIS NUMBER MAY ONLY GO DOWN.
// Lowered 9 → 8 on 2026-08-13: swarmWorkerRuntimeDial.ts was deleted with the
// PTY worker runtime — debt paid down by removing the debtor.
const DEBT_BUDGET = 8

describe('the desk-pool import boundary', () => {
  it('every exempted path still exists — a stale entry silently un-bans nothing', () => {
    // A path that no longer exists is not harmless: it reads as "this file was
    // reviewed and allowed", so the next reader trusts a list that is partly
    // fiction. It also hides a rename, which is exactly when a file's reason for
    // being exempt is most likely to have stopped being true.
    const missing = [...SEAMS, ...PTY_BY_DESIGN, ...BOTH_POOLS_DEBT].filter(
      (rel: string) => !existsSync(join(repoRoot, rel)),
    )
    expect(
      missing,
      `These paths are exempted from the desk-pool import ban but do not exist.\n` +
        `Either the file moved (re-check WHY it was exempt before re-adding it) or the\n` +
        `entry is dead and should be deleted:\n  ${missing.join('\n  ')}`,
    ).toEqual([])
  })

  it('the DEBT list may only shrink', () => {
    expect(
      BOTH_POOLS_DEBT.length,
      `BOTH_POOLS_DEBT has ${BOTH_POOLS_DEBT.length} entries against a budget of ` +
        `${DEBT_BUDGET}.\n\n` +
        `Each entry is a file that reaches BOTH desk pools directly instead of going\n` +
        `through workerRuntime / liveDesks — i.e. a place where the defect class this\n` +
        `boundary exists to close can still be written by hand. Nine review rounds\n` +
        `produced 15+ instances of it, each at a NEW call site.\n\n` +
        `If you are PAYING debt down: lower DEBT_BUDGET to the new length. That is the\n` +
        `only edit this assertion is here to make easy.\n\n` +
        `If you are ADDING a file: stop. Route it through the seams. If it genuinely\n` +
        `cannot, raising this number is a deliberate, reviewable act — write in the\n` +
        `commit message what the file needs that the seams do not offer.`,
    ).toBeLessThanOrEqual(DEBT_BUDGET)
  })

  it('the budget is not slack — it equals today, so the next addition is visible', () => {
    // A budget set above the current length is a free slot: someone adds a file,
    // nothing goes red, and the ratchet has already failed once before anybody
    // reads it.
    expect(DEBT_BUDGET).toBe(BOTH_POOLS_DEBT.length)
  })

  it('no file is exempt twice — the three kinds mean different things', () => {
    // SEAMS may see both pools. PTY_BY_DESIGN may see one and is still BANNED
    // from the other. DEBT is off entirely. A path in two lists gets whichever
    // override ESLint applies last, so the reason written beside it may not be
    // the rule actually in force.
    const all = [...SEAMS, ...PTY_BY_DESIGN, ...BOTH_POOLS_DEBT]
    const dupes = all.filter((p: string, i: number) => all.indexOf(p) !== i)
    expect(dupes, `exempted in more than one list: ${dupes.join(', ')}`).toEqual([])
  })

  it('the seams are all present — the ban is only safe because there is another way to ask', () => {
    // If workerRuntime or liveDesks were dropped from the exemptions they would
    // fail lint, someone would "fix" it by exempting their callers instead, and
    // the boundary would invert: every call site allowed, the seams unused.
    for (const required of [
      'src/lib/server/workerRuntime.ts',
      'src/lib/server/liveDesks.ts',
      'src/lib/server/terminal.ts',
      'src/lib/server/sdkSession.ts',
    ]) {
      expect(SEAMS, `${required} must be exempt: it IS the seam`).toContain(required)
    }
  })
})

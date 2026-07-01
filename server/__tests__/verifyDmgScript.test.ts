import { describe, it, expect } from 'vitest'
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Regression guard for scripts/verify-dmg.sh — the dmg-verification footguns from
// the 2026-06-25 release post-mortem (memory reference_og_dmg_verify_and_autoupdate).
// The script is the runtime fix; this test locks its SHAPE so a later "simplify"
// can't quietly reintroduce the exact mistakes that caused a phantom-downgrade panic:
//   (2) selecting the mounted volume by listing /Volumes (grabs the wrong dmg), and
//   (3) reading architecture with `uname -m` (misreads under Rosetta).
// These are coarse source assertions, but they have teeth: each one maps to a real
// incident, and reverting to the footgun turns the suite red.

const SCRIPT = fileURLToPath(new URL('../../scripts/verify-dmg.sh', import.meta.url))
const src = readFileSync(SCRIPT, 'utf8')
const lines = src.split('\n')
// Strip comments so we assert against ACTUAL shell, not the cautionary tale in the
// header (which deliberately names the footguns).
const code = lines
  .map((l) => l.replace(/#.*$/, ''))
  .filter((l) => l.trim().length > 0)
  .join('\n')

describe('scripts/verify-dmg.sh shape', () => {
  it('exists and is executable', () => {
    const mode = statSync(SCRIPT).mode
    expect(mode & 0o111, 'verify-dmg.sh must have an executable bit').not.toBe(0)
  })

  it('FOOTGUN #2: derives the volume from hdiutil attach output, not from listing /Volumes', () => {
    // It must actually attach and parse the mount point out of the attach output.
    expect(code).toMatch(/hdiutil attach/)
    expect(code).toMatch(/attach_out/)
    expect(code).toMatch(/grep -oE '\/Volumes\//)
    // It must NOT pick the volume by listing /Volumes (the wrong-dmg footgun): no
    // line may reference /Volumes via `ls`. (Listing the .app INSIDE the resolved
    // $VOL is fine — that never touches /Volumes.)
    const volumesByLs = code
      .split('\n')
      .filter((l) => l.includes('/Volumes') && /\bls\b/.test(l))
    expect(volumesByLs, 'must not select the volume by `ls /Volumes`').toEqual([])
    // Positive teeth: the VOL assignment itself must derive from the attach output +
    // grep, not merely have `attach_out`/`grep` tokens lying around elsewhere. This
    // catches a footgun that keeps dead tokens but picks VOL via an `echo`/`for`
    // glob over /Volumes (which the `ls` filter above would miss).
    const volAssign = code.split('\n').find((l) => /^\s*VOL=/.test(l)) || ''
    expect(volAssign, 'a VOL= assignment must exist').not.toBe('')
    expect(volAssign).toMatch(/attach_out/)
    expect(volAssign).toMatch(/grep -oE '\/Volumes\//)
  })

  it('FOOTGUN #3: reads architecture via sysctl + lipo, never `uname -m`', () => {
    expect(code).toMatch(/sysctl -n hw\.optional\.arm64/)
    expect(code).toMatch(/\blipo\b/)
    // `uname -s` (OS gate) is fine; `uname -m` (machine) is the Rosetta footgun.
    expect(code).not.toMatch(/uname\s+-m\b/)
  })

  it('always detaches the volume (trap on EXIT) so verification never leaks a mount', () => {
    expect(code).toMatch(/trap\s+\w+\s+EXIT/)
    expect(code).toMatch(/hdiutil detach/)
  })
})

import { describe, it, expect } from 'vitest'
import { getSettings, getWorkerTrials, normalizeWorkerTrials, setUserSettings } from './store'

// Settings.workerTrials — the off-by-default switch behind the worker-directive
// trials (docs/trending/TRIALS.md §Trial 4).
//
// WHY THIS IS TESTED AT THE STORE, not just at the directive. The owner's rule is
// "have a way to put it back", and the way back is this flag. Two failure modes
// would break that promise quietly:
//   • a forged truthy value ("1", "true", 1) turning a trial on — the same
//     narrowing lockdownMode and swarmOptIn already do, for the same reason;
//   • an unknown key persisting, so a flag outlives the trial that owned it and
//     a later reader resurrects a directive nobody chose.
// Both are asserted through the PRODUCTION reader (getWorkerTrials), not by
// reading the file, so "it was written" cannot pass for "it takes effect".

describe('normalizeWorkerTrials', () => {
  it('keeps only literal true', () => {
    expect(normalizeWorkerTrials({ brevity: true, thinkInCode: true })).toEqual({
      brevity: true,
      thinkInCode: true,
    })
    expect(normalizeWorkerTrials({ brevity: false })).toEqual({})
  })

  it('refuses forged truthy values — a string must not turn a trial on', () => {
    expect(normalizeWorkerTrials({ brevity: 'true' })).toEqual({})
    expect(normalizeWorkerTrials({ brevity: 1 })).toEqual({})
    expect(normalizeWorkerTrials({ thinkInCode: 'yes' })).toEqual({})
  })

  it('drops unknown keys so a dead flag cannot outlive its trial', () => {
    expect(normalizeWorkerTrials({ brevity: true, somethingElse: true })).toEqual({ brevity: true })
  })

  it('treats a non-object as all-off rather than throwing', () => {
    for (const v of [undefined, null, 'x', 7, [], [{ brevity: true }]]) {
      expect(normalizeWorkerTrials(v)).toEqual({})
    }
  })
})

describe('Settings.workerTrials persistence (setUserSettings)', () => {
  it('defaults to every trial off', async () => {
    expect(await getWorkerTrials()).toEqual({})
  })

  it('round-trips through the POST allowlist and the production reader', async () => {
    const applied = await setUserSettings({ workerTrials: { brevity: true, thinkInCode: true } })
    expect(applied).toContain('workerTrials')
    expect(await getWorkerTrials()).toEqual({ brevity: true, thinkInCode: true })
  })

  it('turning a trial back off is a POST, not a code change (the revert path)', async () => {
    await setUserSettings({ workerTrials: { brevity: true, thinkInCode: true } })
    await setUserSettings({ workerTrials: { thinkInCode: true } })
    expect(await getWorkerTrials()).toEqual({ thinkInCode: true })
    await setUserSettings({ workerTrials: {} })
    expect(await getWorkerTrials()).toEqual({})
  })

  it('narrows a forged body on the way in, not only on the way out', async () => {
    await setUserSettings({ workerTrials: { brevity: 'true', thinkInCode: 1 } })
    expect((await getSettings()).workerTrials).toEqual({})
    expect(await getWorkerTrials()).toEqual({})
  })

  it('still refuses to widen the project allowlist through the same body', async () => {
    // The route's security property, re-checked here because this test writes
    // through the same seam: workerTrials is settable, `projects` never is.
    const before = (await getSettings()).projects
    await setUserSettings({ workerTrials: { brevity: true }, projects: [{ id: 'x', path: '/etc', addedAt: 0 }] })
    expect((await getSettings()).projects).toEqual(before)
  })
})

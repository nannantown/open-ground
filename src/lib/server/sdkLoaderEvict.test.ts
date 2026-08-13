// A FAILED SDK IMPORT MUST NOT BE MEMOISED FOR THE LIFE OF THE PROCESS.
//
// WHY THIS FILE EXISTS. The loader deliberately NEVER REJECTS — it catches and
// records the reason so `spawnSdkSession` can re-throw it synchronously and the
// callers can fail the spawn with it. The trap is that `sdkLoad ??= …` then
// memoises a promise that RESOLVED, so a failure looks like a completed load
// and nothing ever retries. One transient miss — EMFILE, an NFS blip, a
// dispatch racing an install — would mean every worker spawn on the machine
// FAILS until the app is restarted (in the fallback era: every worker silently
// ran as a PTY, announced only in `fellBackBecause`, which nobody read while
// workers were "just working"), and in a packaged app the server lives as long
// as the app does.
//
// This repository has written this rule down twice already — paths.ts:203-209
// ("EVICT ON REJECTION … `??=` alone caches a REJECTED promise forever") and
// registry.ts:39-42 before it. This file is the third site, with teeth.
//
// The second trap is downstream: `quotaPrefixes` memoises `[]` when the module
// is missing, and `[]` is TRUTHY, so a load that later succeeds would come back
// with quota detection permanently — and silently — switched off. Recovering the
// module without recovering the vocabulary is not recovering.

import { afterEach, describe, expect, it } from 'vitest'
import { __setSdkImporterForTests, preloadSdk } from './sdkSession'

/** A stand-in for the real ESM namespace, with enough content that the test can
 *  tell "the module came back" from "something came back". */
const stubSdk = (prefixes: string[]) => ({
  query: () => {
    throw new Error('unused — this test never spawns')
  },
  USAGE_LIMIT_ERROR_PREFIXES: prefixes,
})

afterEach(() => {
  __setSdkImporterForTests(null)
})

describe('the SDK module loader evicts a failed load', () => {
  it('retries after a transient failure, and the quota vocabulary recovers with it', async () => {
    let attempts = 0
    __setSdkImporterForTests(() => {
      attempts += 1
      return attempts === 1
        ? Promise.reject(new Error('EMFILE: too many open files'))
        : Promise.resolve(stubSdk(['Claude usage limit reached', 'upgrade to']))
    })

    const first = await preloadSdk()
    expect(first.loaded).toBe(false)
    expect(first.error).toMatch(/EMFILE/)

    const second = await preloadSdk()
    expect(attempts, 'the failure was memoised — the loader never tried again').toBe(2)
    expect(second.loaded, `still failing after a recoverable error: ${second.error ?? ''}`).toBe(true)
    // The other half of the eviction. Without it this is 0 while `loaded` is
    // true — a recovered SDK whose refusal vocabulary is empty, i.e. quota
    // parking that can never fire.
    expect(second.quotaPrefixCount).toBe(2)
  })

  it('still loads only ONCE while it is succeeding', async () => {
    // The guard in the other direction: "retry on failure" must not become
    // "re-import on every spawn", which would put a dynamic import on the hot
    // path of every dispatch.
    let attempts = 0
    __setSdkImporterForTests(() => {
      attempts += 1
      return Promise.resolve(stubSdk(['x']))
    })

    await preloadSdk()
    await preloadSdk()
    await preloadSdk()
    expect(attempts).toBe(1)
  })

  it('reports the reason of the LATEST attempt, not the first', async () => {
    // `sdkLoadError` has to be cleared by a success and rewritten by a new
    // failure, or the spawn failure quotes a stale sentence that no longer
    // explains anything the owner can act on.
    const reasons = ['first failure', 'second failure']
    let attempts = 0
    __setSdkImporterForTests(() => Promise.reject(new Error(reasons[attempts++] ?? 'later')))

    expect((await preloadSdk()).error).toMatch(/first failure/)
    expect((await preloadSdk()).error).toMatch(/second failure/)
  })
})

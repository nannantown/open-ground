import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// THE ROOT-CAUSE LINE (2026-11-17). Global saved-work asserts ahead of
// resumeEngines meant one stale receipt anywhere stopped every project's
// president / commander / autopilot from coming back, boot after boot. Every
// resumeEngines test calls resumeEngines directly, so putting those asserts
// back in the boot hook stayed green. Here the asserts throw exactly as they do
// with a stale receipt on disk — re-adding any of them before resumeEngines
// turns this red.
const calls = vi.hoisted(() => ({ resume: 0, loop: 0, retry: [] as unknown[] }))
vi.mock('./swarmOrchestrator', () => ({
  resumeEngines: async () => { calls.resume++ },
  // A full retry pass can take minutes (adoptions); the hook must not wait for it.
  retryBootResumes: (opts?: unknown) => { calls.retry.push(opts); return new Promise(() => {}) },
  startAutoDrainLoop: () => {},
  bootAutoDrainEnabled: () => false,
}))
vi.mock('./automationPolicy', () => ({ startAutomationPolicyLoop: () => { calls.loop++ } }))
vi.mock('./runtimeTransitionStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./runtimeTransitionStore')>()),
  runtimeAdmissionBlocked: () => false,
}))
const stale = () => { throw new Error('A previous tool operation has an unconfirmed result.') }
vi.mock('./runtimeActionReceipts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./runtimeActionReceipts')>()),
  assertNoUncertainRuntimeActions: async () => stale(),
}))
vi.mock('./presidentInbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./presidentInbox')>()),
  awaitPresidentInputSettlement: async () => stale(),
}))

import { bootResumeOnRecoveryChange, __resetBootResumeHookForTests } from './bootResumeHook'
import { registerRuntimeRecoveryResume, notifyRuntimeRecoveryChanged } from './runtimeRecoveryBoot'

beforeEach(() => {
  __resetBootResumeHookForTests()
  calls.resume = 0; calls.loop = 0; calls.retry = []
})

describe('boot resume hook (2026-11-17 root cause)', () => {
  it('a stale unconfirmed result in some project does not stop resumeEngines or the policy loop', async () => {
    await bootResumeOnRecoveryChange(Promise.resolve(true))
    expect(calls.resume).toBe(1)
    expect(calls.loop, 'the retry loop starts, so held actors come back later').toBe(1)
  })

  it('after the first run, a recovery change retries owner-only holds without waiting for the pass', async () => {
    await bootResumeOnRecoveryChange(Promise.resolve(true))
    const settled = await Promise.race([
      bootResumeOnRecoveryChange(Promise.resolve(true)).then(() => true),
      new Promise((r) => setTimeout(() => r(false), 500)),
    ])
    expect(settled, 'an AI-switch settle must not wait out a full retry').toBe(true)
    expect(calls.retry).toEqual([{ ownerReview: true }])
    expect(calls.resume).toBe(1)
  })

  it('server/index.ts registers exactly this hook, with no saved-work assert of its own', () => {
    const entry = readFileSync(resolve(__dirname, '../../../server/index.ts'), 'utf8')
    expect(entry).toContain('registerRuntimeRecoveryResume(() => bootResumeOnRecoveryChange(runtimeRecoveryReady))')
    expect(entry).not.toMatch(/assertNoUncertainRuntimeActions|awaitPresidentInputSettlement|assertSavedSwarmRuntimeSafe/)
  })
})

describe('runtime recovery re-notify (2026-11-17 review)', () => {
  it('a review that lands while the boot resume is still running is not lost', async () => {
    let release!: () => void
    let runs = 0
    registerRuntimeRecoveryResume(async () => { runs++; if (runs === 1) await new Promise<void>((r) => { release = r }) })
    const first = notifyRuntimeRecoveryChanged()
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    void notifyRuntimeRecoveryChanged() // the owner reviews mid-pass
    release()
    await first
    expect(runs, 'the review runs the hook once more after the pass').toBe(2)
  })
})

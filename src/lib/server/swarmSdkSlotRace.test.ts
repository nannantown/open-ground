// @vitest-environment node
//
// THE SDK SLOT CAP IS A CHECK-THEN-ACT PAIR — NOTHING MAY AWAIT BETWEEN THE TWO.
//
// WHY THIS FILE EXISTS. `chooseWorkerRuntime` COUNTS the live SDK worker
// sessions in the pool against `sdkMaxWorkers` and hands back a decision; the
// seat that decision grants is taken later, by `spawnSdkSession`. There is no
// spawn lock on the worker path (the board lock is the card's CAS, and the
// commander's per-project lock covers only the commander), so the cap holds for
// exactly one reason: every statement between the count and the seat is
// synchronous, which makes the pair indivisible against other dispatches.
//
// Making the ESM SDK loadable from the CJS bundle nearly cost that. The loader
// is necessarily async, and the obvious place to await it is right next to the
// spawn it feeds — which drops an `await` INSIDE the region. Measured: the first
// import takes ~178ms, and even a warm one yields a microtask. Two concurrent
// dispatches (two curl-direct `POST /api/swarm/worker`, or the engine's dispatch
// pass overlapping a manual one) would then both read live=0 and both sit down
// with a limit of 1 — worst right after boot, when the import is cold and the
// commander is draining a queue of cards.
//
// TEETH: drives the real `spawnSwarmWorker` (real git worktrees), the real pool,
// and the real dial. It parks BOTH dispatches inside `preloadSdk` and only then
// lets them go, so it does not depend on timing: with the await hoisted above
// the count, the second dispatch cannot help but see the first one seated.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { mkdtemp, rm, realpath, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const execFile = promisify(execFileCb)
const git = (cwd: string, args: string[]) =>
  execFile('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })

// The gate every dispatch parks on, standing in for the module import.
let arrivals = 0
let openGate: (() => void) | null = null
let gate: Promise<void> = Promise.resolve()

const launched: { cwd?: string }[] = []
vi.mock('./claudeTerminal', () => ({
  launchClaude: (opts: { cwd?: string }) => {
    launched.push({ cwd: opts?.cwd })
    return { terminalId: 'pty-fallback' }
  },
}))
vi.mock('./hooksInstall', () => ({ ensureGuardWiring: async () => ({ ok: true, problems: [] }) }))
vi.mock('./experiments', () => ({ isExperimentEnabled: async () => false }))
vi.mock('./swarmLaunch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./swarmLaunch')>()),
  resolveSwarmModelEffortProbed: async () => ({ model: 'sonnet', effort: 'medium' }),
  resolveSwarmRemoteName: async () => 'worker',
}))
vi.mock('./swarmWorkerSdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./swarmWorkerSdk')>()),
  sdkWorkerPreflight: () => ({ ok: true, problems: [], claudeBin: '/usr/local/bin/claude', cliVersion: '2.1.220' }),
  sdkWorkerLaunchPlan: () => ({ options: {}, initialPrompt: '/order go', warnings: [] }),
}))
// ONLY `preloadSdk` is replaced. `spawnSdkSession` and `listSdkSessions` stay
// REAL and share the real pool, because the whole question is whether the seat
// the first dispatch takes is visible to the count the second one makes.
vi.mock('./sdkSession', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sdkSession')>()),
  preloadSdk: async () => {
    arrivals += 1
    await gate
    return { loaded: true, quotaPrefixCount: 1 }
  },
}))

import { spawnSwarmWorker } from './swarmWorker'
import { addProjectEntry, __resetMigrationCacheForTests } from './registry'
import { setSettings } from './store'
import {
  __resetSdkSessionsForTests,
  __setDefaultQueryFnForTests,
  __setQuotaPrefixesForTests,
  listSdkSessions,
} from './sdkSession'

/** A session that starts and then simply never ends — so it stays live in the
 *  pool and occupies its slot for the duration of the test. */
const neverEnding = () => ({
  [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<unknown>>(() => {}) }),
})

const until = async (cond: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 400; i++) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`timed out waiting for ${what}`)
}

let scratch: string
let project: string

beforeEach(async () => {
  launched.length = 0
  arrivals = 0
  gate = new Promise<void>((r) => (openGate = r))
  __resetSdkSessionsForTests()
  __resetMigrationCacheForTests?.()
  // No subscription, and no real import: the pool is real, only the CLI is not.
  __setDefaultQueryFnForTests(() => neverEnding())
  __setQuotaPrefixesForTests([])
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-sdkrace-')))
  project = join(scratch, 'proj')
  await git(scratch, ['init', '-q', '-b', 'main', 'proj'])
  await git(project, ['config', 'user.email', 'dev@test'])
  await git(project, ['config', 'user.name', 'Dev'])
  await writeFile(join(project, 'README.md'), '# x\n')
  await git(project, ['add', '-A'])
  await git(project, ['commit', '-q', '-m', 'base'])
  await addProjectEntry(project)
  await setSettings({ swarmWorkerRuntime: { mode: 'sdk', sdkMaxWorkers: 1 } })
})

afterEach(async () => {
  openGate?.()
  __setDefaultQueryFnForTests(null)
  __setQuotaPrefixesForTests(null)
  __resetSdkSessionsForTests()
  await setSettings({ swarmWorkerRuntime: { mode: 'pty' } })
  await rm(scratch, { recursive: true, force: true })
})

describe('two dispatches racing for one SDK slot', () => {
  it('seats exactly one — the cap is not check-then-act', async () => {
    // Started in sequence, not together: each has to build a real git worktree
    // first, and two `git worktree add` in the same repo at the same instant
    // contend on the repo lock for reasons that have nothing to do with this
    // test. Waiting for the first to PARK inside preloadSdk keeps the git work
    // serialised while still putting both dispatches in flight at once.
    const a = spawnSwarmWorker({ projectPath: project, title: 'card A' })
    await until(() => arrivals === 1, 'the first dispatch to reach preloadSdk')
    const b = spawnSwarmWorker({ projectPath: project, title: 'card B' })
    await until(() => arrivals === 2, 'the second dispatch to reach preloadSdk')

    // Both are now past every await EXCEPT this one. Releasing them decides it.
    openGate?.()
    const [ra, rb] = await Promise.all([a, b])

    const onSdk = [ra, rb].filter((r) => r.runtime === 'sdk')
    expect(
      onSdk.length,
      `sdkMaxWorkers is 1 but ${onSdk.length} dispatches took the SDK runtime — ` +
        'an await slipped between the slot count and the spawn',
    ).toBe(1)

    // And the loser is a WORKER, not a failure: the cap degrades, it never refuses.
    const onPty = [ra, rb].filter((r) => (r.runtime ?? 'pty') === 'pty')
    expect(onPty).toHaveLength(1)
    expect(onPty[0].terminalId).toBe('pty-fallback')
  })

  it('the pool itself holds one live SDK worker, not two', async () => {
    // The response is what the caller believes; the pool is what is true. Both
    // have to agree, or the cap is being enforced in the report only.
    const a = spawnSwarmWorker({ projectPath: project, title: 'card A' })
    await until(() => arrivals === 1, 'the first dispatch to reach preloadSdk')
    const b = spawnSwarmWorker({ projectPath: project, title: 'card B' })
    await until(() => arrivals === 2, 'the second dispatch to reach preloadSdk')
    openGate?.()
    await Promise.all([a, b])

    const liveWorkers = listSdkSessions().filter((s) => s.role === 'worker' && !s.reaped)
    expect(liveWorkers).toHaveLength(1)
  })
})

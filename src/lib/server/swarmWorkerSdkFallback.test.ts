// @vitest-environment node
//
// AN SDK SPAWN THAT DIES AT START MUST DEGRADE TO A PTY — NOT FAIL THE DISPATCH,
// AND NOT RECORD A CORPSE AS A LIVE WORKER.
//
// Three shipped versions of this one branch, each wrong differently:
//   1. the failure was IGNORED — `spawnSdkSession` reports a synchronous death as
//      `status:'failed'` rather than throwing, so a dead session was returned as
//      a live worker and the engine monitored it forever;
//   2. the fix THREW `SdkWorkerUnavailableError` — which has no catcher anywhere,
//      so the whole dispatch failed, the card bounced back to todo, and the next
//      tick retried into the identical failure;
//   3. this: fall through to the PTY launch, reusing the worktree and branch that
//      were made for this card. It is the rule the commander's own SDK path
//      states outright — a worker on the known-good runtime beats no worker.
//
// TEETH: drives the real git paths (real repo, real `git worktree add`) and
// asserts on the RETURNED RUNTIME plus the absence of debris. It cannot pass on
// versions 1 or 2.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { mkdtemp, rm, realpath, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const execFile = promisify(execFileCb)
const git = (cwd: string, args: string[]) =>
  execFile('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })

// The PTY launch that must take over. Records what it was asked to run so the
// test can prove the fall-through reused the SAME worktree.
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
// The dial says SDK and the preflight passes — so the SDK branch is entered for
// real, and the ONLY thing that goes wrong is the session dying at start.
vi.mock('./swarmWorkerSdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./swarmWorkerSdk')>()),
  sdkWorkerPreflight: () => ({
    ok: true,
    problems: [],
    claudeBin: '/usr/local/bin/claude',
    cliVersion: '2.1.220',
  }),
  sdkWorkerLaunchPlan: () => ({ options: {}, initialPrompt: '/order go', warnings: [] }),
}))
// THE failure under test: spawnSdkSession reports a synchronous death by
// RETURNING status:'failed' (it catches the throw itself), not by throwing.
vi.mock('./sdkSession', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sdkSession')>()),
  spawnSdkSession: (o: { cwd: string }) => {
    spawnedIn.push(o.cwd)
    return { id: 'sdk-dead', cwd: o.cwd, status: 'failed', exitReason: 'spawn failed: require blew up', startedAt: 0, lastEventAt: 0, seq: 0 }
  },
}))
const spawnedIn: string[] = []

import { spawnSwarmWorker } from './swarmWorker'
import { addProjectEntry, __resetMigrationCacheForTests } from './registry'
import { setSettings } from './store'
import { __resetSdkSessionsForTests } from './sdkSession'

let scratch: string
let project: string

beforeEach(async () => {
  launched.length = 0
  spawnedIn.length = 0
  __resetSdkSessionsForTests()
  __resetMigrationCacheForTests?.()
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-sdkfall-')))
  project = join(scratch, 'proj')
  await git(scratch, ['init', '-q', '-b', 'main', 'proj'])
  await git(project, ['config', 'user.email', 'dev@test'])
  await git(project, ['config', 'user.name', 'Dev'])
  await writeFile(join(project, 'README.md'), '# x\n')
  await git(project, ['add', '-A'])
  await git(project, ['commit', '-q', '-m', 'base'])
  await addProjectEntry(project)
  // The dial ON — otherwise the SDK branch is never entered at all.
  await setSettings({ swarmWorkerRuntime: { mode: 'sdk' } })
})

afterEach(async () => {
  __resetSdkSessionsForTests()
  await setSettings({ swarmWorkerRuntime: { mode: 'pty' } })
  await rm(scratch, { recursive: true, force: true })
})

describe('spawnSwarmWorker — an SDK session that dies at start', () => {
  it('degrades to a PTY worker instead of failing the dispatch', async () => {
    const res = await spawnSwarmWorker({
      projectPath: project,
      title: 'a card',
    })

    // Version 2 threw here; version 1 returned runtime 'sdk' with a dead session.
    expect(res.runtime ?? 'pty').toBe('pty')
    expect(res.terminalId).toBe('pty-fallback')
    expect(res.sdkSessionId).toBeUndefined()
  })

  it('REUSES the worktree it already made — no second tree, no orphan branch', async () => {
    const before = (await git(project, ['worktree', 'list', '--porcelain'])).stdout
    const res = await spawnSwarmWorker({
      projectPath: project,
      title: 'a card',
    })
    const after = (await git(project, ['worktree', 'list', '--porcelain'])).stdout

    // Exactly ONE new worktree (the one the SDK attempt made), and the PTY was
    // launched INTO it — not into a second one, and not after deleting it.
    expect(after.split('worktree ').length).toBe(before.split('worktree ').length + 1)
    expect(launched).toHaveLength(1)
    expect(launched[0].cwd).toBe(res.worktree)
  })

  it('the SDK attempt really happened — this is a FALL-THROUGH, not a skip', async () => {
    // Guards the other way: if a later change stopped entering the SDK branch at
    // all, the first two assertions would still pass while the runtime silently
    // did nothing. Proving the SDK spawn was attempted in the same worktree the
    // PTY then used is what makes those assertions mean "degraded".
    const res = await spawnSwarmWorker({ projectPath: project, title: 'a card' })
    expect(spawnedIn).toEqual([res.worktree])
    expect(launched[0].cwd).toBe(res.worktree)
  })
})

// @vitest-environment node
//
// A FAILED SPAWN MUST NOT LEAK A WORKTREE (2026-07-29; re-triggered 2026-08-13).
//
// spawnSwarmWorker declares that everything before the worktree is created
// fails closed, so a rejected spawn leaves nothing behind. The launch step sits
// BELOW the worktree creation and was once outside that invariant: when it
// threw, the worktree AND its `swarm/*` branch were already on disk, and
// nothing removed them — one persistent failure minted a fresh pair every 3s
// tick, hundreds overnight. The 2026-07-29 trigger was launchClaude throwing;
// that path died with the PTY worker (2026-08-13), and today's equivalent is
// `spawnSdkSession` THROWING synchronously (the SDK module blew up mid-spawn —
// distinct from the status:'failed' birth that swarmWorkerFailFast.test.ts
// pins). Same invariant, surviving trigger.
//
// TEETH: this drives the real git paths (real repo, real `git worktree add`) and
// asserts on the DEBRIS, not on a return value. Remove the try/catch teardown in
// spawnSwarmWorker and both assertions go red.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { mkdir, mkdtemp, rm, realpath, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const execFile = promisify(execFileCb)
const git = (cwd: string, args: string[]) =>
  execFile('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })

// The one failure under test: the SDK spawn throws mid-flight. Preflight
// passes (the machine LOOKS healthy) so the worktree is already on disk when
// the throw lands — exactly the debris window.
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
vi.mock('./sdkSession', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sdkSession')>()),
  spawnSdkSession: () => {
    throw new Error('sdk query() blew up mid-spawn')
  },
}))
vi.mock('./claudeTerminal', () => ({
  launchClaude: () => {
    throw new Error('launchClaude must never be reached (PTY workers deleted 2026-08-13)')
  },
}))
// Preconditions that would otherwise need the real machine (hook wiring, model
// probes, the sandbox experiment). None of them is what this test is about.
vi.mock('./hooksInstall', () => ({ ensureGuardWiring: async () => ({ ok: true, problems: [] }) }))
vi.mock('./experiments', () => ({ isExperimentEnabled: async () => false }))
vi.mock('./swarmLaunch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./swarmLaunch')>()),
  resolveSwarmModelEffortProbed: async () => ({ model: 'sonnet', effort: 'medium' }),
  resolveSwarmRemoteName: async () => 'worker',
}))

import { spawnSwarmWorker } from './swarmWorker'
import { addProjectEntry, __resetMigrationCacheForTests } from './registry'

let scratch = ''
let project = ''
let savedHome: string | undefined

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-spawnfail-')))
  savedHome = process.env.OPENGROUND_HOME
  process.env.OPENGROUND_HOME = join(scratch, 'home')
  await mkdir(join(scratch, 'home'), { recursive: true })
  __resetMigrationCacheForTests()

  project = join(scratch, 'proj')
  await git(scratch, ['init', '-q', '-b', 'main', project])
  await git(project, ['config', 'user.email', 'dev@test'])
  await git(project, ['config', 'user.name', 'Dev'])
  await writeFile(join(project, 'README.md'), '# base\n')
  await git(project, ['add', '-A'])
  await git(project, ['commit', '-m', 'base'])
  await addProjectEntry(project)
})

afterEach(async () => {
  // RESTORE, never `delete` (07 章 §6 掟 3): unsetting a home var points every
  // later write in this worker process at the user's REAL ~/.openground. When it
  // was unset to begin with, the suite-wide setup-home re-pins it per test, so
  // leaving our value in place is harmless — deleting it is not.
  if (savedHome !== undefined) process.env.OPENGROUND_HOME = savedHome
  await rm(scratch, { recursive: true, force: true })
})

describe('spawnSwarmWorker — a spawn-time SDK failure leaves NO debris', () => {
  it('removes the worktree it just created and deletes its branch', async () => {
    const before = (await git(project, ['worktree', 'list', '--porcelain'])).stdout

    await expect(
      spawnSwarmWorker({ projectPath: project, title: 'Leaky card', goal: 'do a thing' } as Parameters<
        typeof spawnSwarmWorker
      >[0]),
    ).rejects.toThrow(/blew up mid-spawn/)

    // No worktree survived the failure…
    const after = (await git(project, ['worktree', 'list', '--porcelain'])).stdout
    expect(after.split('worktree ').length).toBe(before.split('worktree ').length)
    // …and no swarm/* branch either. Pre-fix BOTH were left behind, and the 3s
    // dispatch tick minted another pair on the very next pass.
    const branches = (await git(project, ['branch', '--list', 'swarm/*'])).stdout.trim()
    expect(branches).toBe('')
  })

  it('repeated failures do not accumulate worktrees (the 3s-tick amplifier)', async () => {
    for (let i = 0; i < 3; i++) {
      await expect(
        spawnSwarmWorker({ projectPath: project, title: `Card ${i}`, goal: 'x' } as Parameters<
          typeof spawnSwarmWorker
        >[0]),
      ).rejects.toThrow()
    }
    const branches = (await git(project, ['branch', '--list', 'swarm/*'])).stdout.trim()
    expect(branches).toBe('')
  })
})

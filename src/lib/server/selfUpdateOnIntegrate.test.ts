import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, rm, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  snapshotWorktreeBranch,
  fireSelfUpdateIfIntegrated,
  SELF_UPDATE_TRUNK_PREFERENCE,
} from './selfUpdateOnIntegrate'
import { SELF_UPDATE_MESSAGE } from './selfUpdateSignal'
import { removeSwarmWorktree } from './swarmWorker'
import { listSwarmNotifications } from './swarmNotifications'
import { centralWorktreesDir } from './paths'
import { addProjectEntry, __resetMigrationCacheForTests } from './registry'

// Tests for the commander-integration → self-update reconnection
// (selfUpdateOnIntegrate.ts): the 2026-07-15 manager-only rework removed the
// engine's land path (and with it the old land-time requestEngineSelfUpdate),
// so the trigger moved to the ONE server-observable step of the commander's
// manual flow — the confirmed non-force worktree removal that og-manage §マージ
// step 7 performs ONLY after its own `merge-base --is-ancestor` landed-check.
// Real git repos (bare origin + clone, the swarmSafety.test.ts shape); HOME is
// isolated via OPENGROUND_HOME so the notification write never touches the real
// ~/.openground (feedback_tests_isolate_home).
//
// REAL git subprocess timing (clone/worktree/commit/merge/remove per test) needs
// the same higher ceiling as its sibling real-git files (swarmSafety.test.ts,
// swarmIntegrate.test.ts, swarmJanitor.test.ts, swarmOrchestrator.integration.test.ts
// all set this) — this file was missing it, so under CPU load the default 5000ms
// vitest testTimeout flips a subtest red nondeterministically (reproduced 2026-07-20
// by running two `vitest run` processes concurrently against the same repo).
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const execFile = promisify(execFileCb)
const git = async (cwd: string, args: string[]): Promise<string> =>
  (await execFile('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout

type Send = NonNullable<typeof process.send>
const realProcess = process as NodeJS.Process & { send?: Send }

let scratch: string
let savedSend: Send | undefined
let savedSourceRoot: string | undefined
let savedHome: string | undefined
let savedClaudeCfg: string | undefined

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-selfupd-integ-')))
  savedSend = realProcess.send
  savedSourceRoot = process.env.OPENGROUND_SOURCE_ROOT
  savedHome = process.env.OPENGROUND_HOME
  delete process.env.OPENGROUND_SOURCE_ROOT
  const home = join(scratch, 'home')
  await mkdir(home, { recursive: true })
  process.env.OPENGROUND_HOME = home
  // Pin claude's config as well: this file reaches claudeTrust (via
  // ensureClaudeFolderTrusted / removeClaudeFolderTrust), whose path is
  // CLAUDE_CONFIG_PATH ?? homedir()/.claude.json — a homedir anchor that
  // OPENGROUND_HOME cannot move. Unpinned, these cases read and REWRITE the
  // user's real ~/.claude.json (their claude OAuth tokens live there).
  // Caught 2026-07-19 by the production-home fence; it had been live and silent.
  savedClaudeCfg = process.env.CLAUDE_CONFIG_PATH
  process.env.CLAUDE_CONFIG_PATH = join(home, '.claude.json')
  __resetMigrationCacheForTests()
})

afterEach(async () => {
  realProcess.send = savedSend
  if (savedSourceRoot === undefined) delete process.env.OPENGROUND_SOURCE_ROOT
  else process.env.OPENGROUND_SOURCE_ROOT = savedSourceRoot
  // Restore, never delete: an unset OPENGROUND_HOME sends later resolution at the
  // REAL home dir (the 2026-07-18 data loss). See src/lib/server/testHomeGuard.ts.
  if (savedHome !== undefined) process.env.OPENGROUND_HOME = savedHome
  if (savedClaudeCfg === undefined) delete process.env.CLAUDE_CONFIG_PATH
  else process.env.CLAUDE_CONFIG_PATH = savedClaudeCfg
  __resetMigrationCacheForTests()
  await rm(scratch, { recursive: true, force: true })
})

/** A bare "origin" + a "project" clone with one commit on main (the trunk the
 *  commander pushes to) — the swarmSafety.test.ts fixture shape. */
async function makeRemote(): Promise<{ origin: string; project: string }> {
  const origin = join(scratch, 'origin.git')
  await mkdir(origin)
  await git(origin, ['init', '--bare', '-b', 'main'])
  const seed = join(scratch, 'seed')
  await mkdir(seed)
  await git(seed, ['init', '-b', 'main'])
  await git(seed, ['config', 'user.email', 't@example.com'])
  await git(seed, ['config', 'user.name', 'tester'])
  await git(seed, ['remote', 'add', 'origin', origin])
  await writeFile(join(seed, 'fileX'), 'base\n')
  await git(seed, ['add', '.'])
  await git(seed, ['commit', '-m', 'C0'])
  await git(seed, ['push', 'origin', 'main'])
  const project = join(scratch, 'project')
  await git(scratch, ['clone', origin, project])
  await git(project, ['config', 'user.email', 't@example.com'])
  await git(project, ['config', 'user.name', 'tester'])
  return { origin, project }
}

/** Add a swarm worker worktree at `dir` on a fresh `branch` off origin/main and
 *  commit one file on it (what a real worker leaves behind before ready). */
async function makeWorkerWorktree(project: string, dir: string, branch: string): Promise<string> {
  await git(project, ['worktree', 'add', '-b', branch, dir, 'origin/main'])
  await git(dir, ['config', 'user.email', 'w@example.com'])
  await git(dir, ['config', 'user.name', 'worker'])
  await writeFile(join(dir, 'work.txt'), 'worker output\n')
  await git(dir, ['add', '.'])
  await git(dir, ['commit', '-m', 'worker change'])
  return (await git(dir, ['rev-parse', 'HEAD'])).trim()
}

/** Simulate the COMMANDER's manual integration: FF-push the branch to
 *  origin/main from the worktree, exactly og-manage §マージ step 5. (This is
 *  test fixture setup standing in for the human commander — the engine under
 *  test never pushes; selfUpdateOnIntegrate only ever reads.) */
async function commanderIntegrates(worktree: string): Promise<void> {
  await git(worktree, ['push', 'origin', 'HEAD:main'])
}

/** Arm the trigger the way electron/main.js does for a self-update run: an IPC
 *  channel (process.send) + OPENGROUND_SOURCE_ROOT naming this very repo. */
function arm(projectPath: string): ReturnType<typeof vi.fn> {
  const send = vi.fn(() => true)
  realProcess.send = send as unknown as Send
  process.env.OPENGROUND_SOURCE_ROOT = projectPath
  return send
}

const selfUpdateSends = (send: ReturnType<typeof vi.fn>) =>
  send.mock.calls.filter((c) => (c[0] as { type?: string })?.type === SELF_UPDATE_MESSAGE)

describe('SELF_UPDATE_TRUNK_PREFERENCE', () => {
  it('prefers origin/main, falls back to local main, and has NO HEAD fallback', () => {
    // HEAD of the primary checkout proves nothing about integration — a HEAD
    // fallback would make the ancestor check trivially true. Pinned here.
    expect(SELF_UPDATE_TRUNK_PREFERENCE).toEqual(['origin/main', 'main'])
  })
})

describe('snapshotWorktreeBranch', () => {
  it('reads branch + HEAD of a live worker worktree', async () => {
    const { project } = await makeRemote()
    const wt = join(scratch, 'wt-snap')
    const head = await makeWorkerWorktree(project, wt, 'swarm/snap-test')
    expect(await snapshotWorktreeBranch(wt)).toEqual({ branch: 'swarm/snap-test', head })
  })

  it('returns null for a non-repo dir (fail-safe)', async () => {
    const dir = join(scratch, 'not-a-repo')
    await mkdir(dir)
    expect(await snapshotWorktreeBranch(dir)).toBeNull()
  })
})

describe('fireSelfUpdateIfIntegrated', () => {
  it('null snapshot → no-op (no detection, nothing sent)', async () => {
    const { project } = await makeRemote()
    const send = arm(project)
    expect(await fireSelfUpdateIfIntegrated(project, null)).toEqual({
      detected: false,
      requested: false,
    })
    expect(selfUpdateSends(send)).toHaveLength(0)
  })

  it('un-integrated branch → detected:false, nothing sent', async () => {
    const { project } = await makeRemote()
    const wt = join(scratch, 'wt-unmerged')
    const head = await makeWorkerWorktree(project, wt, 'swarm/unmerged')
    const send = arm(project)
    expect(
      await fireSelfUpdateIfIntegrated(project, { branch: 'swarm/unmerged', head }),
    ).toEqual({ detected: false, requested: false })
    expect(selfUpdateSends(send)).toHaveLength(0)
    expect(await listSwarmNotifications()).toHaveLength(0)
  })

  it('integrated branch + armed own-source run → fires, and writes the bell record', async () => {
    const { project } = await makeRemote()
    const wt = join(scratch, 'wt-merged')
    const head = await makeWorkerWorktree(project, wt, 'swarm/merged')
    await commanderIntegrates(wt)
    const send = arm(project)

    const res = await fireSelfUpdateIfIntegrated(project, { branch: 'swarm/merged', head })
    expect(res).toEqual({ detected: true, requested: true })
    const fired = selfUpdateSends(send)
    expect(fired).toHaveLength(1)
    expect((fired[0][0] as { projectPath?: string }).projectPath).toBe(project)

    // The observable, persisted record (completion condition 1): a
    // 'self-update-requested' swarm-info notification.
    const notes = await listSwarmNotifications()
    expect(notes).toHaveLength(1)
    expect(notes[0].kind).toBe('swarm-info')
    expect(notes[0].swarmInfo?.event).toBe('self-update-requested')
    expect(notes[0].swarmInfo?.branch).toBe('swarm/merged')
    expect(notes[0].swarmInfo?.projectPath).toBe(project)
  })

  it('integrated but NOT armed (no OPENGROUND_SOURCE_ROOT) → detected only, silent', async () => {
    const { project } = await makeRemote()
    const wt = join(scratch, 'wt-merged-unarmed')
    const head = await makeWorkerWorktree(project, wt, 'swarm/merged-unarmed')
    await commanderIntegrates(wt)
    const send = vi.fn(() => true)
    realProcess.send = send as unknown as Send // IPC channel present, but not armed

    const res = await fireSelfUpdateIfIntegrated(project, {
      branch: 'swarm/merged-unarmed',
      head,
    })
    expect(res).toEqual({ detected: true, requested: false })
    expect(selfUpdateSends(send)).toHaveLength(0)
    // No bell noise on the commander's every sweep in normal (unarmed) runs.
    expect(await listSwarmNotifications()).toHaveLength(0)
  })

  it('armed for a DIFFERENT repo → detected but never fires (own-source gate)', async () => {
    const { project } = await makeRemote()
    const wt = join(scratch, 'wt-merged-other')
    const head = await makeWorkerWorktree(project, wt, 'swarm/merged-other')
    await commanderIntegrates(wt)
    const other = join(scratch, 'some-other-root')
    await mkdir(other)
    const send = vi.fn(() => true)
    realProcess.send = send as unknown as Send
    process.env.OPENGROUND_SOURCE_ROOT = other

    const res = await fireSelfUpdateIfIntegrated(project, {
      branch: 'swarm/merged-other',
      head,
    })
    expect(res).toEqual({ detected: true, requested: false })
    expect(selfUpdateSends(send)).toHaveLength(0)
  })

  it('falls back to LOCAL main when the repo has no origin remote', async () => {
    // An offline repo: the commander merges to the local main directly.
    const repo = join(scratch, 'local-only')
    await mkdir(repo)
    await git(repo, ['init', '-b', 'main'])
    await git(repo, ['config', 'user.email', 't@example.com'])
    await git(repo, ['config', 'user.name', 'tester'])
    await writeFile(join(repo, 'a'), '1\n')
    await git(repo, ['add', '.'])
    await git(repo, ['commit', '-m', 'C0'])
    const wt = join(scratch, 'wt-local')
    await git(repo, ['worktree', 'add', '-b', 'swarm/local', wt, 'main'])
    await git(wt, ['config', 'user.email', 'w@example.com'])
    await git(wt, ['config', 'user.name', 'worker'])
    await writeFile(join(wt, 'b'), '2\n')
    await git(wt, ['add', '.'])
    await git(wt, ['commit', '-m', 'work'])
    const head = (await git(wt, ['rev-parse', 'HEAD'])).trim()
    // "Integrate": fast-forward the local main ref to the branch tip (refs
    // only — main is checked out in `repo`, so update-ref, not fetch/merge).
    await git(repo, ['update-ref', 'refs/heads/main', head])

    const send = arm(repo)
    const res = await fireSelfUpdateIfIntegrated(repo, { branch: 'swarm/local', head })
    expect(res).toEqual({ detected: true, requested: true })
    expect(selfUpdateSends(send)).toHaveLength(1)
  })

  it('repo with no trunk at all → detected:false (fail-safe)', async () => {
    const repo = join(scratch, 'trunkless')
    await mkdir(repo)
    await git(repo, ['init', '-b', 'trunk-elsewhere'])
    await git(repo, ['config', 'user.email', 't@example.com'])
    await git(repo, ['config', 'user.name', 'tester'])
    await writeFile(join(repo, 'a'), '1\n')
    await git(repo, ['add', '.'])
    await git(repo, ['commit', '-m', 'C0'])
    const head = (await git(repo, ['rev-parse', 'HEAD'])).trim()
    const send = arm(repo)
    expect(await fireSelfUpdateIfIntegrated(repo, { branch: 'x', head })).toEqual({
      detected: false,
      requested: false,
    })
    expect(selfUpdateSends(send)).toHaveLength(0)
  })
})

describe('removeSwarmWorktree self-update wiring', () => {
  /** Register the project (registry = the path allowlist AND the central-dir
   *  key) and create a worker worktree INSIDE the central worktrees dir, where
   *  removeSwarmWorktree's hard safety guard requires it to live. */
  async function makeCentralWorker(
    project: string,
    name: string,
    branch: string,
  ): Promise<{ wt: string; head: string }> {
    const entry = await addProjectEntry(project)
    const central = centralWorktreesDir(entry.id)
    await mkdir(central, { recursive: true })
    const wt = join(central, name)
    const head = await makeWorkerWorktree(project, wt, branch)
    return { wt, head }
  }

  it('non-force removal of an INTEGRATED worker fires the trigger and reports it', async () => {
    const { project } = await makeRemote()
    const { wt } = await makeCentralWorker(project, 'w-merged', 'swarm/e2e-merged')
    await commanderIntegrates(wt)
    const send = arm(project)

    const res = await removeSwarmWorktree(project, wt, { force: false })
    expect(res.removed).toBe(true)
    expect(res.selfUpdate).toEqual({ detected: true, requested: true })
    expect(selfUpdateSends(send)).toHaveLength(1)
    const notes = await listSwarmNotifications()
    expect(notes.map((n) => n.swarmInfo?.event)).toContain('self-update-requested')
  })

  it('non-force removal of an UN-integrated worker stays quiet (detected:false)', async () => {
    const { project } = await makeRemote()
    const { wt } = await makeCentralWorker(project, 'w-unmerged', 'swarm/e2e-unmerged')
    const send = arm(project)

    const res = await removeSwarmWorktree(project, wt, { force: false })
    expect(res.removed).toBe(true)
    expect(res.selfUpdate).toEqual({ detected: false, requested: false })
    expect(selfUpdateSends(send)).toHaveLength(0)
  })

  it('force removal (kill/abandon lane) never runs the check, even when integrated', async () => {
    const { project } = await makeRemote()
    const { wt } = await makeCentralWorker(project, 'w-killed', 'swarm/e2e-killed')
    await commanderIntegrates(wt) // even a landed branch: force ⇒ not the sweep lane
    const send = arm(project)

    const res = await removeSwarmWorktree(project, wt, { force: true })
    expect(res.removed).toBe(true)
    expect(res.selfUpdate).toBeUndefined()
    expect(selfUpdateSends(send)).toHaveLength(0)
  })
})

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { mkdtemp, mkdir, rm, realpath, writeFile, readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  classifyBranch,
  integrateBranch,
  resolveTarget,
  fetchTarget,
  isSwarmBranch,
} from './swarmIntegrate'

// Tests against REAL local git fixtures in a tmpdir (mergedBranches /
// branchChanges house style) — no mocks, no network. The "remote" is a local
// BARE repo; the project clone integrates worker branches onto it via push, and
// a SECOND clone simulates another worker landing on the trunk so we exercise
// the real diverged → rebase → fast-forward path and the conflict abort.

vi.setConfig({ testTimeout: 60_000 })

const execFile = promisify(execFileCb)

const git = async (cwd: string, args: string[]): Promise<string> =>
  (
    await execFile(
      'git',
      [
        '-c', 'user.name=OG Test',
        '-c', 'user.email=og-test@example.com',
        '-c', 'commit.gpgsign=false',
        '-c', 'init.defaultBranch=main',
        ...args,
      ],
      { cwd },
    )
  ).stdout

let scratch: string
let token = 0
const intDir = () => join(scratch, `integrate-${token++}`)

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-swarm-integrate-')))
})
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

/** A bare "origin" with one commit on main, plus a `project` clone (the one the
 *  engine integrates from) and an `other` clone (used to advance the trunk so we
 *  can simulate "another worker already landed"). fileX seeds the conflict case. */
async function makeRemote(): Promise<{ origin: string; project: string; other: string }> {
  const origin = join(scratch, 'origin.git')
  await mkdir(origin)
  await git(origin, ['init', '--bare', '-b', 'main'])

  const seed = join(scratch, 'seed')
  await mkdir(seed)
  await git(seed, ['init', '-b', 'main'])
  await git(seed, ['remote', 'add', 'origin', origin])
  await writeFile(join(seed, 'fileX'), 'base\n')
  await git(seed, ['add', '.'])
  await git(seed, ['commit', '-m', 'C0'])
  await git(seed, ['push', 'origin', 'main'])

  const project = join(scratch, 'project')
  await git(scratch, ['clone', origin, project])
  const other = join(scratch, 'other')
  await git(scratch, ['clone', origin, other])
  return { origin, project, other }
}

/** Create `branch` off origin/main in `project` and commit `file=content` on it,
 *  using a temp worktree (mirrors how a real worker commits in its worktree).
 *  Leaves refs/heads/<branch> pointing at the new commit; the worktree is gone. */
async function commitOnBranch(
  project: string,
  branch: string,
  file: string,
  content: string,
  msg: string,
): Promise<void> {
  const wt = join(scratch, `wt-${branch.replace(/\//g, '-')}-${token++}`)
  await git(project, ['worktree', 'add', '-b', branch, wt, 'origin/main'])
  await writeFile(join(wt, file), content)
  await git(wt, ['add', '.'])
  await git(wt, ['commit', '-m', msg])
  await git(project, ['worktree', 'remove', '--force', wt])
}

/** Advance the trunk on origin via the `other` clone (a different worker landing
 *  first). Commits `file=content` on main and pushes. */
async function advanceTrunk(other: string, file: string, content: string, msg: string): Promise<void> {
  await git(other, ['pull', '--ff-only', 'origin', 'main'])
  await writeFile(join(other, file), content)
  await git(other, ['add', '.'])
  await git(other, ['commit', '-m', msg])
  await git(other, ['push', 'origin', 'main'])
}

/** The bare origin's main tip sha. */
const trunkTip = async (origin: string): Promise<string> =>
  (await git(origin, ['rev-parse', 'main'])).trim()

/** Does the bare origin's main contain a file (read via a fresh archive)? */
async function trunkHasFile(origin: string, file: string): Promise<boolean> {
  const out = await git(origin, ['ls-tree', '--name-only', 'main'])
  return out.split('\n').map((s) => s.trim()).includes(file)
}

// ── pure guard ────────────────────────────────────────────────────────────────

describe('isSwarmBranch', () => {
  it('only accepts the swarm/ prefix', () => {
    expect(isSwarmBranch('swarm/foo-123')).toBe(true)
    expect(isSwarmBranch('feature/x')).toBe(false)
    expect(isSwarmBranch('main')).toBe(false)
    expect(isSwarmBranch('notswarm/foo')).toBe(false)
  })
})

// ── resolveTarget ───────────────────────────────────────────────────────────

describe('resolveTarget', () => {
  it('honours a valid override', async () => {
    const { project } = await makeRemote()
    expect(await resolveTarget(project, 'develop')).toBe('develop')
  })
  it('rejects an unusable override (→ null)', async () => {
    const { project } = await makeRemote()
    expect(await resolveTarget(project, '--evil')).toBe(null)
  })
  it('falls back to main with no origin/HEAD', async () => {
    const { project } = await makeRemote()
    expect(await resolveTarget(project)).toBe('main')
  })
})

// ── classifyBranch (read-only) ──────────────────────────────────────────────

describe('classifyBranch — read-only readiness', () => {
  it('reports ff for a clean fast-forward branch', async () => {
    const { project } = await makeRemote()
    await commitOnBranch(project, 'swarm/ff', 'a.txt', 'A\n', 'add a')
    await fetchTarget(project, 'main')
    expect(await classifyBranch(project, 'swarm/ff', 'main')).toBe('ff')
  })

  it('reports rebase for a diverged branch', async () => {
    const { project, other } = await makeRemote()
    await commitOnBranch(project, 'swarm/div', 'b.txt', 'B\n', 'add b')
    await advanceTrunk(other, 'c.txt', 'C\n', 'trunk c')
    await fetchTarget(project, 'main')
    expect(await classifyBranch(project, 'swarm/div', 'main')).toBe('rebase')
  })

  it('reports ff for an already-merged branch', async () => {
    const { project } = await makeRemote()
    await commitOnBranch(project, 'swarm/done', 'd.txt', 'D\n', 'add d')
    await fetchTarget(project, 'main')
    await integrateBranch(project, 'swarm/done', { target: 'main', integrateDir: intDir() })
    await fetchTarget(project, 'main')
    // Its tip is now contained in the trunk → still classified ff (finalizable).
    expect(await classifyBranch(project, 'swarm/done', 'main')).toBe('ff')
  })

  it('reports unknown for a non-swarm branch and a missing tip', async () => {
    const { project } = await makeRemote()
    expect(await classifyBranch(project, 'feature/x', 'main')).toBe('unknown')
    expect(await classifyBranch(project, 'swarm/ghost', 'main')).toBe('unknown')
  })

  it('reports unknown when there is no remote trunk', async () => {
    const solo = join(scratch, 'solo')
    await git(solo, ['init', '-b', 'main']).catch(async () => {
      await mkdir(solo); await git(solo, ['init', '-b', 'main'])
    })
    await writeFile(join(solo, 'f'), 'x\n')
    await git(solo, ['add', '.']); await git(solo, ['commit', '-m', 'c'])
    await git(solo, ['branch', 'swarm/x'])
    expect(await classifyBranch(solo, 'swarm/x', 'main')).toBe('unknown')
  })
})

// ── integrateBranch — the clean fast-forward path ─────────────────────────────

describe('integrateBranch — fast-forward', () => {
  it('pushes a clean branch straight to the trunk (mode ff)', async () => {
    const { origin, project } = await makeRemote()
    await commitOnBranch(project, 'swarm/ff', 'a.txt', 'A\n', 'add a')
    await fetchTarget(project, 'main')
    const before = await trunkTip(origin)

    const out = await integrateBranch(project, 'swarm/ff', { target: 'main', integrateDir: intDir() })
    expect(out).toEqual({ status: 'integrated', mode: 'ff' })
    // The trunk moved and now carries the branch's file.
    expect(await trunkTip(origin)).not.toBe(before)
    expect(await trunkHasFile(origin, 'a.txt')).toBe(true)
  })

  it('treats an already-merged branch as integrated without re-pushing', async () => {
    const { origin, project } = await makeRemote()
    await commitOnBranch(project, 'swarm/once', 'a.txt', 'A\n', 'add a')
    await fetchTarget(project, 'main')
    await integrateBranch(project, 'swarm/once', { target: 'main', integrateDir: intDir() })
    await fetchTarget(project, 'main')
    const tip = await trunkTip(origin)

    const again = await integrateBranch(project, 'swarm/once', { target: 'main', integrateDir: intDir() })
    expect(again).toEqual({ status: 'integrated', mode: 'ff' })
    expect(await trunkTip(origin)).toBe(tip) // no new commit
  })
})

// ── integrateBranch — the rebase path ─────────────────────────────────────────

describe('integrateBranch — rebase', () => {
  it('rebases a diverged but non-conflicting branch and fast-forwards (mode rebase)', async () => {
    const { origin, project, other } = await makeRemote()
    await commitOnBranch(project, 'swarm/div', 'b.txt', 'B\n', 'add b')
    await advanceTrunk(other, 'c.txt', 'C\n', 'trunk c') // different file → no conflict
    await fetchTarget(project, 'main')

    const out = await integrateBranch(project, 'swarm/div', { target: 'main', integrateDir: intDir() })
    expect(out).toEqual({ status: 'integrated', mode: 'rebase' })
    // The trunk now carries BOTH the trunk's and the branch's file.
    expect(await trunkHasFile(origin, 'c.txt')).toBe(true)
    expect(await trunkHasFile(origin, 'b.txt')).toBe(true)
  })

  it('leaves no integration worktree behind after a rebase', async () => {
    const { project, other } = await makeRemote()
    await commitOnBranch(project, 'swarm/div2', 'b.txt', 'B\n', 'add b')
    await advanceTrunk(other, 'c.txt', 'C\n', 'trunk c')
    await fetchTarget(project, 'main')
    const dir = intDir()
    await integrateBranch(project, 'swarm/div2', { target: 'main', integrateDir: dir })
    expect(existsSync(dir)).toBe(false)
  })
})

// ── integrateBranch — conflict (the safety-critical case) ─────────────────────

describe('integrateBranch — conflict', () => {
  it('aborts on a real conflict, pushes nothing, leaves the branch untouched', async () => {
    const { origin, project, other } = await makeRemote()
    // Both sides change fileX differently → rebase conflict.
    await commitOnBranch(project, 'swarm/conf', 'fileX', 'from-swarm\n', 'swarm edits X')
    const branchTipBefore = (await git(project, ['rev-parse', 'refs/heads/swarm/conf'])).trim()
    await advanceTrunk(other, 'fileX', 'from-trunk\n', 'trunk edits X')
    await fetchTarget(project, 'main')
    const trunkBefore = await trunkTip(origin)
    const dir = intDir()

    const out = await integrateBranch(project, 'swarm/conf', { target: 'main', integrateDir: dir })
    // The conflicted file(s) are captured (the human's resolution hint) before the
    // abort — a pure read of the mid-conflict index.
    expect(out).toEqual({ status: 'conflict', files: ['fileX'] })

    // Trunk NOT advanced by us (still just the trunk's own edit).
    expect(await trunkTip(origin)).toBe(trunkBefore)
    const trunkX = await git(origin, ['show', 'main:fileX'])
    expect(trunkX).toBe('from-trunk\n')
    // The worker's branch ref is untouched (no force, no rewrite).
    expect((await git(project, ['rev-parse', 'refs/heads/swarm/conf'])).trim()).toBe(branchTipBefore)
    // No half-rebase / leftover worktree.
    expect(existsSync(dir)).toBe(false)
    expect(existsSync(join(project, '.git', 'worktrees', 'integrate-' + (token - 1)))).toBe(false)
  })
})

// ── integrateBranch — refusals (only ever the worker's own swarm branch) ───────

describe('integrateBranch — refusals', () => {
  it('skips a non-swarm branch without touching anything', async () => {
    const { origin, project } = await makeRemote()
    await git(project, ['branch', 'feature/x', 'origin/main'])
    const before = await trunkTip(origin)
    const out = await integrateBranch(project, 'feature/x', { target: 'main', integrateDir: intDir() })
    expect(out).toEqual({ status: 'skipped', reason: 'not a swarm branch' })
    expect(await trunkTip(origin)).toBe(before)
  })

  it('skips when there is no remote trunk', async () => {
    const solo = join(scratch, 'solo2')
    await mkdir(solo)
    await git(solo, ['init', '-b', 'main'])
    await writeFile(join(solo, 'f'), 'x\n')
    await git(solo, ['add', '.']); await git(solo, ['commit', '-m', 'c'])
    await git(solo, ['branch', 'swarm/x'])
    const out = await integrateBranch(solo, 'swarm/x', { target: 'main', integrateDir: intDir() })
    expect(out).toEqual({ status: 'skipped', reason: 'no remote trunk' })
  })

  it('skips a swarm branch whose tip is missing', async () => {
    const { project } = await makeRemote()
    const out = await integrateBranch(project, 'swarm/ghost', { target: 'main', integrateDir: intDir() })
    expect(out).toEqual({ status: 'skipped', reason: 'branch tip not found' })
  })
})

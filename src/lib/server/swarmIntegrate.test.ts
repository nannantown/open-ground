import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { mkdtemp, mkdir, rm, realpath, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  classifyBranch,
  resolveTarget,
  fetchTarget,
  isSwarmBranch,
} from './swarmIntegrate'

// Tests against REAL local git fixtures in a tmpdir (mergedBranches /
// branchChanges house style) — no mocks, no network. The "remote" is a local
// BARE repo; the project clone integrates worker branches onto it via push, and
// a SECOND clone simulates another worker landing on the trunk so we exercise
// the real diverged → rebase → fast-forward path and the conflict abort.

// REAL git per test (bare init + two clones + worktree add/commit/rebase/push). 60s
// covers the body even when the machine is loaded; hookTimeout covers the afterEach
// recursive rm of a scratch tree that may still hold git worktrees (slow under load).
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

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
    await git(project, ['push', 'origin', 'swarm/done:main'])
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

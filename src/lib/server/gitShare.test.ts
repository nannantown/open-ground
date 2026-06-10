import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { mkdtemp, mkdir, rm, realpath, writeFile, readFile, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { shareStatus, shareSync, enablePreconditions, __resetShareFetchThrottle } from './gitShare'
import {
  writeSharedMarker,
  isShared,
  boardCardsDir,
  boardNotesPath,
  SHARED_DATA_VERSION,
} from './sharedData'

// Git-engine tests against REAL local git fixtures (docs/SHARED_DATA_PLAN.md
// test strategy): `git init --bare remote.git` + two clones in a tmpdir play
// User A / User B — no network, ever. The user's own git identity/config is
// kept out of the picture by pointing HOME (where git finds ~/.gitconfig) at a
// scratch dir with a known identity, so a globally-configured commit.gpgsign
// or pull strategy can't bend these assertions.

const execFile = promisify(execFileCb)

/** Run git in a fixture dir (test plumbing — the engine has its own runner). */
const git = async (cwd: string, args: string[]): Promise<string> =>
  (await execFile('git', args, { cwd })).stdout

let scratch: string
let savedEnv: Record<string, string | undefined>

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-gitshare-')))
  // Isolate git from the machine's real global/system config. GIT_CONFIG_GLOBAL
  // would be cleaner but needs git ≥ 2.32; HOME redirection works everywhere.
  savedEnv = {
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
  }
  const gitHome = join(scratch, 'githome')
  await mkdir(gitHome)
  await writeFile(
    join(gitHome, '.gitconfig'),
    '[user]\n\tname = OG Test\n\temail = og-test@example.com\n' +
      '[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n',
  )
  process.env.HOME = gitHome
  process.env.XDG_CONFIG_HOME = join(gitHome, '.config')
  process.env.GIT_CONFIG_NOSYSTEM = '1'
})

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(scratch, { recursive: true, force: true })
})

/** A standalone repo (no remote) with one initial commit. */
const makeRepo = async (name: string): Promise<string> => {
  const dir = join(scratch, name)
  await mkdir(dir)
  await git(dir, ['init'])
  await writeFile(join(dir, 'README.md'), `# ${name}\n`)
  await git(dir, ['add', '.'])
  await git(dir, ['commit', '-m', 'init'])
  return dir
}

/** A bare "origin" + two clones with upstream tracking = User A / User B. */
const makePair = async (): Promise<{ remote: string; userA: string; userB: string }> => {
  const seed = await makeRepo('seed')
  const remote = join(scratch, 'remote.git')
  await git(scratch, ['clone', '--bare', seed, remote])
  const userA = join(scratch, 'userA')
  const userB = join(scratch, 'userB')
  await git(scratch, ['clone', remote, userA])
  await git(scratch, ['clone', remote, userB])
  return { remote, userA, userB }
}

const enableShared = async (dir: string): Promise<void> => {
  // The enable migration (integration phase) owns dir creation; the seam's
  // writeSharedMarker assumes the dir exists, so the fixture mkdirs first.
  await mkdir(join(dir, '.openground'), { recursive: true })
  await writeSharedMarker(dir, { version: SHARED_DATA_VERSION })
}

describe('shareStatus', () => {
  it('plain folder (not git): everything is its "no" value', async () => {
    const dir = join(scratch, 'plain')
    await mkdir(dir)
    expect(await shareStatus(dir)).toEqual({
      shared: false,
      gitRepo: false,
      remoteUrl: null,
      dirty: false,
      ahead: 0,
      behind: 0,
    })
  })

  it('git repo without a remote: gitRepo true, remoteUrl null', async () => {
    const dir = await makeRepo('loner')
    expect(await shareStatus(dir)).toEqual({
      shared: false,
      gitRepo: true,
      remoteUrl: null,
      dirty: false,
      ahead: 0,
      behind: 0,
    })
  })

  it('not shared: dirty stays false even with uncommitted repo changes', async () => {
    const dir = await makeRepo('messy')
    await writeFile(join(dir, 'wip.ts'), 'export {}\n')
    expect((await shareStatus(dir)).dirty).toBe(false)
  })

  it('shared clone: remoteUrl + dirty before sync, clean after', async () => {
    const { remote, userA } = await makePair()
    await enableShared(userA)

    const before = await shareStatus(userA)
    expect(before).toEqual({
      shared: true,
      gitRepo: true,
      remoteUrl: remote,
      dirty: true, // the marker is uncommitted
      ahead: 0,
      behind: 0,
    })

    const sync = await shareSync(userA)
    expect(sync.ok).toBe(true)
    expect(sync.committed).toBe(true)
    expect((await shareStatus(userA)).dirty).toBe(false)
  })

  it('ahead/behind count .openground/ commits in each direction (fetch-backed)', async () => {
    const { userA, userB } = await makePair()
    await enableShared(userA)
    expect((await shareSync(userA)).pushed).toBe(true)

    // B pulls A's share, adds a card, pushes. A also commits a card locally
    // WITHOUT pushing → A is simultaneously 1 ahead and 1 behind.
    await git(userB, ['pull'])
    await mkdir(join(userB, '.openground', 'board', 'cards'), { recursive: true })
    await writeFile(
      join(userB, '.openground', 'board', 'cards', 'b1.json'),
      '{"id":"b1","title":"from B","done":false,"createdAt":""}\n',
    )
    expect((await shareSync(userB)).pushed).toBe(true)

    await mkdir(join(userA, '.openground', 'board', 'cards'), { recursive: true })
    await writeFile(
      join(userA, '.openground', 'board', 'cards', 'a1.json'),
      '{"id":"a1","title":"from A","done":false,"createdAt":""}\n',
    )
    await git(userA, ['add', '-A', '--', '.openground'])
    await git(userA, ['commit', '-m', 'openground: local card', '--', '.openground'])

    __resetShareFetchThrottle() // A's earlier sync stamped the throttle window
    const s = await shareStatus(userA)
    expect(s.ahead).toBe(1)
    expect(s.behind).toBe(1)

    // A commit that does NOT touch .openground/ must not count.
    await writeFile(join(userA, 'code.ts'), 'export {}\n')
    await git(userA, ['add', 'code.ts'])
    await git(userA, ['commit', '-m', 'code change'])
    __resetShareFetchThrottle()
    expect((await shareStatus(userA)).ahead).toBe(1)
  })
})

describe('shareSync', () => {
  it('CONTRACT: pathspec commit leaves the user\'s other staged changes staged and uncommitted', async () => {
    const { userA } = await makePair()
    await enableShared(userA)
    // The user is mid-work: a src file is STAGED but not committed.
    await mkdir(join(userA, 'src'))
    await writeFile(join(userA, 'src', 'staged.ts'), 'export const x = 1\n')
    await git(userA, ['add', 'src/staged.ts'])

    const result = await shareSync(userA)
    expect(result.ok).toBe(true)
    expect(result.committed).toBe(true)
    expect(result.pushed).toBe(true)

    // The sync commit contains ONLY .openground/ paths…
    const committedFiles = (
      await git(userA, ['show', '--name-only', '--pretty=format:', 'HEAD'])
    )
      .trim()
      .split('\n')
      .filter(Boolean)
    expect(committedFiles.length).toBeGreaterThan(0)
    for (const f of committedFiles) expect(f.startsWith('.openground/')).toBe(true)
    expect(committedFiles).not.toContain('src/staged.ts')

    // …and the user's file is STILL staged (A = added to index, uncommitted).
    const porcelain = await git(userA, ['status', '--porcelain'])
    expect(porcelain).toContain('A  src/staged.ts')
  })

  it('round-trips A→push, B→pull: B sees the card file with zero setup', async () => {
    const { userA, userB } = await makePair()
    await enableShared(userA)
    await mkdir(boardCardsDir(userA), { recursive: true })
    await writeFile(
      join(boardCardsDir(userA), 'task-1.json'),
      JSON.stringify({ id: 'task-1', title: 'shared card' }) + '\n',
    )

    const a = await shareSync(userA)
    expect(a).toMatchObject({ ok: true, committed: true, pulled: true, pushed: true })

    // B has no .openground yet (the add-pathspec-matches-nothing path) and
    // nothing local to commit — sync is purely a pull for them.
    const b = await shareSync(userB)
    expect(b).toMatchObject({ ok: true, committed: false, pulled: true, pushed: true })

    const card = JSON.parse(
      await readFile(join(boardCardsDir(userB), 'task-1.json'), 'utf-8'),
    )
    expect(card.title).toBe('shared card')
    expect(await isShared(userB)).toBe(true) // marker travelled too
  })

  it('no remote: ok with message, committed locally, pulled/pushed false', async () => {
    const dir = await makeRepo('loner')
    await enableShared(dir)

    const result = await shareSync(dir)
    expect(result.ok).toBe(true)
    expect(result.committed).toBe(true)
    expect(result.pulled).toBe(false)
    expect(result.pushed).toBe(false)
    expect(result.conflict).toBeUndefined()
    expect(result.message).toBeTruthy()

    // The commit really landed (and is pathspec-scoped).
    const subject = await git(dir, ['log', '-1', '--pretty=%s'])
    expect(subject.trim()).toBe('openground: sync')
  })

  it('nothing to commit and nothing new to pull: committed false, still ok', async () => {
    const { userA } = await makePair()
    await enableShared(userA)
    await shareSync(userA) // first sync commits + pushes the marker

    const again = await shareSync(userA)
    expect(again).toMatchObject({ ok: true, committed: false, pulled: true, pushed: true })
  })

  it('rebase conflict: aborts, returns conflict:true, repo left clean (not rebasing)', async () => {
    const { userA, userB } = await makePair()

    // A and B both create the same file with different content → add/add conflict.
    await enableShared(userA)
    await mkdir(join(userA, '.openground', 'board'), { recursive: true })
    await writeFile(boardNotesPath(userA), 'notes from A\n')
    expect((await shareSync(userA)).pushed).toBe(true)

    await enableShared(userB)
    await mkdir(join(userB, '.openground', 'board'), { recursive: true })
    await writeFile(boardNotesPath(userB), 'notes from B\n')
    const result = await shareSync(userB)

    expect(result.ok).toBe(false)
    expect(result.conflict).toBe(true)
    expect(result.committed).toBe(true) // B's local commit exists and is safe
    expect(result.pulled).toBe(false)
    expect(result.pushed).toBe(false)
    expect(result.message).toMatch(/resolve|pull/i)

    // The rebase was aborted: no rebase state dirs, clean working tree, and
    // B's own version of the file is back in place.
    await expect(stat(join(userB, '.git', 'rebase-merge'))).rejects.toThrow()
    await expect(stat(join(userB, '.git', 'rebase-apply'))).rejects.toThrow()
    expect((await git(userB, ['status', '--porcelain'])).trim()).toBe('')
    expect(await readFile(boardNotesPath(userB), 'utf-8')).toBe('notes from B\n')
  })
})

describe('enablePreconditions', () => {
  it('plain folder → not-git', async () => {
    const dir = join(scratch, 'plain')
    await mkdir(dir)
    expect(await enablePreconditions(dir)).toEqual({ ok: false, reason: 'not-git' })
  })

  it('already-shared repo → already-shared', async () => {
    const dir = await makeRepo('repo')
    await enableShared(dir)
    expect(await enablePreconditions(dir)).toEqual({ ok: false, reason: 'already-shared' })
  })

  it('.openground in .gitignore → ignored (sharing could never commit)', async () => {
    const dir = await makeRepo('ignoring')
    await writeFile(join(dir, '.gitignore'), '.openground/\n')
    expect(await enablePreconditions(dir)).toEqual({ ok: false, reason: 'ignored' })
  })

  it('clean git repo → ok', async () => {
    const dir = await makeRepo('clean')
    expect(await enablePreconditions(dir)).toEqual({ ok: true })
  })
})

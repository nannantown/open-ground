import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { mkdtemp, mkdir, rm, realpath, writeFile, readFile, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  shareStatus,
  shareSync,
  shareResolve,
  enablePreconditions,
  __resetShareFetchThrottle,
} from './gitShare'
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

// Each test shells out to dozens of real `git` subprocesses; the 5s default
// flakes under machine load. Generous per-file ceiling — passing tests still
// finish in ~1-3s each.
vi.setConfig({ testTimeout: 30_000 })

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
      branch: 'main',
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
      branch: 'main',
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

  it('S26 detached HEAD: blocked before anything is staged or committed', async () => {
    const { userA } = await makePair()
    await enableShared(userA)
    await shareSync(userA) // publish the marker so later HEADs are clean
    const head = (await git(userA, ['rev-parse', 'HEAD'])).trim()
    await git(userA, ['checkout', '--detach'])
    // New shared change while detached — must NOT be committed into the void.
    await mkdir(boardCardsDir(userA), { recursive: true })
    await writeFile(join(boardCardsDir(userA), 'float.json'), '{"id":"float"}\n')

    const result = await shareSync(userA)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('detached-head')
    expect(result.committed).toBe(false)
    // No floating commit was created; the change is still in the working tree.
    expect((await git(userA, ['rev-parse', 'HEAD'])).trim()).toBe(head)
    expect(await git(userA, ['status', '--porcelain', '--', '.openground'])).not.toBe('')
  })

  it("S29 user's own rebase in progress: blocked, their rebase state untouched", async () => {
    const { userA, userB } = await makePair()
    // Manufacture a real conflicted rebase OUTSIDE .openground (the user's own
    // code work): both sides edit README line 1, then A rebases onto B's push.
    await writeFile(join(userB, 'README.md'), '# theirs\n')
    await git(userB, ['commit', '-am', 'theirs'])
    await git(userB, ['push'])
    await writeFile(join(userA, 'README.md'), '# mine\n')
    await git(userA, ['commit', '-am', 'mine'])
    await git(userA, ['fetch'])
    await expect(git(userA, ['rebase', 'origin/main'])).rejects.toThrow() // stops on conflict
    await stat(join(userA, '.git', 'rebase-merge')) // mid-rebase, half the user's

    await enableShared(userA)
    const result = await shareSync(userA)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('rebase-in-progress')
    // The user's rebase was NOT aborted out from under them.
    await stat(join(userA, '.git', 'rebase-merge'))
    await git(userA, ['rebase', '--abort']) // fixture cleanup
  })

  it('S22 autostash restore conflict: loud ok:false, code kept in stash, board still synced', async () => {
    const { userA, userB } = await makePair()
    await enableShared(userA)
    expect((await shareSync(userA)).pushed).toBe(true)

    // B pushes a CODE change to README line 1.
    await git(userB, ['pull'])
    await writeFile(join(userB, 'README.md'), '# from B\n')
    await git(userB, ['commit', '-am', 'B code'])
    await git(userB, ['push'])

    // A has an UNCOMMITTED edit to the same line + a shared change to sync.
    await writeFile(join(userA, 'README.md'), '# from A, uncommitted\n')
    await mkdir(boardCardsDir(userA), { recursive: true })
    await writeFile(join(boardCardsDir(userA), 'a2.json'), '{"id":"a2","title":"A card"}\n')

    const result = await shareSync(userA)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('autostash-conflict')
    expect(result.committed).toBe(true)
    expect(result.pulled).toBe(true)
    expect(result.pushed).toBe(true) // the board change still made it out
    // The user's code edit is preserved in the stash.
    expect(await git(userA, ['stash', 'list'])).toMatch(/autostash/i)
  })

  it('S4 new branch without upstream: published automatically (push -u origin)', async () => {
    const { userA } = await makePair()
    await enableShared(userA)
    expect((await shareSync(userA)).pushed).toBe(true)

    await git(userA, ['switch', '-c', 'task/feature-x'])
    await mkdir(boardCardsDir(userA), { recursive: true })
    await writeFile(join(boardCardsDir(userA), 'fx.json'), '{"id":"fx","title":"on branch"}\n')

    const result = await shareSync(userA)
    expect(result.ok).toBe(true)
    expect(result.pushed).toBe(true)
    expect(result.message).toMatch(/published branch 'task\/feature-x'/)
    // Upstream tracking is now configured…
    const upstream = await git(userA, ['rev-parse', '--abbrev-ref', 'task/feature-x@{upstream}'])
    expect(upstream.trim()).toBe('origin/task/feature-x')
    // …so the next sync is a plain push/pull with no caveat.
    expect((await shareSync(userA)).message).toBeUndefined()
  })

  it('S24 push rejected mid-race: one transparent retry round succeeds', async () => {
    const { remote, userA } = await makePair()
    await enableShared(userA)
    expect((await shareSync(userA)).pushed).toBe(true)

    // A stateful pre-receive hook rejects exactly the FIRST push — simulating
    // a teammate landing a push between our pull and our push.
    const flag = join(scratch, 'first-push-rejected')
    const hook = join(remote, 'hooks', 'pre-receive')
    await writeFile(
      hook,
      `#!/bin/sh\nif [ ! -f "${flag}" ]; then\n  touch "${flag}"\n  echo "simulated race: rejecting first push" >&2\n  exit 1\nfi\nexit 0\n`,
    )
    await execFile('chmod', ['+x', hook])

    await mkdir(boardCardsDir(userA), { recursive: true })
    await writeFile(join(boardCardsDir(userA), 'race.json'), '{"id":"race","title":"raced"}\n')

    const result = await shareSync(userA)
    expect(result.ok).toBe(true)
    expect(result.pushed).toBe(true)
    expect(result.message ?? '').not.toMatch(/push failed/)
    // The commit really reached the remote on the retry.
    const remoteLog = await git(remote, ['log', '-1', '--pretty=%s', 'main'])
    expect(remoteLog.trim()).toBe('openground: sync')
  })

  it('S15 same card edited by both: conflict labels carry the card TITLE', async () => {
    const { userA, userB } = await makePair()
    await enableShared(userA)
    await mkdir(boardCardsDir(userA), { recursive: true })
    await writeFile(
      join(boardCardsDir(userA), 'c1.json'),
      JSON.stringify({ id: 'c1', title: 'Login flow' }, null, 2) + '\n',
    )
    expect((await shareSync(userA)).pushed).toBe(true)

    // B pulls, retitles the card, pushes. A retitles the SAME line differently.
    await git(userB, ['pull'])
    await writeFile(
      join(boardCardsDir(userB), 'c1.json'),
      JSON.stringify({ id: 'c1', title: 'Login flow (B)' }, null, 2) + '\n',
    )
    expect((await shareSync(userB)).pushed).toBe(true)
    await writeFile(
      join(boardCardsDir(userA), 'c1.json'),
      JSON.stringify({ id: 'c1', title: 'Login flow (A)' }, null, 2) + '\n',
    )

    const result = await shareSync(userA)
    expect(result.ok).toBe(false)
    expect(result.conflict).toBe(true)
    // The label reads back the LOCAL title after the abort restored it.
    expect(result.conflictFiles).toEqual(['card "Login flow (A)"'])
    expect(result.message).toContain('card "Login flow (A)"')
  })

  it('S28 no git identity: ok:false with reason no-identity', async () => {
    const { userA } = await makePair()
    await enableShared(userA)
    // A fresh machine: no configured identity. HOME is emptied AND
    // auto-detection (os user + hostname) is disabled — without the latter,
    // git on many machines invents an ident and the commit would succeed.
    await git(userA, ['config', 'user.useConfigOnly', 'true'])
    const bareHome = join(scratch, 'barehome')
    await mkdir(bareHome)
    const prevHome = process.env.HOME
    const prevXdg = process.env.XDG_CONFIG_HOME
    process.env.HOME = bareHome
    process.env.XDG_CONFIG_HOME = join(bareHome, '.config')
    try {
      const result = await shareSync(userA)
      expect(result.ok).toBe(false)
      expect(result.reason).toBe('no-identity')
      expect(result.committed).toBe(false)
    } finally {
      process.env.HOME = prevHome
      process.env.XDG_CONFIG_HOME = prevXdg
    }
  })

  it('S23 unreachable remote: offline flag set, commit kept locally, still ok', async () => {
    const { userA } = await makePair()
    await enableShared(userA)
    expect((await shareSync(userA)).pushed).toBe(true)
    // Point origin at a closed local port — "Connection refused" without DNS.
    await git(userA, ['remote', 'set-url', 'origin', 'http://127.0.0.1:1/nowhere.git'])
    await mkdir(boardCardsDir(userA), { recursive: true })
    await writeFile(join(boardCardsDir(userA), 'off.json'), '{"id":"off"}\n')

    const result = await shareSync(userA)
    expect(result.ok).toBe(true)
    expect(result.committed).toBe(true)
    expect(result.offline).toBe(true)
    expect(result.pushed).toBe(false)
    const subject = await git(userA, ['log', '-1', '--pretty=%s'])
    expect(subject.trim()).toBe('openground: sync')
  })

  it('S25 force-pushed upstream: status flags forcedUpdate (sticky), sync absorbs and reports it', async () => {
    const { userA, userB } = await makePair()
    await enableShared(userA)
    expect((await shareSync(userA)).pushed).toBe(true)

    // B rewrites the shared history: amend the tip and force-push.
    await git(userB, ['pull'])
    await mkdir(boardCardsDir(userB), { recursive: true })
    await writeFile(join(boardCardsDir(userB), 'b.json'), '{"id":"b"}\n')
    await git(userB, ['add', '-A'])
    await git(userB, ['commit', '-m', 'b card'])
    await git(userB, ['push'])
    // A fetches the honest state first…
    __resetShareFetchThrottle()
    expect((await shareStatus(userA)).forcedUpdate).toBeUndefined()
    // …then B rewrites it.
    await git(userB, ['commit', '--amend', '-m', 'b card (rewritten)'])
    await git(userB, ['push', '--force'])

    __resetShareFetchThrottle()
    const s1 = await shareStatus(userA)
    expect(s1.forcedUpdate).toBe(true)
    // Sticky across further quiet fetches until a sync absorbs it.
    __resetShareFetchThrottle()
    expect((await shareStatus(userA)).forcedUpdate).toBe(true)

    const sync = await shareSync(userA)
    expect(sync.ok).toBe(true)
    expect(sync.forcedUpdate).toBe(true)
    // Cleared after the absorbing sync.
    __resetShareFetchThrottle()
    expect((await shareStatus(userA)).forcedUpdate).toBeUndefined()
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
    // S20: the user is told WHAT conflicted — the notes file, by name.
    expect(result.conflictFiles).toEqual(['notes'])

    // The rebase was aborted: no rebase state dirs, clean working tree, and
    // B's own version of the file is back in place.
    await expect(stat(join(userB, '.git', 'rebase-merge'))).rejects.toThrow()
    await expect(stat(join(userB, '.git', 'rebase-apply'))).rejects.toThrow()
    expect((await git(userB, ['status', '--porcelain'])).trim()).toBe('')
    expect(await readFile(boardNotesPath(userB), 'utf-8')).toBe('notes from B\n')
  })
})

describe('shareResolve (conflict resolution)', () => {
  /** Same-card conflict fixture: A pushed title "(A version)", B holds a
   *  local commit with "(B version)" that conflicts on pull. Returns B's dir
   *  + the card path. */
  const makeCardConflict = async (): Promise<{ userB: string; cardRel: string }> => {
    const { userA, userB } = await makePair()
    await enableShared(userA)
    await mkdir(boardCardsDir(userA), { recursive: true })
    const write = (dir: string, version: string) =>
      writeFile(
        join(boardCardsDir(dir), 'c1.json'),
        JSON.stringify({ id: 'c1', title: `Login flow (${version})` }, null, 2) + '\n',
      )
    await write(userA, 'seed')
    expect((await shareSync(userA)).pushed).toBe(true)
    await git(userB, ['pull'])
    await write(userB, 'B version')
    expect((await shareSync(userB)).pushed).toBe(true)
    await write(userA, 'A version')
    expect((await shareSync(userA)).conflict).toBe(true) // A now holds the conflicting commit
    return { userB: userA, cardRel: '.openground/board/cards/c1.json' }
  }

  it('structured conflicts carry BOTH titles (mine = local, theirs = upstream)', async () => {
    const { userB } = await makeCardConflict()
    const result = await shareSync(userB) // re-sync → same conflict, structured
    expect(result.conflict).toBe(true)
    expect(result.conflicts).toHaveLength(1)
    const c = result.conflicts![0]
    expect(c.kind).toBe('card')
    expect(c.mine).toEqual({ exists: true, title: 'Login flow (A version)' })
    expect(c.theirs).toEqual({ exists: true, title: 'Login flow (B version)' })
  })

  it("choice 'mine' keeps the local version and pushes it", async () => {
    const { userB, cardRel } = await makeCardConflict()
    const result = await shareResolve(userB, { [cardRel]: 'mine' })
    expect(result).toMatchObject({ ok: true, pulled: true, pushed: true })
    const card = JSON.parse(await readFile(join(userB, cardRel), 'utf-8'))
    expect(card.title).toBe('Login flow (A version)')
    // Repo is clean and out of rebase.
    expect((await git(userB, ['status', '--porcelain'])).trim()).toBe('')
    // The remote agrees (a follow-up sync has nothing to do).
    const again = await shareSync(userB)
    expect(again).toMatchObject({ ok: true, committed: false, pulled: true, pushed: true })
  })

  it("choice 'theirs' takes the teammate's version (our emptied commit is skipped)", async () => {
    const { userB, cardRel } = await makeCardConflict()
    const result = await shareResolve(userB, { [cardRel]: 'theirs' })
    expect(result).toMatchObject({ ok: true, pulled: true })
    const card = JSON.parse(await readFile(join(userB, cardRel), 'utf-8'))
    expect(card.title).toBe('Login flow (B version)')
    expect((await git(userB, ['status', '--porcelain'])).trim()).toBe('')
  })

  it('delete/modify: teammate deleted, I edited — both choices behave', async () => {
    const { userA, userB } = await makePair()
    await enableShared(userA)
    await mkdir(boardCardsDir(userA), { recursive: true })
    await writeFile(
      join(boardCardsDir(userA), 'd1.json'),
      JSON.stringify({ id: 'd1', title: 'Doomed card' }, null, 2) + '\n',
    )
    expect((await shareSync(userA)).pushed).toBe(true)
    // B deletes the card and pushes.
    await git(userB, ['pull'])
    await rm(join(boardCardsDir(userB), 'd1.json'))
    expect((await shareSync(userB)).pushed).toBe(true)
    // A edits the same card → modify/delete conflict on sync.
    await writeFile(
      join(boardCardsDir(userA), 'd1.json'),
      JSON.stringify({ id: 'd1', title: 'Doomed card (edited)' }, null, 2) + '\n',
    )
    const conflicted = await shareSync(userA)
    expect(conflicted.conflict).toBe(true)
    const c = conflicted.conflicts![0]
    expect(c.mine.exists).toBe(true)
    expect(c.theirs.exists).toBe(false) // teammate deleted it

    // Keep mine → the card survives, with my edit.
    const keep = await shareResolve(userA, { [c.file]: 'mine' })
    expect(keep).toMatchObject({ ok: true, pushed: true })
    expect(JSON.parse(await readFile(join(userA, c.file), 'utf-8')).title).toBe(
      'Doomed card (edited)',
    )
  })

  it('an unmerged file WITHOUT a choice rolls back and returns the fresh conflict', async () => {
    const { userB, cardRel } = await makeCardConflict()
    const result = await shareResolve(userB, { '.openground/board/notes.md': 'mine' })
    expect(result.ok).toBe(false)
    expect(result.conflict).toBe(true)
    expect(result.conflicts?.some((c) => c.file === cardRel)).toBe(true)
    // Rolled back clean — no rebase state left behind.
    await expect(stat(join(userB, '.git', 'rebase-merge'))).rejects.toThrow()
    expect((await git(userB, ['status', '--porcelain'])).trim()).toBe('')
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

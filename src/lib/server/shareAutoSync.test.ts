import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { mkdtemp, mkdir, rm, realpath, writeFile, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  autoSyncTick,
  autoSyncSnapshot,
  autoSyncConflicts,
  ensureAutoSync,
  noteSharedWrite,
  nextInterval,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  __resetAutoSyncForTests,
  __setAutoSyncSchedulingForTests,
} from './shareAutoSync'
import { shareSync, __resetShareFetchThrottle } from './gitShare'
import { writeSharedMarker, boardCardsDir, SHARED_DATA_VERSION } from './sharedData'

// Engine rounds driven BY HAND (scheduling off — no timers in tests) against
// real git fixtures, same harness as gitShare.test.ts. What's pinned:
//  - adaptive cadence math (snap tight on activity, ×2 decay to the cap)
//  - a local shared edit auto-commits+pushes on the next round
//  - a teammate's push auto-applies on the next round
//  - CODE IS SACRED: one code commit ahead parks the engine (paused-code) —
//    nothing is committed, rebased, or pushed until the user pushes
//  - a conflict parks in 'conflict' with the structured set retrievable
//  - offline parks in 'offline' and keeps the pending push

const execFile = promisify(execFileCb)
const git = async (cwd: string, args: string[]): Promise<string> =>
  (await execFile('git', args, { cwd })).stdout

let scratch: string
let savedEnv: Record<string, string | undefined>

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-autosync-')))
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
  __setAutoSyncSchedulingForTests(false)
  __resetAutoSyncForTests()
  __resetShareFetchThrottle()
})

afterEach(async () => {
  __resetAutoSyncForTests()
  __setAutoSyncSchedulingForTests(true)
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(scratch, { recursive: true, force: true })
})

const makePair = async (): Promise<{ remote: string; userA: string; userB: string }> => {
  const seed = join(scratch, 'seed')
  await mkdir(seed)
  await git(seed, ['init'])
  await writeFile(join(seed, 'README.md'), '# seed\n')
  await git(seed, ['add', '.'])
  await git(seed, ['commit', '-m', 'init'])
  const remote = join(scratch, 'remote.git')
  await git(scratch, ['clone', '--bare', seed, remote])
  const userA = join(scratch, 'userA')
  const userB = join(scratch, 'userB')
  await git(scratch, ['clone', remote, userA])
  await git(scratch, ['clone', remote, userB])
  return { remote, userA, userB }
}

const enableShared = async (dir: string): Promise<void> => {
  await mkdir(join(dir, '.openground'), { recursive: true })
  await writeSharedMarker(dir, { version: SHARED_DATA_VERSION })
}

const writeCard = (dir: string, id: string, title: string) =>
  writeFile(
    join(boardCardsDir(dir), `${id}.json`),
    JSON.stringify({ id, title }, null, 2) + '\n',
  )

describe('nextInterval (adaptive cadence)', () => {
  it('activity snaps to the minimum; idleness doubles up to the cap', () => {
    expect(nextInterval(MAX_INTERVAL_MS, true)).toBe(MIN_INTERVAL_MS)
    expect(nextInterval(MIN_INTERVAL_MS, false)).toBe(MIN_INTERVAL_MS * 2)
    expect(nextInterval(MIN_INTERVAL_MS * 2, false)).toBe(MIN_INTERVAL_MS * 4)
    expect(nextInterval(MAX_INTERVAL_MS, false)).toBe(MAX_INTERVAL_MS)
    // Junk below the floor normalizes.
    expect(nextInterval(0, false)).toBe(MIN_INTERVAL_MS * 2)
  })
})

describe('autoSyncTick', () => {
  it('idle round: stays live and decays the interval', async () => {
    const { userA } = await makePair()
    await enableShared(userA)
    expect((await shareSync(userA)).pushed).toBe(true)

    ensureAutoSync(userA, true)
    await autoSyncTick(userA)
    const snap = autoSyncSnapshot(userA)
    expect(snap.mode).toBe('live')
    expect(snap.intervalMs).toBe(MIN_INTERVAL_MS * 2)
  })

  it('a local shared edit pushes itself on the next round', async () => {
    const { remote, userA } = await makePair()
    await enableShared(userA)
    expect((await shareSync(userA)).pushed).toBe(true)

    await mkdir(boardCardsDir(userA), { recursive: true })
    await writeCard(userA, 'auto1', 'pushed by the engine')
    ensureAutoSync(userA, true)
    noteSharedWrite(userA)
    expect(autoSyncSnapshot(userA).pendingPush).toBe(true)

    await autoSyncTick(userA)
    const snap = autoSyncSnapshot(userA)
    expect(snap.mode).toBe('live')
    expect(snap.pendingPush).toBe(false)
    expect(snap.lastSyncAt).not.toBeNull()
    expect(snap.intervalMs).toBe(MIN_INTERVAL_MS) // a sync IS activity
    const remoteFiles = await git(remote, ['ls-tree', '-r', '--name-only', 'main'])
    expect(remoteFiles).toContain('.openground/board/cards/auto1.json')
  })

  it("a teammate's push applies itself on the next round", async () => {
    const { userA, userB } = await makePair()
    await enableShared(userA)
    expect((await shareSync(userA)).pushed).toBe(true)
    await git(userB, ['pull'])
    await mkdir(boardCardsDir(userB), { recursive: true })
    await writeCard(userB, 'fromB', 'teammate card')
    expect((await shareSync(userB)).pushed).toBe(true)

    ensureAutoSync(userA, true)
    await autoSyncTick(userA)
    expect(autoSyncSnapshot(userA).mode).toBe('live')
    const card = JSON.parse(
      await readFile(join(boardCardsDir(userA), 'fromB.json'), 'utf-8'),
    )
    expect(card.title).toBe('teammate card')
  })

  it('CODE IS SACRED: a code commit ahead parks everything (paused-code)', async () => {
    const { remote, userA } = await makePair()
    await enableShared(userA)
    expect((await shareSync(userA)).pushed).toBe(true)
    const remoteHead = (await git(remote, ['rev-parse', 'main'])).trim()

    // The user's own unpushed CODE commit + a fresh shared edit.
    await writeFile(join(userA, 'feature.ts'), 'export const x = 1\n')
    await git(userA, ['add', 'feature.ts'])
    await git(userA, ['commit', '-m', 'wip code'])
    await mkdir(boardCardsDir(userA), { recursive: true })
    await writeCard(userA, 'held', 'held back')
    ensureAutoSync(userA, true)
    noteSharedWrite(userA)

    await autoSyncTick(userA)
    const snap = autoSyncSnapshot(userA)
    expect(snap.mode).toBe('paused-code')
    expect(snap.pendingPush).toBe(true) // not forgotten — just not OURS to send
    // Nothing was committed, rebased, or pushed.
    expect((await git(remote, ['rev-parse', 'main'])).trim()).toBe(remoteHead)
    expect(await git(userA, ['status', '--porcelain', '--', '.openground'])).not.toBe('')
    expect((await git(userA, ['log', '-1', '--pretty=%s'])).trim()).toBe('wip code')

    // The user pushes their code themselves → the next round flows again.
    await git(userA, ['push'])
    await autoSyncTick(userA)
    expect(autoSyncSnapshot(userA).mode).toBe('live')
    const remoteFiles = await git(remote, ['ls-tree', '-r', '--name-only', 'main'])
    expect(remoteFiles).toContain('.openground/board/cards/held.json')
  })

  it('a conflict parks in mode conflict with the structured set retrievable', async () => {
    const { userA, userB } = await makePair()
    await enableShared(userA)
    await mkdir(boardCardsDir(userA), { recursive: true })
    await writeCard(userA, 'c1', 'Title (seed)')
    expect((await shareSync(userA)).pushed).toBe(true)
    await git(userB, ['pull'])
    await writeCard(userB, 'c1', 'Title (B)')
    expect((await shareSync(userB)).pushed).toBe(true)
    await writeCard(userA, 'c1', 'Title (A)')

    ensureAutoSync(userA, true)
    noteSharedWrite(userA)
    await autoSyncTick(userA)
    expect(autoSyncSnapshot(userA).mode).toBe('conflict')
    const conflicts = autoSyncConflicts(userA)
    expect(conflicts).toHaveLength(1)
    expect(conflicts![0].mine.title).toBe('Title (A)')
    expect(conflicts![0].theirs.title).toBe('Title (B)')
    // Repo rolled back clean (shareSync's abort) — no rebase residue.
    expect(await git(userA, ['status', '--porcelain', '--', 'README.md'])).toBe('')
  })

  it('offline parks in mode offline and keeps the pending push', async () => {
    const { userA } = await makePair()
    await enableShared(userA)
    expect((await shareSync(userA)).pushed).toBe(true)
    await git(userA, ['remote', 'set-url', 'origin', 'http://127.0.0.1:1/nowhere.git'])
    await mkdir(boardCardsDir(userA), { recursive: true })
    await writeCard(userA, 'off1', 'offline edit')
    ensureAutoSync(userA, true)
    noteSharedWrite(userA)

    await autoSyncTick(userA)
    const snap = autoSyncSnapshot(userA)
    expect(snap.mode).toBe('offline')
    expect(snap.pendingPush).toBe(true)
  })

  it('disabled pref parks the engine; unshared project drops its state', async () => {
    const { userA } = await makePair()
    await enableShared(userA)
    ensureAutoSync(userA, false)
    expect(autoSyncSnapshot(userA).mode).toBe('disabled')
    await autoSyncTick(userA) // no-op while disabled
    expect(autoSyncSnapshot(userA).mode).toBe('disabled')

    // Re-enable on a NON-shared dir → first tick forgets the project.
    const plain = join(scratch, 'plain')
    await mkdir(plain)
    await git(plain, ['init'])
    ensureAutoSync(plain, true)
    await autoSyncTick(plain)
    expect(autoSyncSnapshot(plain).enabled).toBe(false) // state dropped → default
  })
})

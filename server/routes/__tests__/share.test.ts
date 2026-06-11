import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { mkdtemp, mkdir, rm, realpath, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from '../../app'
import { __resetMigrationCacheForTests } from '@/lib/server/registry'
import { writeSharedMarker, SHARED_DATA_VERSION } from '@/lib/server/sharedData'
import {
  __resetAutoSyncForTests,
  __setAutoSyncSchedulingForTests,
} from '@/lib/server/shareAutoSync'

// Route-level tests for /api/project/share/* (Track C): the security boundary
// (validateProjectPath — registry as allowlist) plus a happy path against a
// REAL git fixture registered as a project in an isolated OPENGROUND_HOME.
// The engine's behavioural matrix lives in src/lib/server/gitShare.test.ts;
// here we pin the HTTP contract: status codes, shapes, and that the routes
// refuse unregistered paths BEFORE any git command runs in them.

const execFile = promisify(execFileCb)
const git = async (cwd: string, args: string[]): Promise<string> =>
  (await execFile('git', args, { cwd })).stdout

const ETC = '/etc' // registered by NOBODY → 403

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

let home: string
let scratch: string
let savedEnv: Record<string, string | undefined>

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-share-home-')))
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-share-scratch-')))
  process.env.OPENGROUND_HOME = home
  __resetMigrationCacheForTests()
  __setAutoSyncSchedulingForTests(false)
  __resetAutoSyncForTests()

  // Keep git away from the machine's real global/system config (identity,
  // gpgsign, …) — same isolation as gitShare.test.ts.
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
  await rm(home, { recursive: true, force: true })
  await rm(scratch, { recursive: true, force: true })
})

/** Make a git repo with one commit and REGISTER it (the allowlist) via the
 *  real import route, so validateProjectPath passes for it. */
const makeRegisteredRepo = async (name: string): Promise<string> => {
  const dir = join(scratch, name)
  await mkdir(dir)
  await git(dir, ['init'])
  await writeFile(join(dir, 'README.md'), `# ${name}\n`)
  await git(dir, ['add', '.'])
  await git(dir, ['commit', '-m', 'init'])
  const res = await app.request('/api/projects/import', json({ path: dir }))
  expect(res.status).toBe(200)
  return dir
}

describe('share routes — security boundary', () => {
  it('GET /api/project/share/status?path=/etc → 403', async () => {
    const res = await app.request(
      `/api/project/share/status?path=${encodeURIComponent(ETC)}`,
    )
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/not allowed/i)
  })

  it('GET /api/project/share/status (no path) → 400', async () => {
    const res = await app.request('/api/project/share/status')
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/required/i)
  })

  it('POST /api/project/share/sync {path:/etc} → 403 (before any git side effect)', async () => {
    const res = await app.request('/api/project/share/sync', json({ path: ETC }))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/not allowed/i)
  })

  it('POST /api/project/share/sync {} (no path) → 400', async () => {
    const res = await app.request('/api/project/share/sync', json({}))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/required/i)
  })
})

describe('share routes — contract on a registered git project', () => {
  it('status → sync → status reflects the full ShareStatus/ShareSyncResult shapes', async () => {
    const dir = await makeRegisteredRepo('shared-app')
    await mkdir(join(dir, '.openground'), { recursive: true })
    await writeSharedMarker(dir, { version: SHARED_DATA_VERSION })

    // Shared + uncommitted marker → dirty. No remote → remoteUrl null.
    let res = await app.request(
      `/api/project/share/status?path=${encodeURIComponent(dir)}`,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      shared: true,
      gitRepo: true,
      remoteUrl: null,
      dirty: true,
      ahead: 0,
      behind: 0,
      branch: 'main',
      auto: {
        enabled: true,
        mode: 'live',
        lastSyncAt: null,
        pendingPush: false,
        intervalMs: 15000,
      },
    })

    // Sync: commits locally; pull/push have no remote to talk to → soft-skip
    // with a message, NOT an error (the pinned no-upstream contract).
    res = await app.request('/api/project/share/sync', json({ path: dir }))
    expect(res.status).toBe(200)
    const sync = await res.json()
    expect(sync).toMatchObject({ ok: true, committed: true, pulled: false, pushed: false })
    expect(sync.message).toBeTruthy()

    // The dot goes away: nothing dirty under .openground/ anymore.
    res = await app.request(
      `/api/project/share/status?path=${encodeURIComponent(dir)}`,
    )
    expect((await res.json()).dirty).toBe(false)
  })

  it('resolve: 400 without usable choices; works as a plain sync when nothing conflicts', async () => {
    const dir = await makeRegisteredRepo('resolve-guards')
    await mkdir(join(dir, '.openground'), { recursive: true })
    await writeSharedMarker(dir, { version: SHARED_DATA_VERSION })

    let res = await app.request('/api/project/share/resolve', json({ path: dir }))
    expect(res.status).toBe(400)
    res = await app.request(
      '/api/project/share/resolve',
      json({ path: dir, choices: { x: 'bogus' } }),
    )
    expect(res.status).toBe(400)

    // Valid choices but no conflict → behaves like a sync (commits the marker).
    res = await app.request(
      '/api/project/share/resolve',
      json({ path: dir, choices: { '.openground/board/notes.md': 'mine' } }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.committed).toBe(true)
  })

  it('status on a registered non-shared project: plain falses, no error', async () => {
    const dir = await makeRegisteredRepo('plain-app')
    const res = await app.request(
      `/api/project/share/status?path=${encodeURIComponent(dir)}`,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      shared: false,
      gitRepo: true,
      remoteUrl: null,
      dirty: false,
      ahead: 0,
      behind: 0,
      branch: 'main',
    })
  })
})

describe('share routes — enable / disable (integration)', () => {
  const CARD = {
    id: 'card-enable-test-1',
    title: 'Shared card',
    done: false,
    createdAt: '2026-06-10T00:00:00.000Z',
    boardColumn: 'todo',
  }

  /** Seed board data through the real PUT route (exercises the adapter the
   *  same way the UI does), plus one canvas via the canvases route. */
  const seedProject = async (dir: string): Promise<void> => {
    let res = await app.request(
      `/api/project?path=${encodeURIComponent(dir)}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          description: 'A shared project',
          tasks: [CARD],
          notes: 'shared notes',
          updatedAt: '2026-06-10T00:00:00.000Z',
        }),
      },
    )
    expect(res.status).toBe(200)
    res = await app.request(
      `/api/project/canvases?action=create`,
      json({ path: dir, name: 'Canvas 1' }),
    )
    expect(res.status).toBe(200)
  }

  it('enable migrates board+canvas into the repo; reads come back from it; disable round-trips home', async () => {
    const dir = await makeRegisteredRepo('to-share')
    await seedProject(dir)

    let res = await app.request('/api/project/share/enable', json({ path: dir }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    // The repo layout exists: marker (with the shared description), the card
    // file, notes.md, and the shared canvas index.
    const markerRaw = await app.request(
      `/api/project/share/status?path=${encodeURIComponent(dir)}`,
    )
    expect(((await markerRaw.json()) as { shared: boolean }).shared).toBe(true)
    const { readFile, stat } = await import('fs/promises')
    const marker = JSON.parse(
      await readFile(join(dir, '.openground', 'openground.json'), 'utf-8'),
    )
    expect(marker.version).toBe(SHARED_DATA_VERSION)
    expect(marker.description).toBe('A shared project')
    await expect(
      stat(join(dir, '.openground', 'board', 'cards', `${CARD.id}.json`)),
    ).resolves.toBeTruthy()
    await expect(
      stat(join(dir, '.openground', 'canvas', 'index.json')),
    ).resolves.toBeTruthy()

    // GET /api/project now serves from the repo — same data, byte-equal task.
    res = await app.request(`/api/project?path=${encodeURIComponent(dir)}`)
    const data = await res.json()
    expect(data.tasks).toHaveLength(1)
    expect(data.tasks[0]).toMatchObject(CARD)
    expect(data.notes).toBe('shared notes')
    expect(data.description).toBe('A shared project')

    // Double-enable → 412 already-shared.
    res = await app.request('/api/project/share/enable', json({ path: dir }))
    expect(res.status).toBe(412)
    expect((await res.json()).reason).toBe('already-shared')

    // Disable: data returns home, the folder is gone, reads still work.
    res = await app.request('/api/project/share/disable', json({ path: dir }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    await expect(stat(join(dir, '.openground'))).rejects.toThrow()
    res = await app.request(`/api/project?path=${encodeURIComponent(dir)}`)
    const back = await res.json()
    expect(back.tasks[0]).toMatchObject(CARD)
    expect(back.notes).toBe('shared notes')
  })

  it('enable on a non-git registered folder → 412 not-git', async () => {
    const dir = join(scratch, 'no-git')
    await mkdir(dir)
    const imp = await app.request('/api/projects/import', json({ path: dir }))
    expect(imp.status).toBe(200)
    const res = await app.request('/api/project/share/enable', json({ path: dir }))
    expect(res.status).toBe(412)
    expect((await res.json()).reason).toBe('not-git')
  })

  it('enable when .gitignore swallows .openground → 412 ignored', async () => {
    const dir = await makeRegisteredRepo('ignored-app')
    await writeFile(join(dir, '.gitignore'), '.openground/\n')
    const res = await app.request('/api/project/share/enable', json({ path: dir }))
    expect(res.status).toBe(412)
    expect((await res.json()).reason).toBe('ignored')
  })

  it('disable on a non-shared project → 412', async () => {
    const dir = await makeRegisteredRepo('not-shared')
    const res = await app.request('/api/project/share/disable', json({ path: dir }))
    expect(res.status).toBe(412)
  })
})

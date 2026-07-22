import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, realpath, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from '../../app'
import { __resetMigrationCacheForTests } from '@/lib/server/registry'
import type { ProjectSkill } from '@/lib/types'

// GET /api/project/skills against the real Hono app, with OPENGROUND_HOME on a
// throwaway dir so the registry (the validateProjectPath allowlist) starts empty.

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

let home: string
let scratch: string

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-skills-home-')))
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-skills-scratch-')))
  process.env.OPENGROUND_HOME = home
  __resetMigrationCacheForTests()
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(scratch, { recursive: true, force: true })
})

const register = async (dir: string) => {
  await mkdir(dir, { recursive: true })
  const res = await app.request('/api/projects/import', json({ path: dir }))
  expect(res.status).toBe(200)
}

describe('GET /api/project/skills', () => {
  it('lists the skills under a registered project', async () => {
    const dir = join(scratch, 'app')
    await register(dir)
    const skillDir = join(dir, '.claude', 'skills', 'commit-helper')
    await mkdir(skillDir, { recursive: true })
    await writeFile(
      join(skillDir, 'SKILL.md'),
      '---\nname: Commit Helper\ndescription: Conventional commits\n---\nbody',
    )

    const res = await app.request(`/api/project/skills?path=${encodeURIComponent(dir)}`)
    expect(res.status).toBe(200)
    const skills = (await res.json()).skills as ProjectSkill[]
    expect(skills).toEqual([
      {
        id: 'commit-helper',
        name: 'Commit Helper',
        description: 'Conventional commits',
        file: '.claude/skills/commit-helper/SKILL.md',
      },
    ])
  })

  it('returns { skills: [] } for a project with no .claude/skills', async () => {
    const dir = join(scratch, 'empty')
    await register(dir)
    const res = await app.request(`/api/project/skills?path=${encodeURIComponent(dir)}`)
    expect(res.status).toBe(200)
    expect((await res.json()).skills).toEqual([])
  })

  it('rejects an unregistered path (403) and a missing path (400)', async () => {
    const outside = await app.request(
      `/api/project/skills?path=${encodeURIComponent(join(scratch, 'nope'))}`,
    )
    expect(outside.status).toBe(403)

    const noPath = await app.request('/api/project/skills')
    expect(noPath.status).toBe(400)
  })
})

describe('GET /api/skills/global', () => {
  // os.homedir() honours $HOME dynamically (the suite isolates OPENGROUND_HOME
  // but NOT HOME), so point HOME at a throwaway dir — the route must never read
  // the real ~/.claude/skills, and the assertion must be deterministic.
  let realHome: string | undefined
  let fakeHome: string
  beforeEach(async () => {
    realHome = process.env.HOME
    fakeHome = await realpath(await mkdtemp(join(tmpdir(), 'og-skills-fakehome-')))
    process.env.HOME = fakeHome
  })
  afterEach(async () => {
    // Restore, never delete: with HOME unset os.homedir() falls back to the
    // passwd entry — i.e. straight back at the REAL home this block exists to
    // avoid. See src/lib/server/testHomeGuard.ts.
    if (realHome !== undefined) process.env.HOME = realHome
    await rm(fakeHome, { recursive: true, force: true })
  })

  it("lists the user's global ~/.claude/skills", async () => {
    const skillDir = join(fakeHome, '.claude', 'skills', 'committer')
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: Committer\ndescription: commits\n---')

    const res = await app.request('/api/skills/global')
    expect(res.status).toBe(200)
    expect((await res.json()).skills as ProjectSkill[]).toEqual([
      {
        id: 'committer',
        name: 'Committer',
        description: 'commits',
        file: '~/.claude/skills/committer/SKILL.md',
      },
    ])
  })

  it('returns { skills: [] } when the user has no ~/.claude/skills', async () => {
    const res = await app.request('/api/skills/global')
    expect(res.status).toBe(200)
    expect((await res.json()).skills).toEqual([])
  })
})

describe('POST /api/skills/global/create (validation)', () => {
  // Only the pre-claude validation paths — they 400 BEFORE any one-off `claude`
  // is spawned, so this never touches the CLI or the subscription. The happy
  // path is covered by generateSkill.test.ts (mocked PTY).
  it('rejects an empty request (400)', async () => {
    const res = await app.request('/api/skills/global/create', json({ request: '   ' }))
    expect(res.status).toBe(400)
  })

  it('rejects a missing request (400)', async () => {
    const res = await app.request('/api/skills/global/create', json({}))
    expect(res.status).toBe(400)
  })

  it('rejects an over-long request (400)', async () => {
    const res = await app.request('/api/skills/global/create', json({ request: 'x'.repeat(2001) }))
    expect(res.status).toBe(400)
  })
})

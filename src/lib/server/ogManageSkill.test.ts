import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { installOgManageSkill, OG_MANAGE_SKILL_MARKER } from './ogManageSkill'

// The installer's ownership contract, exercised against a throwaway tmpdir —
// never the real ~/.claude (source AND target are injected via the test-only
// opts). The real skill text ships at <repo>/skills/og-manage/SKILL.md; a
// separate test below pins that the SHIPPED file actually carries the marker
// (the installer refuses a marker-less source, so a marker regression in the
// shipped file would silently stop every install).

let dir: string
let src: string
let dst: string

const SHIPPED = `---\nname: og-manage\n---\n<!-- ${OG_MANAGE_SKILL_MARKER} -->\n\n# og-manage v2\n`

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'og-skill-'))
  src = join(dir, 'source', 'SKILL.md')
  dst = join(dir, 'home', '.claude', 'skills', 'og-manage', 'SKILL.md')
  await mkdir(join(dir, 'source'), { recursive: true })
  await writeFile(src, SHIPPED, 'utf8')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const run = () => installOgManageSkill({ sourceFile: src, targetFile: dst })

describe('installOgManageSkill', () => {
  it('installs when the target is missing (creates the whole skills dir chain)', async () => {
    const r = await run()
    expect(r.outcome).toBe('installed')
    expect(await readFile(dst, 'utf8')).toBe(SHIPPED)
  })

  it('is idempotent — a second run on an identical target is unchanged', async () => {
    await run()
    const r = await run()
    expect(r.outcome).toBe('unchanged')
  })

  it('refreshes a stale managed copy (version-follow on app update)', async () => {
    await mkdir(join(dir, 'home', '.claude', 'skills', 'og-manage'), { recursive: true })
    await writeFile(dst, `<!-- ${OG_MANAGE_SKILL_MARKER} -->\n# old version\n`, 'utf8')
    const r = await run()
    expect(r.outcome).toBe('refreshed')
    expect(await readFile(dst, 'utf8')).toBe(SHIPPED)
  })

  it('NEVER overwrites a user-authored file (no marker) — kept-user', async () => {
    await mkdir(join(dir, 'home', '.claude', 'skills', 'og-manage'), { recursive: true })
    const users = '# my own og-manage skill\n'
    await writeFile(dst, users, 'utf8')
    const r = await run()
    expect(r.outcome).toBe('kept-user')
    expect(await readFile(dst, 'utf8')).toBe(users) // byte-untouched
  })

  it('reports error (and writes nothing) when the source is unreadable', async () => {
    await rm(src)
    const r = await run()
    expect(r.outcome).toBe('error')
    await expect(stat(dst)).rejects.toThrow() // target never created
  })

  it('refuses a source that lost the managed-by marker (would strand future updates)', async () => {
    await writeFile(src, '# marker-less source\n', 'utf8')
    const r = await run()
    expect(r.outcome).toBe('error')
    expect(r.error).toContain('marker')
    await expect(stat(dst)).rejects.toThrow()
  })
})

describe('shipped skill source (skills/og-manage/SKILL.md)', () => {
  // vitest runs with cwd = the repo root — the same resolution the production
  // installer uses (process.cwd() + skills/og-manage/SKILL.md).
  const shippedPath = join(process.cwd(), 'skills', 'og-manage', 'SKILL.md')

  it('exists, carries the managed-by marker, and declares the og-manage skill', async () => {
    const text = await readFile(shippedPath, 'utf8')
    expect(text).toContain(OG_MANAGE_SKILL_MARKER)
    expect(text.startsWith('---\n')).toBe(true) // claude skill frontmatter
    expect(text).toContain('name: og-manage')
  })

  it('never mentions tmux — the whole point of the in-app commander protocol', async () => {
    const text = await readFile(shippedPath, 'utf8')
    expect(text.toLowerCase()).not.toContain('tmux')
    // …and never points at the tmux-cockpit helper scripts either (swarm-beat
    // is the WORKER's heartbeat writer, swarm-board the tmux-free Board bridge —
    // both fine; the pane/cockpit/watch/respawn family is not).
    for (const banned of ['swarm-pane.sh', 'swarm-cockpit.sh', 'swarm-watch.sh', 'swarm-respawn.sh', 'swarm-janitor.sh', 'swarm-new.sh', 'swarm-dispatch.sh']) {
      expect(text).not.toContain(banned)
    }
  })

  it('drives the app HTTP API for every commander action', async () => {
    const text = await readFile(shippedPath, 'utf8')
    for (const api of [
      '/api/swarm/worker',
      '/api/swarm/workers',
      '/api/swarm/orchestrator',
      '/api/swarm/worktree/remove',
      '/api/terminal/',
    ]) {
      expect(text).toContain(api)
    }
  })
})

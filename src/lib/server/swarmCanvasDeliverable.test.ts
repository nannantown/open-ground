import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from 'fs/promises'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  classifyWorker,
  hasCanvasDeliverable,
  defaultDeps,
  CANVAS_SHOT_SUFFIXES,
  type WorkerProbe,
} from './swarmOrchestrator'
import { taskAssetPath, writeTaskAsset } from './taskAssets'
import { registerTestProject } from '../../test/registerProject'

// Owner report 2026-10-01: a card whose deliverable is figures on a Canvas has
// 0 commits by construction and was parked as "ready without work". HOME is
// tmpdir-isolated (setup-home.ts).

const LIGHT = 'a'.repeat(40) + '.png'
const DARK = 'b'.repeat(40) + '.png'
const shots = [
  { id: LIGHT, name: `図${CANVAS_SHOT_SUFFIXES[0]}`, mime: 'image/png' },
  { id: DARK, name: `図${CANVAS_SHOT_SUFFIXES[1]}`, mime: 'image/png' },
]
const startedAt = '2026-10-01T00:00:00.000Z'
const START = Date.parse(startedAt)

describe('classifyWorker — a Canvas deliverable is work', () => {
  const probe = (over: Partial<WorkerProbe> = {}): WorkerProbe => ({ alive: true, commitsAhead: 0, heartbeat: null, ...over })
  const ready = { ready: true, blocked: false }

  it('THE INCIDENT: ready + 0 commits + canvas evidence ⇒ promoted, not ready-without-work', () => {
    expect(classifyWorker(probe({ heartbeat: ready, canvasDeliverable: true }), true)).toEqual({ promote: true, stage: 'done' })
  })

  it('the 2026-09-13 guard keeps its teeth: ready + 0 commits + no canvas evidence ⇒ flagged', () => {
    const v = classifyWorker(probe({ heartbeat: ready, canvasDeliverable: false }), true)
    expect(v.promote).toBe(false)
    expect(v.readyWithoutWork).toBe(true)
  })

  it('evidence alone never promotes — the worker must also declare ready', () => {
    expect(classifyWorker(probe({ heartbeat: null, canvasDeliverable: true }), true).promote).toBe(false)
    expect(classifyWorker(probe({ alive: false, heartbeat: null, canvasDeliverable: true }), true).promote).toBe(false)
  })
})

describe('hasCanvasDeliverable — a light AND a dark shot, both written during this run', () => {
  const fresh = async () => true
  it('both shots fresh ⇒ true, each asset asked about, measured from startedAt', async () => {
    const asked: [string, number][] = []
    const ok = await hasCanvasDeliverable('/p', { attachments: shots }, startedAt, async (_p, id, since) => {
      asked.push([id, since])
      return true
    })
    expect(ok).toBe(true)
    expect(asked).toEqual([
      [LIGHT, START],
      [DARK, START],
    ])
  })
  it('a code card (no shots, only one of the two, or a look-alike name) ⇒ false', async () => {
    expect(await hasCanvasDeliverable('/p', {}, startedAt, fresh)).toBe(false)
    expect(await hasCanvasDeliverable('/p', { attachments: [shots[0]] }, startedAt, fresh)).toBe(false)
    expect(await hasCanvasDeliverable('/p', { attachments: [shots[1]] }, startedAt, fresh)).toBe(false)
    expect(
      await hasCanvasDeliverable('/p', { attachments: [{ ...shots[0], name: 'mycanvas-light.png' }, shots[1]] }, startedAt, fresh),
    ).toBe(false)
  })
  it('stale shots from an earlier run ⇒ false; one stale of the two ⇒ false', async () => {
    expect(await hasCanvasDeliverable('/p', { attachments: shots }, startedAt, async () => false)).toBe(false)
    expect(await hasCanvasDeliverable('/p', { attachments: shots }, startedAt, async (_p, id) => id === LIGHT)).toBe(false)
  })
  it('an older stale pair plus a fresh re-shoot pair ⇒ true', async () => {
    const old = [
      { ...shots[0], id: 'c'.repeat(40) + '.png' },
      { ...shots[1], id: 'd'.repeat(40) + '.png' },
    ]
    expect(await hasCanvasDeliverable('/p', { attachments: [...old, ...shots] }, startedAt, async (_p, id) => id === LIGHT || id === DARK)).toBe(true)
  })
  it('no proof ⇒ false: missing dep, unparseable startedAt, a throwing dep', async () => {
    expect(await hasCanvasDeliverable('/p', { attachments: shots }, startedAt, undefined)).toBe(false)
    expect(await hasCanvasDeliverable('/p', { attachments: shots }, 'nope', fresh)).toBe(false)
    expect(
      await hasCanvasDeliverable('/p', { attachments: shots }, startedAt, async () => {
        throw new Error('fs')
      }),
    ).toBe(false)
  })
})

describe('default taskAssetWrittenSince — the asset file mtime in central task-assets', () => {
  let projectPath: string
  beforeEach(async () => {
    projectPath = await mkdtemp(join(tmpdir(), 'og-canvas-deliverable-'))
    await registerTestProject(projectPath)
  })
  afterEach(async () => {
    await rm(projectPath, { recursive: true, force: true })
  })

  it('written after start ⇒ true; before ⇒ false; a re-upload refreshes it; missing / invalid id ⇒ throws (caller reads false)', async () => {
    const written = defaultDeps().taskAssetWrittenSince!
    const id = await writeTaskAsset(projectPath, 'image/png', Buffer.from('png-bytes'))
    const file = await taskAssetPath(projectPath, id)
    const before = new Date(START - 60_000)
    await utimes(file, before, before)
    expect(await written(projectPath, id, START)).toBe(false)
    const after = new Date(START + 60_000)
    await utimes(file, after, after)
    expect(await written(projectPath, id, START)).toBe(true)
    await utimes(file, before, before)
    await writeTaskAsset(projectPath, 'image/png', Buffer.from('png-bytes')) // same bytes, same id
    expect(await written(projectPath, id, Date.now() - 60_000)).toBe(true)
    await expect(written(projectPath, 'e'.repeat(40) + '.png', START)).rejects.toThrow()
    await expect(written(projectPath, '../x.png', START)).rejects.toThrow()
    expect(await hasCanvasDeliverable(projectPath, { attachments: [{ id: '../x.png', name: 'x-canvas-light.png', mime: 'image/png' }, { id, name: 'x-canvas-dark.png', mime: 'image/png' }] }, startedAt, written)).toBe(false)
  })
})

describe('default worktreeIsClean — git status, minus the node_modules symlink, fail-closed', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'og-canvas-clean-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('clean ⇒ true; node_modules symlink only ⇒ true; untracked file ⇒ false; not a repo ⇒ false', async () => {
    const clean = defaultDeps().worktreeIsClean!
    expect(await clean(dir)).toBe(false) // not a git repo: no proof ⇒ not clean
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
    git('init', '-q')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')
    expect(await clean(dir)).toBe(true)
    const shared = await mkdtemp(join(tmpdir(), 'og-canvas-nm-'))
    await symlink(shared, join(dir, 'node_modules'))
    expect(await clean(dir)).toBe(true)
    await mkdir(join(dir, 'src'))
    await writeFile(join(dir, 'src', 'feature.ts'), 'export {}\n')
    expect(await clean(dir)).toBe(false)
    await rm(shared, { recursive: true, force: true })
  })

  it('a REAL node_modules/ directory (not the shared symlink) ⇒ false; a modified tracked file ⇒ false', async () => {
    const clean = defaultDeps().worktreeIsClean!
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
    git('init', '-q')
    await writeFile(join(dir, 'a.ts'), 'export const a = 1\n')
    git('add', 'a.ts')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init')
    expect(await clean(dir)).toBe(true)
    await mkdir(join(dir, 'node_modules'))
    await writeFile(join(dir, 'node_modules', 'x.js'), '')
    expect(await clean(dir)).toBe(false)
    await rm(join(dir, 'node_modules'), { recursive: true, force: true })
    expect(await clean(dir)).toBe(true)
    await writeFile(join(dir, 'a.ts'), 'export const a = 2\n')
    expect(await clean(dir)).toBe(false)
  })
})

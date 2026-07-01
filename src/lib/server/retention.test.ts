import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, utimes, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { pruneOldRunFiles, pruneOldAttachments, RAW_RETENTION_DAYS } from './retention'
import { runsDir } from './paths'
import { projectDataDir } from './projectDataPath'
import { registerTestProject } from '../../test/registerProject'

// Retention safety (goal condition 3): the boot sweep must NEVER delete LIVE
// data. It is scoped to the EPISODIC layer only — the legacy run cache
// (~/.openground/runs/*.json) and per-project task-attachments/. tasks.json,
// canvases, and the canvas index must be untouchable by it. HOME is the
// throwaway test home (setup-home.ts), so runsDir() and projectDataDir() resolve
// under tmpdir, never the real ~/.openground.
//
// Determinism: the retention window is RAW_RETENTION_DAYS (14d). Every age here
// is FAR from that boundary — "old" = 30d ago, "recent" = 1h ago — so a busy CPU
// can never flip a near-boundary case (the card 9961d28d flaky lesson). Ages are
// pinned with utimes (mtime) and explicit past/future ISO `finishedAt`, never
// real sleeps.

const DAY_MS = 24 * 60 * 60 * 1000
const OLD = () => new Date(Date.now() - 30 * DAY_MS) // well past the 14d window
const RECENT = () => new Date(Date.now() - 60 * 60 * 1000) // 1h ago, well inside

const setMtime = async (path: string, when: Date) => {
  await utimes(path, when, when)
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

describe('pruneOldRunFiles — run-cache retention safety', () => {
  beforeEach(async () => {
    // Each test in this file shares the per-worker HOME; reset runsDir so a
    // previous test's files can't leak into this one's sweep.
    await rm(runsDir(), { recursive: true, force: true })
    await mkdir(runsDir(), { recursive: true })
  })
  afterEach(async () => {
    await rm(runsDir(), { recursive: true, force: true }).catch(() => {})
  })

  const writeRun = async (
    name: string,
    body: unknown | string,
    mtime?: Date,
  ): Promise<string> => {
    const full = join(runsDir(), name)
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    await writeFile(full, text, 'utf8')
    if (mtime) await setMtime(full, mtime)
    return full
  }

  it('deletes a finished run older than the retention window', async () => {
    const f = await writeRun('old-finished.json', {
      finishedAt: new Date(Date.now() - 30 * DAY_MS).toISOString(),
    })
    const removed = await pruneOldRunFiles()
    expect(removed).toBe(1)
    expect(await exists(f)).toBe(false)
  })

  it('keeps a finished run inside the retention window', async () => {
    const f = await writeRun('recent-finished.json', {
      finishedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    })
    const removed = await pruneOldRunFiles()
    expect(removed).toBe(0)
    expect(await exists(f)).toBe(true)
  })

  it('NEVER deletes an in-flight run (no finishedAt), even with an ancient mtime', async () => {
    // The critical "don't delete live data" guarantee: a parseable run with no
    // finishedAt is skipped outright (the `continue`), never aged out by mtime.
    const f = await writeRun('in-flight.json', { startedAt: 'x' }, OLD())
    const removed = await pruneOldRunFiles()
    expect(removed).toBe(0)
    expect(await exists(f)).toBe(true)
  })

  it('deletes a CORRUPT run file only when its mtime is old (recovery: aged-out cache)', async () => {
    const oldCorrupt = await writeRun('old-corrupt.json', '{not valid json', OLD())
    const removed = await pruneOldRunFiles()
    expect(removed).toBe(1)
    expect(await exists(oldCorrupt)).toBe(false)
  })

  it('KEEPS a corrupt run file whose mtime is recent (could be a fresh write)', async () => {
    const freshCorrupt = await writeRun('fresh-corrupt.json', '{half-writ', RECENT())
    const removed = await pruneOldRunFiles()
    expect(removed).toBe(0)
    expect(await exists(freshCorrupt)).toBe(true)
  })

  it('ignores non-.json files entirely (never deletes them, regardless of age)', async () => {
    const notJson = await writeRun('notes.txt', 'arbitrary', OLD())
    const removed = await pruneOldRunFiles()
    expect(removed).toBe(0)
    expect(await exists(notJson)).toBe(true)
  })

  it('returns 0 without throwing when runsDir does not exist', async () => {
    await rm(runsDir(), { recursive: true, force: true })
    await expect(pruneOldRunFiles()).resolves.toBe(0)
  })

  it('a single corrupt/old file does not stop the sweep from pruning the rest', async () => {
    await writeRun('a-old.json', { finishedAt: new Date(Date.now() - 30 * DAY_MS).toISOString() })
    await writeRun('b-inflight.json', { startedAt: 'x' }, OLD()) // kept
    await writeRun('c-old.json', { finishedAt: new Date(Date.now() - 30 * DAY_MS).toISOString() })
    const removed = await pruneOldRunFiles()
    expect(removed).toBe(2)
    expect(await exists(join(runsDir(), 'b-inflight.json'))).toBe(true)
  })
})

describe('pruneOldAttachments — per-project attachment retention safety', () => {
  let dir: string
  let dataDir: string
  let attachDir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'og-retain-'))
    await registerTestProject(dir)
    dataDir = await projectDataDir(dir)
    attachDir = join(dataDir, 'task-attachments')
    await mkdir(attachDir, { recursive: true })
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    await rm(dataDir, { recursive: true, force: true }).catch(() => {})
  })

  it('deletes an attachment older than the window, keeps a recent one', async () => {
    const old = join(attachDir, 'old.png')
    const recent = join(attachDir, 'recent.png')
    await writeFile(old, 'x', 'utf8')
    await writeFile(recent, 'y', 'utf8')
    await setMtime(old, OLD())
    await setMtime(recent, RECENT())
    const removed = await pruneOldAttachments(dir)
    expect(removed).toBe(1)
    expect(await exists(old)).toBe(false)
    expect(await exists(recent)).toBe(true)
  })

  it('returns 0 without throwing when task-attachments dir is absent', async () => {
    await rm(attachDir, { recursive: true, force: true })
    await expect(pruneOldAttachments(dir)).resolves.toBe(0)
  })

  it('a subdirectory inside task-attachments is never deleted (unlink EISDIR is skipped)', async () => {
    const sub = join(attachDir, 'nested')
    await mkdir(sub, { recursive: true })
    await setMtime(sub, OLD())
    const removed = await pruneOldAttachments(dir)
    expect(removed).toBe(0)
    expect(await exists(sub)).toBe(true)
  })
})

// THE goal-condition-3 guarantee: running the FULL boot sweep leaves every piece
// of LIVE project data (board tasks, canvases, the canvas index, notes) exactly
// where it was. Retention's blast radius is runs/ + task-attachments/ ONLY.
describe('retention never touches live project data', () => {
  let dir: string
  let dataDir: string
  beforeEach(async () => {
    await rm(runsDir(), { recursive: true, force: true })
    await mkdir(runsDir(), { recursive: true })
    dir = await mkdtemp(join(tmpdir(), 'og-retain-live-'))
    await registerTestProject(dir)
    dataDir = await projectDataDir(dir)
    await mkdir(join(dataDir, 'canvases'), { recursive: true })
    await mkdir(join(dataDir, 'task-attachments'), { recursive: true })
  })
  afterEach(async () => {
    await rm(runsDir(), { recursive: true, force: true }).catch(() => {})
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    await rm(dataDir, { recursive: true, force: true }).catch(() => {})
  })

  it('leaves tasks.json / canvases / canvas index intact while pruning only the episodic layer', async () => {
    // Live data — all aged ancient on disk to prove age is NOT the deletion
    // criterion for these paths (they live outside retention's scope entirely).
    const tasksFile = join(dataDir, 'tasks.json')
    const canvasFile = join(dataDir, 'canvases', 'c1.json')
    const indexFile = join(dataDir, 'canvases-index.json')
    await writeFile(tasksFile, JSON.stringify({ tasks: [{ id: 't1' }], updatedAt: 'x' }), 'utf8')
    await writeFile(canvasFile, JSON.stringify({ id: 'c1', rev: 3 }), 'utf8')
    await writeFile(indexFile, JSON.stringify({ order: ['c1'], activeId: 'c1' }), 'utf8')
    for (const f of [tasksFile, canvasFile, indexFile]) await setMtime(f, OLD())

    // Episodic layer — old, should be pruned.
    await writeFile(
      join(runsDir(), 'old.json'),
      JSON.stringify({ finishedAt: new Date(Date.now() - 30 * DAY_MS).toISOString() }),
      'utf8',
    )
    const oldAttach = join(dataDir, 'task-attachments', 'old.bin')
    await writeFile(oldAttach, 'x', 'utf8')
    await setMtime(oldAttach, OLD())

    const removedRuns = await pruneOldRunFiles()
    const removedAttach = await pruneOldAttachments(dir)

    // Episodic layer pruned…
    expect(removedRuns).toBe(1)
    expect(removedAttach).toBe(1)
    expect(await exists(oldAttach)).toBe(false)
    // …but every piece of LIVE data survives untouched.
    expect(await exists(tasksFile)).toBe(true)
    expect(await exists(canvasFile)).toBe(true)
    expect(await exists(indexFile)).toBe(true)
    expect(JSON.parse(await readFile(tasksFile, 'utf8')).tasks).toHaveLength(1)
  })

  it('the retention window constant is the documented 14 days', () => {
    expect(RAW_RETENTION_DAYS).toBe(14)
  })
})

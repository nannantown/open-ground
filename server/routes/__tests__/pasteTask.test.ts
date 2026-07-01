import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { mkdtemp, mkdir, rm, realpath, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from '../../app'
import { __resetMigrationCacheForTests } from '@/lib/server/registry'
import type { TerminalInfo } from '@/lib/server/terminal'
import type { ProjectTask } from '@/lib/types'

// Route-level contract for POST /api/terminal/:id/paste-task — the
// "insert, don't send" half of the Board-launch split: the server re-reads
// the task, composes the full task prompt, and writes it into a live PTY as
// ONE bracketed paste with NO trailing newline. The PTY itself is faked via
// the same globalThis seam terminal.ts uses to survive tsx-watch reloads
// (the pattern of terminal.test.ts): no node-pty load, no real shell — the
// fake's write() captures the exact bytes the route emits.

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

const ETC = '/etc' // registered by NOBODY → 403

interface FakeSessionShape {
  info: TerminalInfo
  pty: { write: (data: string) => void }
  buffer: string
  listeners: Set<unknown>
  exitListeners: Set<unknown>
}

const state = () =>
  (globalThis as { __openground_terminal?: { sessions: Map<string, FakeSessionShape> } })
    .__openground_terminal!

// Importing ../../app pulls in terminal.ts, which initialises the global pool.
const fakePty = (
  id: string,
  cwd: string,
  writes: string[],
  opts: { finishedAt?: string } = {},
): void => {
  state().sessions.set(id, {
    info: {
      id,
      cwd,
      shell: '/bin/zsh',
      cols: 100,
      rows: 30,
      startedAt: new Date().toISOString(),
      tag: 'claude',
      ...(opts.finishedAt ? { finishedAt: opts.finishedAt, exitCode: 0 } : {}),
    } as TerminalInfo,
    pty: { write: (data: string) => writes.push(data) },
    buffer: '',
    listeners: new Set(),
    exitListeners: new Set(),
  })
}

let home: string
let scratch: string

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-paste-home-')))
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-paste-scratch-')))
  process.env.OPENGROUND_HOME = home
  __resetMigrationCacheForTests()
  state().sessions.clear()
})

afterEach(async () => {
  state().sessions.clear()
  await rm(home, { recursive: true, force: true })
  await rm(scratch, { recursive: true, force: true })
})

afterAll(() => {
  state().sessions.clear()
})

const makeRegisteredDir = async (name: string): Promise<string> => {
  const dir = join(scratch, name)
  await mkdir(dir)
  await writeFile(join(dir, 'README.md'), `# ${name}\n`)
  const res = await app.request('/api/projects/import', json({ path: dir }))
  expect(res.status).toBe(200)
  return dir
}

const addTask = async (path: string, title: string, notes?: string): Promise<ProjectTask> => {
  const res = await app.request('/api/project/tasks', json({ path, add: [title] }))
  expect(res.status).toBe(200)
  const data = await res.json()
  const task = (data.tasks as ProjectTask[]).find((t) => t.title === title) as ProjectTask
  expect(task).toBeTruthy()
  if (notes !== undefined) {
    // Notes have no dedicated tasks-route op; write them through the same
    // server seam the drawer save uses (read-modify-write of project data).
    const { readProjectData, writeProjectData } = await import('@/lib/server/projectData')
    const pd = await readProjectData(path)
    pd.tasks = pd.tasks.map((t) => (t.id === task.id ? { ...t, notes } : t))
    await writeProjectData(path, pd)
    task.notes = notes
  }
  return task
}

describe('POST /api/terminal/:id/paste-task — validation', () => {
  it('missing path → 400', async () => {
    const res = await app.request('/api/terminal/some-id/paste-task', json({ taskId: 't1' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/path/i)
  })

  it('missing taskId → 400', async () => {
    const res = await app.request('/api/terminal/some-id/paste-task', json({ path: ETC }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/taskId/i)
  })

  it('unregistered path → 403 (validateProjectPath boundary, before any read)', async () => {
    const res = await app.request(
      '/api/terminal/some-id/paste-task',
      json({ path: ETC, taskId: 't1' }),
    )
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/not allowed/i)
  })

  it('unknown taskId in a registered project → 404 (before the PTY lookup)', async () => {
    const dir = await makeRegisteredDir('no-such-task')
    const res = await app.request(
      '/api/terminal/some-id/paste-task',
      json({ path: dir, taskId: 'does-not-exist' }),
    )
    expect(res.status).toBe(404)
    expect((await res.json()).error).toMatch(/task not found/i)
  })

  it('oversized task notes → 400 (cap before any PTY write)', async () => {
    const dir = await makeRegisteredDir('huge')
    const task = await addTask(dir, 'Huge card', 'x'.repeat(256 * 1024 + 1))
    const writes: string[] = []
    fakePty('pty-huge', dir, writes)
    const res = await app.request(
      '/api/terminal/pty-huge/paste-task',
      json({ path: dir, taskId: task.id }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/too large/i)
    expect(writes).toEqual([])
  })

  it('unknown / dead PTY id → 404', async () => {
    const dir = await makeRegisteredDir('no-pty')
    const task = await addTask(dir, 'Orphan card')
    const res = await app.request(
      '/api/terminal/no-such-pty/paste-task',
      json({ path: dir, taskId: task.id }),
    )
    expect(res.status).toBe(404)
    expect((await res.json()).error).toMatch(/not found/i)

    // A finished PTY is equally dead (writeInput refuses it).
    fakePty('pty-dead', dir, [], { finishedAt: new Date().toISOString() })
    const res2 = await app.request(
      '/api/terminal/pty-dead/paste-task',
      json({ path: dir, taskId: task.id }),
    )
    expect(res2.status).toBe(404)
  })
})

describe('POST /api/terminal/:id/paste-task — the paste write', () => {
  it('writes ONE bracketed paste: starts ESC[200~, ends ESC[201~, NO trailing newline', async () => {
    const dir = await makeRegisteredDir('paste-ok')
    const task = await addTask(dir, 'Wire the flux capacitor', 'step 1\nstep 2')
    const writes: string[] = []
    fakePty('pty-live', dir, writes)

    const res = await app.request(
      '/api/terminal/pty-live/paste-task',
      json({ path: dir, taskId: task.id }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    expect(writes).toHaveLength(1)
    const written = writes[0]
    // Insert-not-send byte contract (the whole point of the launch/paste split).
    expect(written.startsWith('\x1b[200~')).toBe(true)
    expect(written.endsWith('\x1b[201~')).toBe(true)
    expect(written.endsWith('\n')).toBe(false)
    expect(written.endsWith('\r')).toBe(false)
    // The prompt is the full buildTaskPrompt composition: title + notes +
    // the markDone curl carrying the task id (re-read fresh from tasks.json).
    expect(written).toContain('# Task: Wire the flux capacitor')
    expect(written).toContain('step 1\nstep 2')
    expect(written).toContain(task.id)
  })

  it('prefers the LIVE title/notes from the body over the persisted copy (drawer-edit freshness)', async () => {
    const dir = await makeRegisteredDir('live-override')
    const task = await addTask(dir, 'Stale title', 'stale notes')
    const writes: string[] = []
    fakePty('pty-live2', dir, writes)

    const res = await app.request(
      '/api/terminal/pty-live2/paste-task',
      json({
        path: dir,
        taskId: task.id,
        title: 'Fresh title',
        notes: 'fresh notes',
      }),
    )
    expect(res.status).toBe(200)
    const written = writes[0]
    expect(written).toContain('# Task: Fresh title')
    expect(written).toContain('fresh notes')
    expect(written).not.toContain('Stale title')
    expect(written).not.toContain('stale notes')
  })

  it('accepts a brand-new card not yet on disk when the body carries the title (no 404)', async () => {
    const dir = await makeRegisteredDir('not-persisted')
    const writes: string[] = []
    fakePty('pty-live3', dir, writes)

    const res = await app.request(
      '/api/terminal/pty-live3/paste-task',
      json({ path: dir, taskId: 'never-saved', title: 'Unsaved card', notes: 'n' }),
    )
    expect(res.status).toBe(200)
    expect(writes[0]).toContain('# Task: Unsaved card')
  })

  it('appends "## Attached images" with absolute asset paths (existing files only, ids validated)', async () => {
    const dir = await makeRegisteredDir('attachments')
    const task = await addTask(dir, 'Bug with screenshot')
    // Upload a real asset through the route so the bytes exist on disk.
    const pngB64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
    const up = await app.request(
      '/api/project/task-asset',
      json({ path: dir, name: 'shot.png', mime: 'image/png', dataBase64: pngB64 }),
    )
    expect(up.status).toBe(200)
    const { id } = (await up.json()) as { id: string }
    const writes: string[] = []
    fakePty('pty-att', dir, writes)

    const res = await app.request(
      '/api/terminal/pty-att/paste-task',
      json({
        path: dir,
        taskId: task.id,
        attachmentIds: [
          id,
          `${'0'.repeat(40)}.png`, // valid shape but no file → excluded
          '../../etc/passwd', // invalid shape → filtered before any fs touch
        ],
      }),
    )
    expect(res.status).toBe(200)
    const written = writes[0]
    expect(written).toContain('## Attached images')
    // Absolute path ending in the content-hash file name, listed once.
    const line = written.split('\n').find((l) => l.includes(id))
    expect(line).toBeTruthy()
    expect(line!.startsWith('- /')).toBe(true)
    expect(written).not.toContain('0'.repeat(40))
    expect(written).not.toContain('passwd')
  })

  it('no attachments → no "## Attached images" section', async () => {
    const dir = await makeRegisteredDir('no-attachments')
    const task = await addTask(dir, 'Plain card')
    const writes: string[] = []
    fakePty('pty-noatt', dir, writes)
    const res = await app.request(
      '/api/terminal/pty-noatt/paste-task',
      json({ path: dir, taskId: task.id }),
    )
    expect(res.status).toBe(200)
    expect(writes[0]).not.toContain('Attached images')
  })

  it('strips an embedded paste-END marker so the bracketed span stays intact (injection guard)', async () => {
    const dir = await makeRegisteredDir('esc-inject')
    const writes: string[] = []
    fakePty('pty-esc', dir, writes)

    const res = await app.request(
      '/api/terminal/pty-esc/paste-task',
      json({
        path: dir,
        taskId: 'x',
        title: 'Evil',
        // Smuggled END marker + CR that would otherwise submit raw keys.
        notes: 'before\x1b[201~\rafter',
      }),
    )
    expect(res.status).toBe(200)
    const written = writes[0]
    // Exactly one END marker — ours, at the very end. The smuggled one is gone.
    expect(written.endsWith('\x1b[201~')).toBe(true)
    expect(written.indexOf('\x1b[201~')).toBe(written.length - '\x1b[201~'.length)
    // The body bytes survive as inert text (ESC removed, [201~ kept literal).
    expect(written).toContain('before[201~\rafter')
  })
})

describe('POST /api/terminal/:id/paste-task — PTY-to-project binding', () => {
  it("rejects pasting project A's task into a PTY running in project B → 403 (cross-project)", async () => {
    // Both projects are registered (so each path passes validateProjectPath);
    // B is the victim PTY. The exploit: compose A's task prompt (A's worktree
    // protocol + an A-pointing markDone curl) and paste it into B's claude.
    const dirA = await makeRegisteredDir('cross-a')
    const dirB = await makeRegisteredDir('cross-b')
    const task = await addTask(dirA, 'A-only task', 'do A things')
    const writes: string[] = []
    fakePty('pty-in-b', dirB, writes) // a LIVE claude PTY whose cwd is project B

    const res = await app.request(
      '/api/terminal/pty-in-b/paste-task',
      json({ path: dirA, taskId: task.id }),
    )
    // 403 even though B itself is a registered project: B's cwd is in-registry
    // (so validateProjectPath(B) is true), but its project UUID ≠ A's, so the
    // worktrees-sibling escape hatch does not apply.
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/does not belong/i)
    // Critically: NOT ONE byte reached B's PTY.
    expect(writes).toEqual([])
  })

  it('still accepts a PTY whose cwd is a subdirectory of the path (in-scope, e.g. nested launch)', async () => {
    // Same-project nesting must keep working — the binding allows cwd === path
    // OR cwd under path (startsWith), so a claude launched in a subfolder of
    // the project is a legitimate paste target (regression guard for (2)).
    const dir = await makeRegisteredDir('nested')
    const task = await addTask(dir, 'Nested card', 'n')
    const writes: string[] = []
    fakePty('pty-sub', join(dir, 'packages', 'web'), writes)

    const res = await app.request(
      '/api/terminal/pty-sub/paste-task',
      json({ path: dir, taskId: task.id }),
    )
    expect(res.status).toBe(200)
    expect(writes).toHaveLength(1)
    expect(writes[0]).toContain('# Task: Nested card')
  })
})

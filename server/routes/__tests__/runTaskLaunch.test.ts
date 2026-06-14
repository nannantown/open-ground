import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, rm, realpath, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

// Route-level contract for the 実行 path of POST /api/terminal/claude
// (body.task): the server composes the FULL task prompt (shared composer with
// paste-task) and passes it as launchClaude's initialPrompt so claude starts
// working immediately, resolving the per-card overrides (flow / model /
// effort) over the stored card and the project prefs. launchClaude itself is
// mocked — these tests assert WHAT the route hands it, not the PTY spawn
// (claudeTerminal.test.ts owns the argv contract).

const launchClaude = vi.fn((opts: Record<string, unknown>) => ({
  terminalId: 'pty-run',
  agentSessionId: String(opts.agentSessionId ?? 'sid'),
  info: {
    id: 'pty-run',
    cwd: String(opts.cwd ?? ''),
    shell: '/bin/zsh',
    cols: 100,
    rows: 30,
    startedAt: new Date().toISOString(),
    tag: 'claude',
  },
}))

vi.mock('@/lib/server/claudeTerminal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/claudeTerminal')>()
  return { ...actual, launchClaude: (opts: Record<string, unknown>) => launchClaude(opts) }
})

// The pre-flight connection check must pass without a real `claude` binary on CI.
vi.mock('@/lib/server/claudeConnection', () => ({
  claudeConnection: async () => ({
    installed: true,
    loggedIn: true,
    plan: null,
    email: null,
    message: 'ok',
  }),
}))

import { app } from '../../app'
import { __resetMigrationCacheForTests } from '@/lib/server/registry'
import type { ProjectTask } from '@/lib/types'

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

let home: string
let scratch: string

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-run-home-')))
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-run-scratch-')))
  process.env.OPENGROUND_HOME = home
  __resetMigrationCacheForTests()
  launchClaude.mockClear()
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(scratch, { recursive: true, force: true })
})

const makeRegisteredDir = async (name: string): Promise<string> => {
  const dir = join(scratch, name)
  await mkdir(dir)
  await writeFile(join(dir, 'README.md'), `# ${name}\n`)
  const res = await app.request('/api/projects/import', json({ path: dir }))
  expect(res.status).toBe(200)
  return dir
}

const addTask = async (
  path: string,
  title: string,
  patch: Partial<ProjectTask> = {},
): Promise<ProjectTask> => {
  const res = await app.request('/api/project/tasks', json({ path, add: [title] }))
  expect(res.status).toBe(200)
  const data = await res.json()
  let task = (data.tasks as ProjectTask[]).find((t) => t.title === title) as ProjectTask
  expect(task).toBeTruthy()
  if (Object.keys(patch).length) {
    const { readProjectData, writeProjectData } = await import('@/lib/server/projectData')
    const pd = await readProjectData(path)
    pd.tasks = pd.tasks.map((t) => (t.id === task.id ? { ...t, ...patch } : t))
    await writeProjectData(path, pd)
    task = { ...task, ...patch }
  }
  return task
}

const setLaunchPrefs = async (
  path: string,
  launch: Record<string, unknown>,
): Promise<void> => {
  const { readProjectData, writeProjectData } = await import('@/lib/server/projectData')
  const pd = await readProjectData(path)
  await writeProjectData(path, { ...pd, launch })
}

const lastLaunch = () => launchClaude.mock.calls.at(-1)![0]

describe('POST /api/terminal/claude — 実行 (body.task)', () => {
  it('composes the task prompt as initialPrompt — claude starts on the task content', async () => {
    const dir = await makeRegisteredDir('run-basic')
    const task = await addTask(dir, 'Wire the flux capacitor', { notes: 'step 1\nstep 2' })
    const res = await app.request(
      '/api/terminal/claude',
      json({ cwd: dir, task: { id: task.id } }),
    )
    expect(res.status).toBe(200)
    expect(launchClaude).toHaveBeenCalledTimes(1)
    const prompt = String(lastLaunch().initialPrompt)
    expect(prompt).toContain('# Task: Wire the flux capacitor')
    expect(prompt).toContain('step 1\nstep 2')
    expect(prompt).toContain(task.id) // the markDone curl
  })

  it('task.id missing → 400; unknown id with no live title → 404; no spawn either way', async () => {
    const dir = await makeRegisteredDir('run-invalid')
    const noId = await app.request('/api/terminal/claude', json({ cwd: dir, task: {} }))
    expect(noId.status).toBe(400)
    const noTask = await app.request(
      '/api/terminal/claude',
      json({ cwd: dir, task: { id: 'ghost' } }),
    )
    expect(noTask.status).toBe(404)
    expect(launchClaude).not.toHaveBeenCalled()
  })

  it('LIVE title/notes win over the stored card (drawer-edit freshness)', async () => {
    const dir = await makeRegisteredDir('run-live')
    const task = await addTask(dir, 'Stale title', { notes: 'stale' })
    const res = await app.request(
      '/api/terminal/claude',
      json({ cwd: dir, task: { id: task.id, title: 'Fresh title', notes: 'fresh' } }),
    )
    expect(res.status).toBe(200)
    const prompt = String(lastLaunch().initialPrompt)
    expect(prompt).toContain('# Task: Fresh title')
    expect(prompt).not.toContain('Stale title')
  })

  it('per-card model/effort (live) reach launchClaude; junk effort degrades to prefs', async () => {
    const dir = await makeRegisteredDir('run-overrides')
    const task = await addTask(dir, 'Pick models')
    await setLaunchPrefs(dir, { model: 'sonnet', effort: 'low' })
    const res = await app.request(
      '/api/terminal/claude',
      json({ cwd: dir, task: { id: task.id, model: 'fable', effort: 'xhigh' } }),
    )
    expect(res.status).toBe(200)
    expect(lastLaunch().model).toBe('fable')
    expect(lastLaunch().effort).toBe('xhigh')

    // Junk effort is never forwarded — the stored prefs win instead.
    const res2 = await app.request(
      '/api/terminal/claude',
      json({ cwd: dir, task: { id: task.id, effort: 'turbo' } }),
    )
    expect(res2.status).toBe(200)
    expect(lastLaunch().model).toBe('sonnet') // prefs fallback
    expect(lastLaunch().effort).toBe('low')
  })

  it('STORED card run settings apply when the body sends none', async () => {
    const dir = await makeRegisteredDir('run-stored')
    const task = await addTask(dir, 'Stored prefs card', {
      run: { model: 'opus', effort: 'max' },
    })
    const res = await app.request(
      '/api/terminal/claude',
      json({ cwd: dir, task: { id: task.id } }),
    )
    expect(res.status).toBe(200)
    expect(lastLaunch().model).toBe('opus')
    expect(lastLaunch().effort).toBe('max')
  })

  it('a plain launch (no task) is unchanged: no prompt, prefs only', async () => {
    const dir = await makeRegisteredDir('run-plain')
    await setLaunchPrefs(dir, { model: 'haiku', effort: 'medium' })
    const res = await app.request('/api/terminal/claude', json({ cwd: dir }))
    expect(res.status).toBe(200)
    expect(lastLaunch().initialPrompt).toBeUndefined()
    expect(lastLaunch().model).toBe('haiku')
    expect(lastLaunch().effort).toBe('medium')
  })

  it('oversized composed prompt → 400, no spawn', async () => {
    const dir = await makeRegisteredDir('run-huge')
    const task = await addTask(dir, 'Huge')
    const res = await app.request(
      '/api/terminal/claude',
      json({ cwd: dir, task: { id: task.id, notes: 'x'.repeat(256 * 1024 + 1) } }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/too large/i)
    expect(launchClaude).not.toHaveBeenCalled()
  })
})

describe('POST /api/terminal/claude — per-card completion flow (git project)', () => {
  // The flow override only shows in the prompt on a git project (non-git
  // omits the branch protocol entirely) — fake a .git dir for these.
  const makeGitDir = async (name: string): Promise<string> => {
    const dir = await makeRegisteredDir(name)
    await mkdir(join(dir, '.git'))
    return dir
  }

  it('live flow:"pr" overrides the project default (merge) in the protocol', async () => {
    const dir = await makeGitDir('flow-live')
    const task = await addTask(dir, 'Ship it')
    const res = await app.request(
      '/api/terminal/claude',
      json({ cwd: dir, task: { id: task.id, flow: 'pr' } }),
    )
    expect(res.status).toBe(200)
    const prompt = String(lastLaunch().initialPrompt)
    expect(prompt).toContain('gh pr create')
    expect(prompt).toContain('Do NOT merge the pull request yourself')
  })

  it('stored run.flow applies without a live value; merge stays the default', async () => {
    const dir = await makeGitDir('flow-stored')
    const stored = await addTask(dir, 'Stored PR card', { run: { flow: 'pr' } })
    const res = await app.request(
      '/api/terminal/claude',
      json({ cwd: dir, task: { id: stored.id } }),
    )
    expect(res.status).toBe(200)
    expect(String(lastLaunch().initialPrompt)).toContain('gh pr create')

    const plain = await addTask(dir, 'Plain merge card')
    const res2 = await app.request(
      '/api/terminal/claude',
      json({ cwd: dir, task: { id: plain.id } }),
    )
    expect(res2.status).toBe(200)
    const prompt = String(lastLaunch().initialPrompt)
    expect(prompt).toContain('merge the task branch back into')
    expect(prompt).not.toContain('gh pr create')
    void res
  })
})

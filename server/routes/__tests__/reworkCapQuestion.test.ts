import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, rm, realpath, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'

// The rework cap opens the owner's question IN THE SAME REQUEST that parks the
// card (never a second commander call — the gap where an older 「A: やり直す」
// stayed the newest row and got replayed onto an occasion the owner never saw).
// `failOpen` flips the real openEscalation into a throw to pin "rework still
// succeeds, questionOpened:false".
const ctl = vi.hoisted(() => ({ failOpen: false }))
vi.mock('@/lib/server/swarmEscalations', async (orig) => {
  const real = await orig<typeof import('@/lib/server/swarmEscalations')>()
  return {
    ...real,
    openEscalation: (async (...args: Parameters<typeof real.openEscalation>) => {
      if (ctl.failOpen) throw new Error('inbox write failed')
      return real.openEscalation(args[0], { ...args[1], notify: async () => {} })
    }) as typeof real.openEscalation,
  }
})

import { app } from '../../app'
import { __resetMigrationCacheForTests } from '@/lib/server/registry'
import { answerEscalation, listEscalations } from '@/lib/server/swarmEscalations'
import type { ProjectTask } from '@/lib/types'

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

let home: string
let scratch: string

beforeEach(async () => {
  ctl.failOpen = false
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-rwcap-home-')))
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-rwcap-scratch-')))
  process.env.OPENGROUND_HOME = home
  __resetMigrationCacheForTests()
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(scratch, { recursive: true, force: true })
})

const setup = async (): Promise<{ dir: string; task: ProjectTask }> => {
  const dir = join(scratch, 'proj')
  await mkdir(dir)
  await writeFile(join(dir, 'README.md'), '# p\n')
  expect((await app.request('/api/projects/import', json({ path: dir }))).status).toBe(200)
  const res = await app.request('/api/project/tasks', json({ path: dir, add: ['Cap card'] }))
  const task = ((await res.json()).tasks as ProjectTask[]).find((t) => t.title === 'Cap card')!
  return { dir, task }
}

const rework = async (dir: string, id: string) => {
  const res = await app.request('/api/project/tasks', json({ path: dir, rework: [{ id, maxReworks: 1 }] }))
  expect(res.status).toBe(200)
  return (await res.json()).results.rework[0]
}

const capRows = async (dir: string, id: string) =>
  (await listEscalations({ projectPath: dir })).filter((e) =>
    e.receiptKey.startsWith(`commander:rework-cap:${id}:`),
  )

describe('POST /api/project/tasks rework — cap opens the owner question in the same call', () => {
  it('opens exactly one question when the cap is crossed, none before', async () => {
    const { dir, task } = await setup()
    const first = await rework(dir, task.id)
    expect(first).toEqual({ id: task.id, ok: true, column: 'doing', count: 1 })
    expect(await capRows(dir, task.id)).toHaveLength(0)

    const capped = await rework(dir, task.id)
    expect(capped).toMatchObject({ column: 'blocked', count: 2, questionOpened: true })
    const rows = await capRows(dir, task.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: capped.escalationId,
      receiptKey: `commander:rework-cap:${task.id}:2:none:none`,
      taskId: task.id,
      whyEscalated: 'policy',
      status: 'open',
    })
    expect(rows[0].plainQuestion).toContain('Cap card')
    expect(rows[0].plainQuestion).toContain('A: やり直す')
  })

  it('a second cap occasion opens a NEW row (an old answer is never the newest)', async () => {
    const { dir, task } = await setup()
    await rework(dir, task.id)
    const a = await rework(dir, task.id)
    const b = await rework(dir, task.id)
    expect(b).toMatchObject({ column: 'blocked', count: 3, questionOpened: true })
    expect(b.escalationId).not.toBe(a.escalationId)
    const keys = (await capRows(dir, task.id)).map((e) => e.receiptKey).sort()
    expect(keys).toEqual([`commander:rework-cap:${task.id}:2:none:none`, `commander:rework-cap:${task.id}:3:none:none`])
  })

  it('answered → todo → redo on the SAME branch with a new commit → recap opens a new key', async () => {
    const { dir, task } = await setup()
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir }).toString().trim()
    git('init', '-q', '-b', 'main')
    git('add', '-A')
    git('commit', '-qm', 'base')
    git('branch', 'swarm/w')
    const commitOnBranch = async (msg: string) => {
      const sha = git('commit-tree', '-p', 'swarm/w', '-m', msg, 'swarm/w^{tree}')
      git('update-ref', 'refs/heads/swarm/w', sha)
      return sha.slice(0, 12)
    }
    const post = (b: object) => app.request('/api/project/tasks', json({ path: dir, ...b }))
    await post({ setBranch: [{ id: task.id, branch: 'swarm/w' }] })
    const head1 = await commitOnBranch('round 1')
    await rework(dir, task.id)
    const first = await rework(dir, task.id)
    expect(first.receiptKey).toBe(`commander:rework-cap:${task.id}:2:swarm/w:${head1}`)
    await answerEscalation(first.escalationId, 'A: やり直す')
    // Owner said redo: back to todo (counter resets), the redo re-enters the
    // SAME branch (resolveReusableWork) and commits again before the next cap.
    await post({ setColumn: [{ id: task.id, column: 'todo' }] })
    const head2 = await commitOnBranch('round 2')
    expect(head2).not.toBe(head1)
    await rework(dir, task.id)
    const second = await rework(dir, task.id)
    expect(second).toMatchObject({
      column: 'blocked',
      count: 2,
      questionOpened: true,
      receiptKey: `commander:rework-cap:${task.id}:2:swarm/w:${head2}`,
    })
    expect(second.receiptKey).not.toBe(first.receiptKey)
    const byKey = new Map((await capRows(dir, task.id)).map((e) => [e.receiptKey, e.status]))
    expect(byKey.get(first.receiptKey)).toBe('answered')
    expect(byKey.get(second.receiptKey)).toBe('open')
  })

  it('an inbox failure does not fail the rework — questionOpened:false', async () => {
    const { dir, task } = await setup()
    await rework(dir, task.id)
    ctl.failOpen = true
    const capped = await rework(dir, task.id)
    expect(capped).toMatchObject({
      ok: true,
      column: 'blocked',
      count: 2,
      questionOpened: false,
      receiptKey: `commander:rework-cap:${task.id}:2:none:none`,
    })
    expect(capped.escalationId).toBeUndefined()
    const res = await app.request(`/api/project?path=${encodeURIComponent(dir)}`)
    const after = ((await res.json()).tasks as ProjectTask[]).find((t) => t.id === task.id)
    expect(after?.boardColumn).toBe('blocked')
  })
})

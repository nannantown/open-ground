import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, realpath, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from '../../app'
import { __resetMigrationCacheForTests } from '@/lib/server/registry'
import type { ProjectTask } from '@/lib/types'

// Route-level contract for POST /api/project/tasks — the endpoint a Board-card
// claude session drives via curl (taskPrompt). Pins the ops it documents:
// add / markDone / setColumn, and setPrUrl's validation (http(s) only,
// clear-on-empty, junk rejected) — a claude session pastes the URL itself, so
// the route is the only guard between a typo and a permanent bogus link.

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

let home: string
let scratch: string

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-tasks-home-')))
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-tasks-scratch-')))
  process.env.OPENGROUND_HOME = home
  __resetMigrationCacheForTests()
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

const addTask = async (path: string, title: string): Promise<ProjectTask> => {
  const res = await app.request('/api/project/tasks', json({ path, add: [title] }))
  expect(res.status).toBe(200)
  const data = await res.json()
  const task = (data.tasks as ProjectTask[]).find((t) => t.title === title)
  expect(task).toBeTruthy()
  return task as ProjectTask
}

const getTask = async (path: string, id: string): Promise<ProjectTask | undefined> => {
  const res = await app.request(`/api/project?path=${encodeURIComponent(path)}`)
  expect(res.status).toBe(200)
  return ((await res.json()).tasks as ProjectTask[]).find((t) => t.id === id)
}

describe('POST /api/project/tasks — core ops', () => {
  it('add creates a todo board card; markDone sets done + done column', async () => {
    const dir = await makeRegisteredDir('core')
    const task = await addTask(dir, 'Ship it')
    expect(task.boardColumn).toBe('todo')
    expect(task.done).toBe(false)

    const res = await app.request('/api/project/tasks', json({ path: dir, markDone: [task.id] }))
    expect(res.status).toBe(200)
    const after = await getTask(dir, task.id)
    expect(after?.done).toBe(true)
    expect(after?.boardColumn).toBe('done')
  })

  it('setColumn moves the card; done tracks the column', async () => {
    const dir = await makeRegisteredDir('move')
    const task = await addTask(dir, 'Review me')
    await app.request(
      '/api/project/tasks',
      json({ path: dir, setColumn: [{ id: task.id, column: 'review' }] }),
    )
    let t = await getTask(dir, task.id)
    expect(t?.boardColumn).toBe('review')
    expect(t?.done).toBe(false)

    // Junk column names are ignored, not 500s.
    const res = await app.request(
      '/api/project/tasks',
      json({ path: dir, setColumn: [{ id: task.id, column: '../../etc' }] }),
    )
    expect(res.status).toBe(200)
    t = await getTask(dir, task.id)
    expect(t?.boardColumn).toBe('review')
  })
})

describe('POST /api/project/tasks — setPrUrl validation', () => {
  it('records an https PR URL; empty string clears it', async () => {
    const dir = await makeRegisteredDir('pr')
    const task = await addTask(dir, 'PR task')
    const url = 'https://github.com/o/r/pull/42'

    await app.request('/api/project/tasks', json({ path: dir, setPrUrl: [{ id: task.id, url }] }))
    expect((await getTask(dir, task.id))?.prUrl).toBe(url)

    await app.request('/api/project/tasks', json({ path: dir, setPrUrl: [{ id: task.id, url: '' }] }))
    expect((await getTask(dir, task.id))?.prUrl).toBeUndefined()
  })

  it('rejects non-http(s) schemes, unparseable URLs, and over-long URLs', async () => {
    const dir = await makeRegisteredDir('pr-bad')
    const task = await addTask(dir, 'Guarded')
    const good = 'https://github.com/o/r/pull/1'
    await app.request('/api/project/tasks', json({ path: dir, setPrUrl: [{ id: task.id, url: good }] }))

    for (const bad of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'http://', // unparseable
      'not a url',
      `https://github.com/${'a'.repeat(600)}`, // > 500 chars
    ]) {
      const res = await app.request(
        '/api/project/tasks',
        json({ path: dir, setPrUrl: [{ id: task.id, url: bad }] }),
      )
      expect(res.status).toBe(200) // ignored, never a 500
      expect((await getTask(dir, task.id))?.prUrl).toBe(good) // unchanged
    }
  })

  it('unknown task id is a no-op, not an error', async () => {
    const dir = await makeRegisteredDir('pr-miss')
    const res = await app.request(
      '/api/project/tasks',
      json({ path: dir, setPrUrl: [{ id: 'nope', url: 'https://x.test/pr/1' }] }),
    )
    expect(res.status).toBe(200)
  })
})

describe('POST /api/project/task-title — guards (no claude spawn)', () => {
  // Only the pre-generation guards: every case below must return BEFORE the
  // route probes/spawns the claude CLI (a test must never bill a session).
  it('hand-titled card (no titleAuto) is a null no-op', async () => {
    const dir = await makeRegisteredDir('title-manual')
    const task = await addTask(dir, 'Hand written title')
    const res = await app.request('/api/project/task-title', json({ path: dir, id: task.id }))
    expect(res.status).toBe(200)
    expect((await res.json()).title).toBeNull()
  })

  it('unknown id → 404; missing fields → 400; unregistered path → 403', async () => {
    const dir = await makeRegisteredDir('title-guards')
    expect((await app.request('/api/project/task-title', json({ path: dir, id: 'nope' }))).status).toBe(404)
    expect((await app.request('/api/project/task-title', json({ path: dir }))).status).toBe(400)
    expect(
      (await app.request('/api/project/task-title', json({ path: '/etc', id: 'x' }))).status,
    ).toBe(403)
  })
})

describe('POST /api/project/tasks — setBranch validation', () => {
  it('records a plausible branch name; empty string clears it', async () => {
    const dir = await makeRegisteredDir('branch')
    const task = await addTask(dir, 'Branch task')

    await app.request(
      '/api/project/tasks',
      json({ path: dir, setBranch: [{ id: task.id, branch: 'task/u2-105-account-settings' }] }),
    )
    expect((await getTask(dir, task.id))?.branch).toBe('task/u2-105-account-settings')

    await app.request(
      '/api/project/tasks',
      json({ path: dir, setBranch: [{ id: task.id, branch: '' }] }),
    )
    expect((await getTask(dir, task.id))?.branch).toBeUndefined()
  })

  it('rejects whitespace/shell-noise/over-long names without erroring', async () => {
    const dir = await makeRegisteredDir('branch-bad')
    const task = await addTask(dir, 'Guarded branch')
    const good = 'task/fix-login'
    await app.request(
      '/api/project/tasks',
      json({ path: dir, setBranch: [{ id: task.id, branch: good }] }),
    )

    for (const bad of [
      'has space',
      '-leading-dash',
      'semi;colon',
      'back`tick`',
      `task/${'a'.repeat(250)}`, // > 200 chars
    ]) {
      const res = await app.request(
        '/api/project/tasks',
        json({ path: dir, setBranch: [{ id: task.id, branch: bad }] }),
      )
      expect(res.status).toBe(200) // ignored, never a 500
      expect((await getTask(dir, task.id))?.branch).toBe(good) // unchanged
    }
  })
})

describe('POST /api/project/tasks — concurrent writes never lose a mutation', () => {
  // Repro of the data-loss bug (audit MAJOR): two+ sessions POST to the SAME
  // project at once (e.g. a worker setBranch while the commander engine
  // setColumn). The handler read-modify-writes under a compare-and-swap; without
  // lock-scoped RMW the late writers' snapshot is stale, so writeProjectData
  // throws ProjectDataConflictError — which escaped this route as a 500 and
  // silently dropped that setColumn/setBranch/markDone. Every mutation must now
  // land (the loser serializes behind the winner under the board lock), never a
  // 500, never a lost update.

  it('distinct mutations from two concurrent posts both land', async () => {
    const dir = await makeRegisteredDir('concurrent-pair')
    const a = await addTask(dir, 'card A')
    const b = await addTask(dir, 'card B')

    const [r1, r2] = await Promise.all([
      app.request('/api/project/tasks', json({ path: dir, setBranch: [{ id: a.id, branch: 'task/a' }] })),
      app.request('/api/project/tasks', json({ path: dir, setColumn: [{ id: b.id, column: 'review' }] })),
    ])
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)

    expect((await getTask(dir, a.id))?.branch).toBe('task/a')
    expect((await getTask(dir, b.id))?.boardColumn).toBe('review')
  })

  it('many concurrent column moves on distinct cards all persist (no lost update, no 500)', async () => {
    const dir = await makeRegisteredDir('concurrent-many')
    const N = 16
    const tasks: ProjectTask[] = []
    for (let i = 0; i < N; i++) tasks.push(await addTask(dir, `card-${i}`))

    // Fire every move at once: each handler reads the same snapshot, mutates a
    // different card, then writes under the CAS. Late writers would lose their
    // move (and 500) without lock-scoped read-modify-write.
    const results = await Promise.all(
      tasks.map((t) =>
        app.request('/api/project/tasks', json({ path: dir, setColumn: [{ id: t.id, column: 'review' }] })),
      ),
    )
    for (const r of results) expect(r.status).toBe(200)
    for (const t of tasks) {
      expect((await getTask(dir, t.id))?.boardColumn).toBe('review')
    }
  })
})

describe('POST /api/project/tasks — per-item results for id-targeted batches', () => {
  // Incident 0707: an unmatched (shortened/stale) id silently no-op'd inside a
  // 200 response — the caller had no way to tell "applied" from "ignored"
  // without re-reading the board. setColumn/setBranch/setIntegrationConflict
  // now report per-item ok/error so a mismatch is machine-detectable without
  // failing the whole batch (partial success stays possible).

  it('setColumn: unmatched id reports ok:false, matched id reports ok:true, matched id still applies', async () => {
    const dir = await makeRegisteredDir('results-setColumn')
    const task = await addTask(dir, 'Real card')
    const res = await app.request(
      '/api/project/tasks',
      json({
        path: dir,
        setColumn: [
          { id: task.id, column: 'review' },
          { id: 'not-a-real-id', column: 'review' },
        ],
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results.setColumn).toEqual([
      { id: task.id, ok: true },
      { id: 'not-a-real-id', ok: false, error: 'unknown task id' },
    ])
    expect((await getTask(dir, task.id))?.boardColumn).toBe('review')
  })

  it('setBranch: unmatched id and invalid branch both report ok:false with distinct reasons', async () => {
    const dir = await makeRegisteredDir('results-setBranch')
    const task = await addTask(dir, 'Branch results card')
    const res = await app.request(
      '/api/project/tasks',
      json({
        path: dir,
        setBranch: [
          { id: task.id, branch: 'task/ok-branch' },
          { id: task.id, branch: 'has space' },
          { id: 'ghost-id', branch: 'task/whatever' },
        ],
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results.setBranch).toEqual([
      { id: task.id, ok: true },
      { id: task.id, ok: false, error: 'invalid branch name' },
      { id: 'ghost-id', ok: false, error: 'unknown task id' },
    ])
    expect((await getTask(dir, task.id))?.branch).toBe('task/ok-branch')
  })

  it('setIntegrationConflict: unmatched id reports ok:false; matched id applies and reports ok:true', async () => {
    const dir = await makeRegisteredDir('results-setIntegrationConflict')
    const task = await addTask(dir, 'Conflict results card')
    const res = await app.request(
      '/api/project/tasks',
      json({
        path: dir,
        setIntegrationConflict: [
          { id: task.id, value: true },
          { id: 'missing-id', value: true },
        ],
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results.setIntegrationConflict).toEqual([
      { id: task.id, ok: true },
      { id: 'missing-id', ok: false, error: 'unknown task id' },
    ])
    expect((await getTask(dir, task.id))?.integrationConflict).toBe(true)
  })

  it('a batch with only some fields set only reports results for those fields', async () => {
    const dir = await makeRegisteredDir('results-partial-fields')
    const task = await addTask(dir, 'Only setColumn card')
    const res = await app.request(
      '/api/project/tasks',
      json({ path: dir, setColumn: [{ id: task.id, column: 'doing' }] }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results.setColumn).toEqual([{ id: task.id, ok: true }])
    expect(body.results.setBranch).toBeUndefined()
    expect(body.results.setIntegrationConflict).toBeUndefined()
  })

  it('plain add/markDone-only calls carry no results key at all (fully non-regressing)', async () => {
    const dir = await makeRegisteredDir('results-no-key')
    const res = await app.request('/api/project/tasks', json({ path: dir, add: ['A new card'] }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results).toBeUndefined()
    expect(Array.isArray(body.tasks)).toBe(true)
  })
})

describe('POST /api/project/tasks — rework (差し戻し loop-guard)', () => {
  // API equivalent of ~/.claude/swarm-board.sh's `rework` subcommand: review→doing
  // move + per-card counter bump in one call, parking in 'blocked' once the bump
  // pushes the count past maxReworks (default 3) — for OG-only environments
  // without that script (card [og-manage] rework counterのAPI化).

  it('moves the card to doing and reports the bumped count', async () => {
    const dir = await makeRegisteredDir('rework-basic')
    const task = await addTask(dir, 'Needs fixes')
    await app.request(
      '/api/project/tasks',
      json({ path: dir, setColumn: [{ id: task.id, column: 'review' }] }),
    )
    const res = await app.request('/api/project/tasks', json({ path: dir, rework: [{ id: task.id }] }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results.rework).toEqual([{ id: task.id, ok: true, column: 'doing', count: 1 }])
    const after = await getTask(dir, task.id)
    expect(after?.boardColumn).toBe('doing')
    expect(after?.done).toBe(false)
    expect(after?.reworkCount).toBe(1)
  })

  it('parks in blocked once the count exceeds maxReworks (default 3)', async () => {
    const dir = await makeRegisteredDir('rework-limit')
    const task = await addTask(dir, 'Chronically broken')

    for (let i = 1; i <= 3; i++) {
      const res = await app.request(
        '/api/project/tasks',
        json({ path: dir, rework: [{ id: task.id }] }),
      )
      const body = await res.json()
      expect(body.results.rework).toEqual([{ id: task.id, ok: true, column: 'doing', count: i }])
    }
    // The 4th round-trip (count=4) exceeds the default max of 3 → evacuate to blocked.
    const res = await app.request('/api/project/tasks', json({ path: dir, rework: [{ id: task.id }] }))
    const body = await res.json()
    expect(body.results.rework).toEqual([{ id: task.id, ok: true, column: 'blocked', count: 4 }])
    const after = await getTask(dir, task.id)
    expect(after?.boardColumn).toBe('blocked')
    expect(after?.reworkCount).toBe(4)
  })

  it('honours a custom maxReworks override', async () => {
    const dir = await makeRegisteredDir('rework-custom-max')
    const task = await addTask(dir, 'Custom limit')
    await app.request('/api/project/tasks', json({ path: dir, rework: [{ id: task.id, maxReworks: 1 }] }))
    const res = await app.request(
      '/api/project/tasks',
      json({ path: dir, rework: [{ id: task.id, maxReworks: 1 }] }),
    )
    const body = await res.json()
    expect(body.results.rework).toEqual([{ id: task.id, ok: true, column: 'blocked', count: 2 }])
  })

  it('landing on done or todo resets the counter (fresh reuse is not pre-tripped)', async () => {
    const dir = await makeRegisteredDir('rework-reset')
    const task = await addTask(dir, 'Reset me')
    await app.request('/api/project/tasks', json({ path: dir, rework: [{ id: task.id }] }))
    expect((await getTask(dir, task.id))?.reworkCount).toBe(1)

    await app.request(
      '/api/project/tasks',
      json({ path: dir, setColumn: [{ id: task.id, column: 'done' }] }),
    )
    expect((await getTask(dir, task.id))?.reworkCount).toBeUndefined()

    // A later rework round starts counting from zero again, not from where it left off.
    const res = await app.request(
      '/api/project/tasks',
      json({ path: dir, setColumn: [{ id: task.id, column: 'review' }] }),
    )
    expect(res.status).toBe(200)
    const rw = await app.request('/api/project/tasks', json({ path: dir, rework: [{ id: task.id }] }))
    const body = await rw.json()
    expect(body.results.rework).toEqual([{ id: task.id, ok: true, column: 'doing', count: 1 }])
  })

  it('markDone (the run-flow on-finish done landing) also resets the counter', async () => {
    // markDone is a first-class "done" landing (BoardModule's run-flow
    // on-finish curl) alongside setColumn{column:'done'} — the loop guard must
    // reset there too, not just via the explicit setColumn path.
    const dir = await makeRegisteredDir('rework-reset-markdone')
    const task = await addTask(dir, 'Reset via markDone')
    await app.request('/api/project/tasks', json({ path: dir, rework: [{ id: task.id }] }))
    expect((await getTask(dir, task.id))?.reworkCount).toBe(1)

    await app.request('/api/project/tasks', json({ path: dir, markDone: [task.id] }))
    const after = await getTask(dir, task.id)
    expect(after?.done).toBe(true)
    expect(after?.boardColumn).toBe('done')
    expect(after?.reworkCount).toBeUndefined()
  })

  it('unknown id reports ok:false and does not throw', async () => {
    const dir = await makeRegisteredDir('rework-missing')
    const res = await app.request(
      '/api/project/tasks',
      json({ path: dir, rework: [{ id: 'ghost-id' }] }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results.rework).toEqual([{ id: 'ghost-id', ok: false, error: 'unknown task id' }])
  })

  it('a non-integer / negative maxReworks is rejected without applying the move', async () => {
    const dir = await makeRegisteredDir('rework-bad-max')
    const task = await addTask(dir, 'Guarded max')
    for (const bad of [-1, 1.5, 'three' as unknown as number]) {
      const res = await app.request(
        '/api/project/tasks',
        json({ path: dir, rework: [{ id: task.id, maxReworks: bad }] }),
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.results.rework[0].ok).toBe(false)
    }
    expect((await getTask(dir, task.id))?.boardColumn).toBe('todo')
    expect((await getTask(dir, task.id))?.reworkCount).toBeUndefined()
  })

  it('non-array rework is rejected (400), never 500', async () => {
    const dir = await makeRegisteredDir('rework-nonarray')
    const res = await app.request('/api/project/tasks', json({ path: dir, rework: 'oops' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/rework/)
  })
})

describe('POST /api/project/tasks — non-array fields are rejected, never iterated', () => {
  // Repro of the audit-minor bug: `body` is an unchecked `as TasksBody` over raw
  // JSON, and every mutation field feeds a `for...of` (or `new Set`). A STRING
  // add was walked PER-CHARACTER — POST {add:'Hello'} silently created cards
  // H/e/l/l/o — while a NUMBER/OBJECT/BOOLEAN add/markDone/setColumn is
  // non-iterable → TypeError → app.onError 500. Each present-but-non-array field
  // must now 400 up front, corrupting nothing and never 500-ing.

  const countTasks = async (path: string): Promise<number> => {
    const res = await app.request(`/api/project?path=${encodeURIComponent(path)}`)
    expect(res.status).toBe(200)
    return ((await res.json()).tasks as ProjectTask[]).length
  }

  it('string add is rejected (400) and creates NO per-character cards', async () => {
    const dir = await makeRegisteredDir('nonarray-add-string')
    const res = await app.request('/api/project/tasks', json({ path: dir, add: 'Hello' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/add/)
    expect(await countTasks(dir)).toBe(0) // not 5 (H/e/l/l/o)
  })

  it('number / object / boolean add is rejected (400), never a 500', async () => {
    const dir = await makeRegisteredDir('nonarray-add-misc')
    for (const bad of [5, {}, { 0: 'x' }, true]) {
      const res = await app.request('/api/project/tasks', json({ path: dir, add: bad }))
      expect(res.status).toBe(400) // never 500 (TypeError on a non-iterable)
    }
    expect(await countTasks(dir)).toBe(0)
  })

  it('non-array markDone is rejected (400) and never marks the real card done', async () => {
    const dir = await makeRegisteredDir('nonarray-markdone')
    const task = await addTask(dir, 'stays open')
    // 'abc' → old code did `new Set("abc")` = {a,b,c} (chars as ids); {length:3}
    // → `new Set({length:3})` threw → 500. Both must now 400 instead.
    for (const bad of [5, 'abc', {}, { length: 3 }]) {
      const res = await app.request('/api/project/tasks', json({ path: dir, markDone: bad }))
      expect(res.status).toBe(400)
    }
    expect((await getTask(dir, task.id))?.done).toBe(false)
  })

  it('non-array setColumn / setPrUrl / setBranch / setIntegrationConflict are rejected (400)', async () => {
    const dir = await makeRegisteredDir('nonarray-rest')
    for (const field of ['setColumn', 'setPrUrl', 'setBranch', 'setIntegrationConflict', 'rework'] as const) {
      for (const bad of [5, {}, 'oops']) {
        const res = await app.request('/api/project/tasks', json({ path: dir, [field]: bad }))
        expect(res.status).toBe(400)
        expect((await res.json()).error).toMatch(new RegExp(field))
      }
    }
  })

  it('well-formed arrays still pass through after a rejected non-array', async () => {
    const dir = await makeRegisteredDir('nonarray-control')
    // A bogus request changes nothing...
    expect((await app.request('/api/project/tasks', json({ path: dir, add: 'nope' }))).status).toBe(400)
    expect(await countTasks(dir)).toBe(0)
    // ...and the normal array path is unaffected (condition 3: arrays as before).
    const task = await addTask(dir, 'real card')
    expect(task.boardColumn).toBe('todo')
    const done = await app.request('/api/project/tasks', json({ path: dir, markDone: [task.id] }))
    expect(done.status).toBe(200)
    expect((await getTask(dir, task.id))?.done).toBe(true)
  })
})

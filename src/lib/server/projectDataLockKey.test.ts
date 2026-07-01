import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, symlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join, sep } from 'path'
import type { ProjectData, ProjectTask } from '../types'
import { mutateProjectData, readProjectData, writeProjectData } from './projectData'
import { projectDataDir } from './projectDataPath'
import { registerTestProject } from '../../test/registerProject'

// withBoardLock keys the per-project CAS serial queue on the RESOLVED central
// data dir (projectDataDir's UUID-derived path), NOT the raw projectPath. Before
// the fix the raw path was the lock key, so two spellings of the SAME project —
// a trailing slash, or a /tmp↔/private/tmp symlink — landed in DIFFERENT queues,
// both read the same updatedAt at T0, both passed the compare-and-swap, and the
// second write SILENTLY clobbered the first (no ProjectDataConflictError). These
// tests pin the spelling-independence. HOME is tmpdir-isolated by setup-home.ts.

const card = (id: string): ProjectTask => ({
  id,
  title: `Task ${id}`,
  done: false,
  createdAt: '2026-06-30T00:00:00.000Z',
  boardColumn: 'todo',
})

const data = (over: Partial<ProjectData> = {}): ProjectData => ({
  description: 'lockkey project',
  tasks: [],
  notes: '',
  updatedAt: '',
  ...over,
})

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

describe('withBoardLock — lock key is the canonical project dir, not the raw spelling', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'og-lockkey-'))
    await mkdir(dir, { recursive: true })
    await registerTestProject(dir)
  })

  it('all spellings of one project resolve to the same central dir (the lock key)', async () => {
    // The lock key is whatever projectDataDir returns. If every spelling of one
    // project maps to ONE string, keying on it serializes them; this is the
    // invariant the behavioural tests below depend on.
    const base = await projectDataDir(dir)
    expect(await projectDataDir(dir + sep)).toBe(base) // trailing slash
    expect(await projectDataDir(join(dir, '.'))).toBe(base) // /x/.
    expect(await projectDataDir(join(dir, 'sub', '..'))).toBe(base) // /x/sub/..
  })

  it('serializes concurrent mutations across a trailing-slash spelling (no silent clobber)', async () => {
    await writeProjectData(dir, data({ tasks: [] }))
    // A (bare path) holds the lock for 50ms after reading the empty board; B
    // (trailing-slash spelling) fires immediately. PRE-FIX the two spellings key
    // different queues: B writes [B] while A still holds its stale empty read,
    // then A's CAS sees B's newer stamp and throws (rejecting Promise.all) OR A
    // overwrites B — either way the two cards never coexist, so the assertion
    // fails. POST-FIX they share one queue, B waits for A, and both land.
    const opA = mutateProjectData(dir, async (d) => {
      await delay(50)
      d.tasks.push(card('A'))
    })
    const opB = mutateProjectData(dir + sep, async (d) => {
      d.tasks.push(card('B'))
    })
    await Promise.all([opA, opB])
    const ids = (await readProjectData(dir)).tasks.map((t) => t.id).sort()
    expect(ids).toEqual(['A', 'B'])
  })

  it('serializes concurrent mutations across a symlinked spelling (/tmp↔/private/tmp style)', async () => {
    // A sibling symlink pointing AT the registered project dir. canonicalize
    // (realpath) collapses it back to `dir`, so it is the same project under a
    // different raw string — exactly the macOS /tmp→/private/tmp situation.
    const linkParent = await mkdtemp(join(tmpdir(), 'og-lockkey-link-'))
    const link = join(linkParent, 'aliased-project')
    await symlink(dir, link)
    // Sanity: the symlink really resolves to the same central dir (lock key).
    expect(await projectDataDir(link)).toBe(await projectDataDir(dir))

    await writeProjectData(dir, data({ tasks: [] }))
    const opA = mutateProjectData(dir, async (d) => {
      await delay(50)
      d.tasks.push(card('A'))
    })
    const opB = mutateProjectData(link, async (d) => {
      d.tasks.push(card('B'))
    })
    await Promise.all([opA, opB])
    const ids = (await readProjectData(dir)).tasks.map((t) => t.id).sort()
    expect(ids).toEqual(['A', 'B'])
  })

  it('still runs writes to DIFFERENT projects in parallel (independent lock keys)', async () => {
    // A genuinely-different project must NOT serialize behind the first: distinct
    // UUIDs ⇒ distinct central dirs ⇒ distinct lock keys. This guards condition
    // (2) — the fix must not over-serialize unrelated projects.
    const dir2 = await mkdtemp(join(tmpdir(), 'og-lockkey2-'))
    await mkdir(dir2, { recursive: true })
    await registerTestProject(dir2)
    expect(await projectDataDir(dir2)).not.toBe(await projectDataDir(dir))

    await writeProjectData(dir, data({ tasks: [card('a')] }))
    await writeProjectData(dir2, data({ tasks: [card('a')] }))
    // The first project's op stalls 30ms; the second must complete regardless,
    // and each card lands in ITS OWN project (no cross-project mixing).
    const [r1, r2] = await Promise.all([
      mutateProjectData(dir, async (d) => {
        await delay(30)
        d.tasks.push(card('x'))
      }),
      mutateProjectData(dir2, (d) => {
        d.tasks.push(card('y'))
      }),
    ])
    expect(r1.tasks.map((t) => t.id).sort()).toEqual(['a', 'x'])
    expect(r2.tasks.map((t) => t.id).sort()).toEqual(['a', 'y'])
  })
})

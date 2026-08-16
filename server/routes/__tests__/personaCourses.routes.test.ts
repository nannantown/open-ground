import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, realpath, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from '../../app'
import { listPersonaCourses, readPersonaCoursesStore } from '@/lib/server/personaCourses'
import { readManualJudgments } from '@/lib/server/youCorpus'
import { personaCoursesFile, youCorpusAdditionsFile } from '@/lib/server/paths'
import { BIG5_ITEMS, COURSES } from '@/lib/persona/instruments'
import type {
  PersonaCourseHistoryResponse,
  PersonaCoursesResponse,
  PersonaPortrait,
  SubmitPersonaCourseResponse,
} from '@/lib/types'

// ─────────────────────────────────────────────────────────────────────────────
// Persona COURSE routes — the owner-side journey over HTTP: list → submit →
// list again, plus the loud edges (unknown course, half-answered vector,
// non-array body) and the loopback gate.
//
// Everything is read back through the PRODUCTION readers (listPersonaCourses /
// readManualJudgments — the latter is what GET /api/you-corpus/judgments
// serves), never by parsing files by hand: a 200 proves nothing about what
// landed on disk.
//
// HOME ISOLATION: OPENGROUND_HOME is a throwaway tmp dir per test, and the
// corpus sources are pinned to tmp fixtures so the assemble triggered by each
// append never reads the real auto-memory.
// ─────────────────────────────────────────────────────────────────────────────

let home: string
const ENV_KEYS = ['OPENGROUND_HOME', 'OPENGROUND_MEMORY_DIR', 'OPENGROUND_CONCEPT_PATH'] as const
let savedEnv: Record<string, string | undefined> = {}

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-persona-routes-')))
  const memDir = join(home, 'fixture-memory')
  await mkdir(memDir, { recursive: true })
  await writeFile(
    join(memDir, 'project_notes.md'),
    '---\nname: project_notes\ndescription: fixture\nmetadata: \n  type: project\n---\n\nfixture body\n',
  )
  const conceptPath = join(home, 'fixture-CONCEPT.md')
  await writeFile(conceptPath, '# fixture concept\n')
  process.env.OPENGROUND_HOME = home
  process.env.OPENGROUND_MEMORY_DIR = memDir
  process.env.OPENGROUND_CONCEPT_PATH = conceptPath
})

afterEach(async () => {
  for (const k of ENV_KEYS) {
    // NEVER unset the home vars: empty means the user's REAL ~/.openground
    // (paths.ts openGroundHome), and vitest reuses workers across files.
    if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k]
    else if (k === 'OPENGROUND_HOME') process.env[k] = home
    else process.env[k] = ''
  }
  await rm(home, { recursive: true, force: true })
})

const big5Answers = (seed = 0): number[] => Array.from({ length: 25 }, (_, i) => (i + seed) % 5)

const DAY_MS = 24 * 60 * 60 * 1000

/** A big5 vector that leans EVERY factor hard (4 on a plain item, 0 on a
 *  reverse-keyed one, read off the instrument itself) so the portrait has
 *  something decisive to say instead of the 中くらい band it skips. */
const big5Decisive = (): number[] => BIG5_ITEMS.map(([, reversed]) => (reversed ? 0 : 4))

/** Corpus nodes WITH CHOSEN DATES — appendJudgment stamps `new Date()`, so a
 *  dated fixture is written straight into the additions file. The assertions
 *  still read it back through readManualJudgments (what
 *  GET /api/you-corpus/judgments serves). */
const seedDatedJudgments = async (entries: { text: string; daysAgo: number }[]) => {
  const now = Date.now()
  await writeFile(
    youCorpusAdditionsFile(),
    JSON.stringify(
      entries.map((e, i) => ({
        id: `seed-${i}`,
        text: e.text,
        addedAt: new Date(now - e.daysAgo * DAY_MS).toISOString(),
      })),
    ),
  )
}

const submit = (id: string, body: unknown) =>
  app.request(`/api/persona/courses/${id}/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const exists = async (p: string): Promise<boolean> => {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

describe('GET /api/persona/courses', () => {
  it('lists the catalogue with nulls before anything is taken', async () => {
    const res = await app.request('/api/persona/courses')
    expect(res.status).toBe(200)
    const body = (await res.json()) as PersonaCoursesResponse
    expect(body.courses.map((c) => c.id)).toEqual(['big5', 'type', 'values', 'work'])
    expect(body.courses.every((c) => c.lastTakenAt === null && c.headline === null)).toBe(true)
    // The provenance string is shown verbatim on the sheet — it has to survive
    // the wire, not just the module.
    expect(body.courses.find((c) => c.id === 'type')?.source).toContain('MBTI®')
  })

  it('still answers over a CORRUPT store (fail-open, not a 500)', async () => {
    await writeFile(personaCoursesFile(), 'not json at all')
    const res = await app.request('/api/persona/courses')
    expect(res.status).toBe(200)
    const body = (await res.json()) as PersonaCoursesResponse
    expect(body.courses).toHaveLength(4)
    expect(body.courses.every((c) => c.lastTakenAt === null)).toBe(true)
  })

  it('rejects a non-loopback Host (DNS-rebinding gate)', async () => {
    const res = await app.request('/api/persona/courses', { headers: { host: 'evil.example.com' } })
    expect(res.status).toBe(403)
  })
})

describe('POST /api/persona/courses/:id/submit', () => {
  it('scores, persists and mints — and the next GET shows it', async () => {
    const res = await submit('big5', { answers: big5Answers() })
    expect(res.status).toBe(200)
    const body = (await res.json()) as SubmitPersonaCourseResponse
    expect(body.record.result.courseId).toBe('big5')
    expect(body.record.result.findings).toHaveLength(5)
    expect(body.minted).toBe(5)

    const listed = (await (await app.request('/api/persona/courses')).json()) as PersonaCoursesResponse
    const big5 = listed.courses.find((c) => c.id === 'big5')
    expect(big5?.lastTakenAt).toBe(body.record.takenAt)
    expect(big5?.headline).toBe(body.record.result.headline)

    // The corpus half, read back through the reader GET /api/you-corpus/judgments
    // serves — over HTTP too, since that is the surface the tab reads.
    const judgments = await readManualJudgments()
    expect(judgments).toHaveLength(5)
    const corpusRes = await app.request('/api/you-corpus/judgments')
    expect(corpusRes.status).toBe(200)
    const corpusBody = (await corpusRes.json()) as { judgments: { text: string; tags?: string[] }[] }
    for (const finding of body.record.result.findings) {
      const hit = corpusBody.judgments.find((j) => j.text === finding.text)
      expect(hit, `no corpus node for "${finding.text}"`).toBeTruthy()
      // The REGION tag rides along so the figure seats the finding from the
      // node itself (regions.ts tier 1), not by re-deriving it from the course.
      // The TAKE stamp rides along too, and it is this take's `takenAt` — the
      // one thing that makes a later retake replace these findings rather than
      // stack on top of them (youCorpus.liveJudgments).
      expect(hit?.tags).toEqual([
        'persona',
        'big5',
        'region:head',
        `take:${body.record.takenAt}`,
      ])
    }
  })

  it('a SHORT answer vector is a 400 — nothing persisted, nothing minted', async () => {
    const res = await submit('big5', { answers: [1, 2, 3] })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    // The scoring error's own message, so the client can say WHAT was wrong.
    expect(body.error).toContain('answers length 3 != 25')

    expect(await exists(personaCoursesFile())).toBe(false)
    expect(await readManualJudgments()).toEqual([])
    const listed = await listPersonaCourses()
    expect(listed.courses.every((c) => c.lastTakenAt === null)).toBe(true)
  })

  it('an OUT-OF-RANGE answer is a 400 — nothing persisted, nothing minted', async () => {
    const bad = big5Answers()
    bad[3] = 7
    const res = await submit('big5', { answers: bad })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('out of range')
    expect(await exists(personaCoursesFile())).toBe(false)
    expect(await readManualJudgments()).toEqual([])
  })

  it('a non-integer answer is a 400 (no silent coercion)', async () => {
    const res = await submit('big5', { answers: big5Answers().map(String) })
    expect(res.status).toBe(400)
    expect(await exists(personaCoursesFile())).toBe(false)
  })

  it('an unknown course id is a 404', async () => {
    const res = await submit('astrology', { answers: [0, 1, 2] })
    expect(res.status).toBe(404)
    expect(await exists(personaCoursesFile())).toBe(false)
    expect(await readManualJudgments()).toEqual([])
  })

  it('a missing / non-array answers body is a 400', async () => {
    expect((await submit('big5', {})).status).toBe(400)
    expect((await submit('big5', { answers: 'nope' })).status).toBe(400)
    expect(await exists(personaCoursesFile())).toBe(false)
  })

  it('a retake replaces the last result and keeps the previous one', async () => {
    const first = (await (await submit('big5', { answers: big5Answers(0) })).json()) as SubmitPersonaCourseResponse
    const second = (await (await submit('big5', { answers: big5Answers(2) })).json()) as SubmitPersonaCourseResponse

    const listed = (await (await app.request('/api/persona/courses')).json()) as PersonaCoursesResponse
    expect(listed.courses.find((c) => c.id === 'big5')?.lastTakenAt).toBe(second.record.takenAt)

    const store = await readPersonaCoursesStore()
    expect(store.history.big5?.map((h) => h.takenAt)).toEqual([first.record.takenAt])
    // Both takes minted: the corpus keeps the drift rather than replacing it.
    expect(await readManualJudgments()).toHaveLength(10)
  })

  it('rejects a cross-origin submit (CSRF guard) and writes nothing', async () => {
    const res = await app.request('/api/persona/courses/big5/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' },
      body: JSON.stringify({ answers: big5Answers() }),
    })
    expect(res.status).toBe(403)
    expect(await exists(personaCoursesFile())).toBe(false)
  })
})

describe('GET /api/persona/courses/:id/history', () => {
  const history = async (id: string) => {
    const res = await app.request(`/api/persona/courses/${id}/history`)
    return { res, body: (await res.json()) as PersonaCourseHistoryResponse }
  }

  it('returns BOTH takes newest-first, and the newest is the CURRENT record', async () => {
    const first = (await (await submit('big5', { answers: big5Answers(0) })).json()) as SubmitPersonaCourseResponse
    const second = (await (await submit('big5', { answers: big5Answers(2) })).json()) as SubmitPersonaCourseResponse

    const { res, body } = await history('big5')
    expect(res.status).toBe(200)
    expect(body.courseId).toBe('big5')
    expect(body.takes.map((t) => t.takenAt)).toEqual([second.record.takenAt, first.record.takenAt])
    // The head is the record the tab shows — read back through the production
    // store reader, not compared against the response to itself.
    const store = await readPersonaCoursesStore()
    expect(body.takes[0]).toEqual(store.records.big5)
    expect(body.takes[0].answers).toEqual(big5Answers(2))
    expect(body.takes[1].answers).toEqual(big5Answers(0))
  })

  it('orders THREE takes newest → oldest over the wire (the store holds them the other way)', async () => {
    const takenAts: string[] = []
    for (const seed of [0, 1, 2]) {
      const body = (await (await submit('big5', { answers: big5Answers(seed) })).json()) as SubmitPersonaCourseResponse
      takenAts.push(body.record.takenAt)
    }
    const store = await readPersonaCoursesStore()
    expect(store.history.big5?.map((h) => h.takenAt)).toEqual([takenAts[0], takenAts[1]])

    const { body } = await history('big5')
    // Three is the smallest count that can tell a real reversal from a no-op.
    expect(body.takes.map((t) => t.takenAt)).toEqual([takenAts[2], takenAts[1], takenAts[0]])
    // …and by CONTENT too, so the order still fails loudly if two takes happen to
    // land in the same millisecond (the wire has no injectable clock).
    expect(body.takes.map((t) => t.answers)).toEqual([
      big5Answers(2),
      big5Answers(1),
      big5Answers(0),
    ])
  })

  it('a course that exists but was never taken is a 200 with an EMPTY list', async () => {
    await submit('big5', { answers: big5Answers() })
    const { res, body } = await history('work')
    expect(res.status).toBe(200)
    expect(body).toEqual({ courseId: 'work', takes: [] })
  })

  it('an unknown course id is a 404', async () => {
    const res = await app.request('/api/persona/courses/astrology/history')
    expect(res.status).toBe(404)
  })

  it('still answers over a CORRUPT store (fail-open, not a 500)', async () => {
    await writeFile(personaCoursesFile(), 'not json at all')
    const { res, body } = await history('big5')
    expect(res.status).toBe(200)
    expect(body).toEqual({ courseId: 'big5', takes: [] })
  })

  it('rejects a non-loopback Host (DNS-rebinding gate)', async () => {
    const res = await app.request('/api/persona/courses/big5/history', {
      headers: { host: 'evil.example.com' },
    })
    expect(res.status).toBe(403)
  })
})

describe('GET /api/persona/portrait', () => {
  const portrait = async () => {
    const res = await app.request('/api/persona/portrait')
    return { res, body: (await res.json()) as PersonaPortrait }
  }

  it('answers with NO lines before anything is taken — and does not invent one', async () => {
    const { res, body } = await portrait()
    expect(res.status).toBe(200)
    expect(body.lines).toEqual([])
    expect(body.takenCount).toBe(0)
    expect(body.courseCount).toBe(COURSES.length)
    expect(body.nodeCount).toBe(0)
  })

  it('carries composed lines once a course is really scored, each naming its course', async () => {
    expect((await submit('big5', { answers: big5Decisive() })).status).toBe(200)
    const { res, body } = await portrait()
    expect(res.status).toBe(200)
    expect(body.lines.length).toBeGreaterThan(0)
    expect(body.takenCount).toBe(1)
    for (const line of body.lines) {
      const course = COURSES.find((c) => c.id === line.courseId)
      expect(course, `line cites an unknown course: ${line.courseId}`).toBeTruthy()
      // Provenance survives the wire: instrument + the number it came from.
      expect(line.detail, `no instrument in detail: ${line.detail}`).toContain(course?.name)
      expect(line.text.length).toBeGreaterThan(0)
    }
  })

  it('reports the corpus counts the production reader sees, recent = last 7 days', async () => {
    await seedDatedJudgments([
      { text: '40日前の判断', daysAgo: 40 },
      { text: '9日前の判断', daysAgo: 9 },
      { text: '1日前の判断', daysAgo: 1 },
    ])
    await submit('big5', { answers: big5Decisive() }) // mints 5 more, stamped now

    const judgments = await readManualJudgments()
    expect(judgments).toHaveLength(8)

    const { body } = await portrait()
    expect(body.nodeCount).toBe(judgments.length)
    expect(body.recentCount).toBe(6) // the 1-day-old one + the 5 just minted
  })

  it('still answers over a CORRUPT store (fail-open, not a 500)', async () => {
    await writeFile(personaCoursesFile(), 'not json at all')
    const { res, body } = await portrait()
    expect(res.status).toBe(200)
    expect(body.lines).toEqual([])
    expect(body.takenCount).toBe(0)
  })

  it('rejects a non-loopback Host (DNS-rebinding gate)', async () => {
    const res = await app.request('/api/persona/portrait', { headers: { host: 'evil.example.com' } })
    expect(res.status).toBe(403)
  })
})

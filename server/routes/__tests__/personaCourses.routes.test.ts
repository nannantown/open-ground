import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, realpath, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from '../../app'
import { listPersonaCourses, readPersonaCoursesStore } from '@/lib/server/personaCourses'
import { readManualJudgments } from '@/lib/server/youCorpus'
import { personaCoursesFile } from '@/lib/server/paths'
import type { PersonaCoursesResponse, SubmitPersonaCourseResponse } from '@/lib/types'

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
      expect(hit?.tags).toEqual(['persona', 'big5'])
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

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, readFile, writeFile, realpath, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  MAX_HISTORY,
  UnknownPersonaCourseError,
  getPersonaCourseHistory,
  getPersonaPortrait,
  listPersonaCourses,
  readPersonaCoursesStore,
  submitPersonaCourse,
} from './personaCourses'
import { readManualJudgments } from './youCorpus'
import { personaCoursesFile, youCorpusAdditionsFile } from './paths'
import { BIG5_ITEMS, COURSES, PersonaScoringError } from '@/lib/persona/instruments'
import type { AppendJudgmentInput } from './youCorpus'

// The persona-course STORE + write path. Nothing here is mocked except where a
// failure has to be INJECTED (the append-fails case): the scoring is the real
// pure instrument, the store is written and read back through the production
// reader, and the corpus findings are appended through the real appendJudgment
// and read back through readManualJudgments — the same function
// GET /api/you-corpus/judgments serves. A test that only checked "the writer was
// called" would pass against a writer that writes nowhere.
//
// HOME ISOLATION: OPENGROUND_HOME is a throwaway tmp dir per test. The corpus
// SOURCE locations are pinned to tmp fixtures via OPENGROUND_MEMORY_DIR /
// OPENGROUND_CONCEPT_PATH, so the real auto-memory is never read and the
// assemble that appendJudgment triggers is hermetic.

let home: string
let memDir: string
let conceptPath: string
const ENV_KEYS = ['OPENGROUND_HOME', 'OPENGROUND_MEMORY_DIR', 'OPENGROUND_CONCEPT_PATH'] as const
let savedEnv: Record<string, string | undefined> = {}

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-persona-courses-')))
  memDir = join(home, 'fixture-memory')
  await mkdir(memDir, { recursive: true })
  await writeFile(
    join(memDir, 'project_notes.md'),
    '---\nname: project_notes\ndescription: fixture\nmetadata: \n  type: project\n---\n\nfixture body\n',
  )
  conceptPath = join(home, 'fixture-CONCEPT.md')
  await writeFile(conceptPath, '# fixture concept\n')
  process.env.OPENGROUND_HOME = home
  process.env.OPENGROUND_MEMORY_DIR = memDir
  process.env.OPENGROUND_CONCEPT_PATH = conceptPath
})

afterEach(async () => {
  for (const k of ENV_KEYS) {
    // NEVER `delete` OPENGROUND_HOME — unset means the user's REAL
    // ~/.openground (paths.ts openGroundHome), and vitest reuses workers across
    // files. Restore, or leave it pointing at the (removed) tmp dir.
    if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k]
    else if (k === 'OPENGROUND_HOME') process.env[k] = home
    else process.env[k] = ''
  }
  await rm(home, { recursive: true, force: true })
})

/** A complete, in-range big5 vector (25 items, 0..4). `seed` shifts the pattern
 *  so two takes score differently. */
const big5Answers = (seed = 0): number[] =>
  Array.from({ length: 25 }, (_, i) => (i + seed) % 5)

const exists = async (p: string): Promise<boolean> => {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

const DAY_MS = 24 * 60 * 60 * 1000

/** A big5 vector that leans EVERY factor hard, so the portrait has something
 *  decisive to say. Built FROM THE INSTRUMENT'S OWN KEY LIST (agreeing hardest
 *  means 4 on a plain item and 0 on a reverse-keyed one) rather than hand-typed:
 *  if an item is ever re-keyed this stays a 100% lean instead of silently
 *  drifting into the 中くらい band the composer skips. */
const big5Decisive = (): number[] => BIG5_ITEMS.map(([, reversed]) => (reversed ? 0 : 4))

/** Judgments straight into the corpus's additions file WITH CHOSEN DATES —
 *  appendJudgment stamps `new Date()`, so a dated fixture has to be written.
 *  Everything is still read back through readManualJudgments (the production
 *  reader GET /api/you-corpus/judgments serves). */
const seedDatedJudgments = async (entries: { text: string; daysAgo: number }[], now = Date.now()) => {
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

/** The shape appendJudgment resolves with, for the injected-failure stand-in.
 *  Built in full (not `as never`) so the stand-in cannot drift out of the
 *  contract the real writer honours. */
const fakeAppendResult = (id: string, text: string) => ({
  judgment: { id, text, addedAt: new Date(0).toISOString() },
  meta: {
    path: join(home, 'you-corpus.md'),
    assembledAt: new Date(0).toISOString(),
    sizeBytes: 0,
    memoryCount: 0,
    manualCount: 0,
    conceptIncluded: false,
    businessVisionIncluded: false,
  },
})

describe('submitPersonaCourse — score, persist, read back', () => {
  it('scores a full big5 vector and the PRODUCTION reader shows lastTakenAt + headline', async () => {
    const { record, minted } = await submitPersonaCourse('big5', big5Answers())

    expect(record.result.courseId).toBe('big5')
    expect(record.result.rows).toHaveLength(5)
    expect(record.result.findings).toHaveLength(5)
    expect(record.answers).toEqual(big5Answers())
    expect(minted).toBe(record.result.findings.length)

    // Read back through the reader the route serves — not through the object we
    // just built, and not by parsing the file by hand.
    const listed = await listPersonaCourses()
    const big5 = listed.courses.find((c) => c.id === 'big5')
    expect(big5?.lastTakenAt).toBe(record.takenAt)
    expect(big5?.headline).toBe(record.result.headline)
    expect(big5?.headline).toContain('いちばんはっきり出たのは')
    // The catalogue still answers for every course, and an untaken one is null —
    // the honest "never taken", not a fabricated zero.
    expect(listed.courses.map((c) => c.id)).toEqual(['big5', 'type', 'values', 'work'])
    for (const c of listed.courses.filter((x) => x.id !== 'big5')) {
      expect(c.lastTakenAt).toBeNull()
      expect(c.headline).toBeNull()
    }
    // The catalogue's provenance line is the licensing promise — it must survive
    // the round trip verbatim.
    expect(big5?.source).toContain('IPIP')
    expect(big5?.itemCount).toBe(25)
  })

  it('writes the store 0600 (personal data)', async () => {
    await submitPersonaCourse('big5', big5Answers())
    const s = await stat(personaCoursesFile())
    expect(s.mode & 0o777).toBe(0o600)
  })

  it('THE CORPUS REALLY RECEIVED THE FINDINGS — read back through the judgments reader', async () => {
    const { record, minted } = await submitPersonaCourse('big5', big5Answers(1))
    expect(minted).toBe(5)

    // readManualJudgments IS what GET /api/you-corpus/judgments returns.
    const judgments = await readManualJudgments()
    expect(judgments).toHaveLength(5)
    for (const finding of record.result.findings) {
      const hit = judgments.find((j) => j.text === finding.text)
      expect(hit, `no corpus node for finding "${finding.text}"`).toBeTruthy()
      expect(hit?.tags).toEqual(['persona', 'big5'])
      // Provenance: the instrument + the number it came from, plus the date.
      expect(hit?.context).toContain(finding.detail)
      expect(hit?.context).toMatch(/\d{4}-\d{2}-\d{2}/)
    }

    // And they reached the assembled markdown the proxy actually reads — the
    // append path's whole purpose.
    const corpus = await readFile(join(home, 'you-corpus.md'), 'utf8')
    expect(corpus).toContain(record.result.findings[0].text)
    expect(corpus).toContain('persona, big5')
  })

  it('mints through the SAME writer for every course (type / values / work)', async () => {
    const type = await submitPersonaCourse('type', Array.from({ length: 24 }, (_, i) => i % 2))
    expect(type.record.result.badge).toMatch(/^[EI][SN][TF][JP]$/)
    expect(type.minted).toBe(4)

    const values = await submitPersonaCourse('values', Array.from({ length: 20 }, (_, i) => i % 5))
    expect(values.minted).toBe(3)

    const work = await submitPersonaCourse('work', Array.from({ length: 20 }, (_, i) => i % 2))
    expect(work.minted).toBe(3)

    const judgments = await readManualJudgments()
    expect(judgments).toHaveLength(10)
    expect(new Set(judgments.map((j) => j.tags?.[1]))).toEqual(new Set(['type', 'values', 'work']))
  })
})

describe('retaking', () => {
  it('replaces the last result and keeps the displaced one in history', async () => {
    const first = await submitPersonaCourse('big5', big5Answers(0))
    const second = await submitPersonaCourse('big5', big5Answers(2))
    expect(second.record.result.headline).not.toBe(first.record.result.headline)

    const store = await readPersonaCoursesStore()
    expect(store.records.big5?.takenAt).toBe(second.record.takenAt)
    expect(store.records.big5?.answers).toEqual(big5Answers(2))
    // NOT lost silently: the previous take is still on disk.
    expect(store.history.big5).toHaveLength(1)
    expect(store.history.big5?.[0].takenAt).toBe(first.record.takenAt)
    expect(store.history.big5?.[0].answers).toEqual(big5Answers(0))

    const listed = await listPersonaCourses()
    expect(listed.courses.find((c) => c.id === 'big5')?.headline).toBe(
      second.record.result.headline,
    )
  })

  it('caps history at MAX_HISTORY, dropping the OLDEST take', async () => {
    const takenAts: string[] = []
    for (let i = 0; i < MAX_HISTORY + 3; i++) {
      const { record } = await submitPersonaCourse('big5', big5Answers(i), {
        now: () => Date.UTC(2026, 0, 1 + i, 12),
      })
      takenAts.push(record.takenAt)
    }
    const store = await readPersonaCoursesStore()
    const history = store.history.big5 ?? []
    expect(history).toHaveLength(MAX_HISTORY)
    // The newest history entry is the take the last submit displaced…
    expect(history[history.length - 1].takenAt).toBe(takenAts[takenAts.length - 2])
    // …and the oldest takes fell off the front, not the back.
    expect(history[0].takenAt).toBe(takenAts[2])
    expect(history.map((h) => h.takenAt)).not.toContain(takenAts[0])
    expect(store.records.big5?.takenAt).toBe(takenAts[takenAts.length - 1])
  })

  it('a retake never sheds another course record', async () => {
    await submitPersonaCourse('work', Array.from({ length: 20 }, () => 0))
    await submitPersonaCourse('big5', big5Answers(0))
    await submitPersonaCourse('big5', big5Answers(3))
    const listed = await listPersonaCourses()
    expect(listed.courses.find((c) => c.id === 'work')?.lastTakenAt).toBeTruthy()
  })
})

describe('a half-answered course mints nothing', () => {
  it('a SHORT vector throws, persists nothing and appends nothing', async () => {
    await expect(submitPersonaCourse('big5', [1, 2, 3])).rejects.toBeInstanceOf(
      PersonaScoringError,
    )
    expect(await exists(personaCoursesFile())).toBe(false)
    expect(await readManualJudgments()).toEqual([])
    const listed = await listPersonaCourses()
    expect(listed.courses.every((c) => c.lastTakenAt === null)).toBe(true)
  })

  it('an OUT-OF-RANGE answer throws, persists nothing and appends nothing', async () => {
    const bad = big5Answers()
    bad[7] = 9
    await expect(submitPersonaCourse('big5', bad)).rejects.toBeInstanceOf(PersonaScoringError)
    expect(await exists(personaCoursesFile())).toBe(false)
    expect(await readManualJudgments()).toEqual([])
  })

  it('a bad vector does not disturb an EARLIER good result', async () => {
    const good = await submitPersonaCourse('big5', big5Answers())
    await expect(submitPersonaCourse('big5', [0, 0])).rejects.toBeInstanceOf(PersonaScoringError)
    const store = await readPersonaCoursesStore()
    expect(store.records.big5?.takenAt).toBe(good.record.takenAt)
    expect(store.history.big5 ?? []).toHaveLength(0)
    expect(await readManualJudgments()).toHaveLength(5)
  })

  it('an unknown course id is a typed error, and writes nothing', async () => {
    await expect(submitPersonaCourse('astrology', [0])).rejects.toBeInstanceOf(
      UnknownPersonaCourseError,
    )
    expect(await exists(personaCoursesFile())).toBe(false)
    expect(await readManualJudgments()).toEqual([])
  })
})

describe('failure honesty', () => {
  it('minted reflects REALITY when an append fails — and the result survives', async () => {
    const seen: AppendJudgmentInput[] = []
    const { record, minted } = await submitPersonaCourse('big5', big5Answers(), {
      appendMemory: async (input) => {
        seen.push(input)
        if (seen.length === 2) throw new Error('injected: additions file unwritable')
        return fakeAppendResult(`j${seen.length}`, input.text)
      },
    })
    // 5 findings, one append blew up → 4 landed. Not 5, not 0.
    expect(seen).toHaveLength(5)
    expect(minted).toBe(4)
    // THE RESULT IS NOT LOST: it was persisted before the appends ran, so the
    // owner's 25 answers survive a corpus that was unwritable at that moment.
    const listed = await listPersonaCourses()
    expect(listed.courses.find((c) => c.id === 'big5')?.lastTakenAt).toBe(record.takenAt)
    const store = await readPersonaCoursesStore()
    expect(store.records.big5?.answers).toEqual(big5Answers())
  })

  it('reports minted 0 — and still keeps the result — when EVERY append fails', async () => {
    const { record, minted } = await submitPersonaCourse('big5', big5Answers(), {
      appendMemory: async () => {
        throw new Error('injected: corpus down')
      },
    })
    expect(minted).toBe(0)
    const store = await readPersonaCoursesStore()
    expect(store.records.big5?.takenAt).toBe(record.takenAt)
  })
})

describe('a corrupt store fails OPEN', () => {
  it('list still answers when the file is unparseable', async () => {
    await writeFile(personaCoursesFile(), '{ this is not json')
    const listed = await listPersonaCourses()
    expect(listed.courses).toHaveLength(4)
    expect(listed.courses.every((c) => c.lastTakenAt === null && c.headline === null)).toBe(true)
  })

  it('list still answers when the file is JSON of the wrong SHAPE', async () => {
    await writeFile(personaCoursesFile(), '["records"]')
    const listed = await listPersonaCourses()
    expect(listed.courses).toHaveLength(4)
    expect(listed.courses.every((c) => c.lastTakenAt === null)).toBe(true)
  })

  it('a submit over a corrupt store PRESERVES it aside instead of overwriting', async () => {
    await writeFile(personaCoursesFile(), '{ broken')
    const { record } = await submitPersonaCourse('big5', big5Answers())
    const store = await readPersonaCoursesStore()
    expect(store.records.big5?.takenAt).toBe(record.takenAt)
    const { readdir } = await import('fs/promises')
    const names = await readdir(home)
    expect(names.some((n) => n.startsWith('persona-courses.json.corrupt-'))).toBe(true)
  })
})

describe('getPersonaCourseHistory — every take, newest first', () => {
  it('returns BOTH takes newest-first, and the newest IS the current record', async () => {
    const first = await submitPersonaCourse('big5', big5Answers(0), {
      now: () => Date.UTC(2026, 0, 1, 12),
    })
    const second = await submitPersonaCourse('big5', big5Answers(2), {
      now: () => Date.UTC(2026, 0, 8, 12),
    })

    const history = await getPersonaCourseHistory('big5')
    expect(history.courseId).toBe('big5')
    expect(history.takes.map((t) => t.takenAt)).toEqual([
      second.record.takenAt,
      first.record.takenAt,
    ])
    // The head is the take the tab shows — the SAME record, answers and all, not
    // a re-derived look-alike.
    const store = await readPersonaCoursesStore()
    expect(history.takes[0]).toEqual(store.records.big5)
    expect(history.takes[0].answers).toEqual(big5Answers(2))
    expect(history.takes[1].answers).toEqual(big5Answers(0))
  })

  it('orders THREE takes newest → oldest, the opposite of how they are STORED', async () => {
    const takenAts: string[] = []
    for (let i = 0; i < 3; i++) {
      const { record } = await submitPersonaCourse('big5', big5Answers(i), {
        now: () => Date.UTC(2026, 0, 1 + i, 12),
      })
      takenAts.push(record.takenAt)
    }
    // On disk history runs oldest → newest (and excludes the current take)…
    const store = await readPersonaCoursesStore()
    expect(store.history.big5?.map((h) => h.takenAt)).toEqual([takenAts[0], takenAts[1]])
    // …so the reader has to flip it. Three takes is the smallest number that can
    // tell a real reversal from a no-op (reversing one element proves nothing).
    const history = await getPersonaCourseHistory('big5')
    expect(history.takes.map((t) => t.takenAt)).toEqual([takenAts[2], takenAts[1], takenAts[0]])
  })

  it('a course that EXISTS but was never taken is an empty list, not an error', async () => {
    await submitPersonaCourse('big5', big5Answers())
    expect(await getPersonaCourseHistory('values')).toEqual({ courseId: 'values', takes: [] })
  })

  it('an unknown course id is a typed error (route ⇒ 404)', async () => {
    await expect(getPersonaCourseHistory('astrology')).rejects.toBeInstanceOf(
      UnknownPersonaCourseError,
    )
  })

  it('still answers over a corrupt store', async () => {
    await writeFile(personaCoursesFile(), '{ not json')
    expect(await getPersonaCourseHistory('big5')).toEqual({ courseId: 'big5', takes: [] })
  })

  it('still answers when a course key holds something that is not a list', async () => {
    await writeFile(
      personaCoursesFile(),
      JSON.stringify({ version: 1, records: {}, history: { big5: 'mangled' } }),
    )
    expect(await getPersonaCourseHistory('big5')).toEqual({ courseId: 'big5', takes: [] })
  })
})

describe('getPersonaPortrait — composed from evidence, or nothing', () => {
  it('says NOTHING when nothing has been taken (no invented line)', async () => {
    const portrait = await getPersonaPortrait()
    expect(portrait.lines).toEqual([])
    expect(portrait.takenCount).toBe(0)
    expect(portrait.courseCount).toBe(COURSES.length)
    expect(portrait.nodeCount).toBe(0)
    expect(portrait.recentCount).toBe(0)
  })

  it('a REAL scored take produces lines, and every line names the course it came from', async () => {
    // Scored by the real instrument (submitPersonaCourse runs scoreCourse), not
    // by a hand-written result object.
    await submitPersonaCourse('big5', big5Decisive())
    await submitPersonaCourse('values', Array.from({ length: 20 }, (_, i) => (i % 5 === 0 ? 4 : 1)))

    const portrait = await getPersonaPortrait()
    expect(portrait.lines.length).toBeGreaterThan(0)
    expect(portrait.takenCount).toBe(2)
    for (const line of portrait.lines) {
      const course = COURSES.find((c) => c.id === line.courseId)
      expect(course, `line cites an unknown course: ${line.courseId}`).toBeTruthy()
      // Provenance: a line that cannot be traced back to its instrument is a
      // horoscope, whatever it says.
      expect(line.detail, `line has no instrument in its detail: ${line.detail}`).toContain(
        course?.name,
      )
      expect(line.text.length).toBeGreaterThan(0)
      expect(Date.parse(line.takenAt)).not.toBeNaN()
    }
    expect(new Set(portrait.lines.map((l) => l.courseId))).toEqual(new Set(['big5', 'values']))
  })

  it('counts the corpus through the PRODUCTION reader, and only the last 7 days as recent', async () => {
    await seedDatedJudgments([
      { text: '30日前の判断', daysAgo: 30 },
      { text: '8日前の判断', daysAgo: 8 },
      { text: '2日前の判断', daysAgo: 2 },
    ])
    // Five more, minted for real by the submit path — stamped "now".
    const { record } = await submitPersonaCourse('big5', big5Decisive())
    expect(record.result.findings).toHaveLength(5)

    // The count the portrait must agree with is whatever THIS reader returns.
    const judgments = await readManualJudgments()
    expect(judgments).toHaveLength(8)

    const now = Date.now()
    const portrait = await getPersonaPortrait({ now: () => now })
    expect(portrait.nodeCount).toBe(judgments.length)
    expect(portrait.recentCount).toBe(6) // the 2-day-old one + the 5 just minted

    // …and the numbers MOVE with the corpus rather than being a constant.
    await seedDatedJudgments([{ text: 'たった1件', daysAgo: 90 }])
    const second = await getPersonaPortrait({ now: () => now })
    expect(second.nodeCount).toBe(1)
    expect(second.recentCount).toBe(0)
  })

  it('an UNREADABLE corpus costs the two counts, not the whole portrait', async () => {
    await submitPersonaCourse('big5', big5Decisive())
    // A directory where the additions file should be: readFile throws EISDIR,
    // which the corpus reader deliberately does NOT swallow (an append must
    // never overwrite judgments it merely failed to see).
    await rm(youCorpusAdditionsFile(), { force: true })
    await mkdir(youCorpusAdditionsFile())
    await expect(readManualJudgments()).rejects.toThrow()

    const portrait = await getPersonaPortrait()
    expect(portrait.lines.length).toBeGreaterThan(0) // the courses half still speaks
    expect(portrait.nodeCount).toBe(0)
    expect(portrait.recentCount).toBe(0)
  })

  it('still answers over a corrupt store — with no lines, since nothing is legible', async () => {
    await writeFile(personaCoursesFile(), '{ not json')
    const portrait = await getPersonaPortrait()
    expect(portrait.lines).toEqual([])
    expect(portrait.takenCount).toBe(0)
  })

  it('ages every line from the injected clock, so a stale take reads as stale', async () => {
    const taken = Date.UTC(2026, 0, 1, 12)
    await submitPersonaCourse('big5', big5Decisive(), { now: () => taken })
    const portrait = await getPersonaPortrait({ now: () => taken + 30 * DAY_MS })
    expect(portrait.lines.length).toBeGreaterThan(0)
    for (const line of portrait.lines) expect(line.ageDays).toBe(30)
  })
})

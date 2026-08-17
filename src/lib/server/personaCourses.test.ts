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
import { assembleYouCorpus, readLiveJudgments, readManualJudgments } from './youCorpus'
import { recordDecision } from './personaLedger'
import { personaCoursesFile, youCorpusAdditionsFile, youCorpusFile } from './paths'
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
    // ⚠ AND THE BADGE, WHICH FOR THIS INSTRUMENT IS ABSENT. big5 scores a
    // profile, not a label, so the wire must carry null — the panel draws a chip
    // only when there is a real one, and a '' here would give it something to
    // draw. The 16-type course's real badge is asserted below.
    expect(big5?.badge).toBeNull()
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
      // The REGION tag rides along (regions.ts COURSE_REGION.big5 = 'head') so
      // the figure seats the finding from the NODE, tier 1, rather than
      // re-deriving the seat from the course tag on every read.
      // The TAKE stamp rides along too, and it is the exact one on the record —
      // pinned rather than pattern-matched, because a stamp that does not equal
      // this take's `takenAt` silently stops retiring the previous take.
      expect(hit?.tags).toEqual(['persona', 'big5', 'region:head', `take:${record.takenAt}`])
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

  it('the 16-type course puts its four letters on the LIST payload, not just the sheet', async () => {
    // The panel shows a taken course's result inline (owner, 2026-08-16:
    // 「NBTIだったら、ENTPとかあるじゃん」), and the list is what it reads. A badge
    // that exists only on the sheet is a badge the panel cannot draw.
    const { record } = await submitPersonaCourse(
      'type',
      Array.from({ length: 24 }, (_, i) => i % 2),
    )
    expect(record.result.badge).toMatch(/^[EI][SN][TF][JP]$/)
    const listed = await listPersonaCourses()
    expect(listed.courses.find((c) => c.id === 'type')?.badge).toBe(record.result.badge)
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

  // ─── A RETAKE REPLACES WHAT THE STAND-IN READS ────────────────────────────
  //
  // MEASURED BEFORE THE FIX (2026-08-16), through this same production path:
  // two opposite big5 takes left the corpus holding ALL TEN findings — every one
  // of the five factors present twice, in contradictory pairs, with nothing
  // saying which take was current. The record and the portrait had always
  // replaced cleanly; the corpus, the one file `claude` is actually handed,
  // accumulated. The owner's model was 「再度うけたら前の質問内容を上書きする感じ」
  // and it was true of everything except the part that matters.
  //
  // Read back out of the ASSEMBLED FILE, not out of the filter: what is being
  // claimed is about what the stand-in reads, and only the file can say that.
  it('a retake takes the OLD findings out of the corpus claude reads', async () => {
    const opposite = BIG5_ITEMS.map(([, reversed]) => (reversed ? 4 : 0))
    await submitPersonaCourse('big5', big5Decisive())
    const afterFirst = await readManualJudgments()
    expect(afterFirst.length).toBeGreaterThan(0)
    const firstTexts = afterFirst.map((j) => j.text)

    await submitPersonaCourse('big5', opposite)
    await assembleYouCorpus()
    const corpus = await readFile(youCorpusFile(), 'utf8')

    // Not one sentence from the first take survives in the file.
    for (const text of firstTexts) expect(corpus).not.toContain(text)
    // …and the second take's findings ARE in it (a filter that dropped
    // everything would satisfy the line above on its own).
    const live = await readLiveJudgments()
    expect(live.length).toBeGreaterThan(0)
    for (const j of live) expect(corpus).toContain(j.text)
    expect(live.map((j) => j.text).some((t) => firstTexts.includes(t))).toBe(false)
  })

  it('…and deletes NOTHING — the old findings are still on disk', async () => {
    const opposite = BIG5_ITEMS.map(([, reversed]) => (reversed ? 4 : 0))
    await submitPersonaCourse('big5', big5Decisive())
    const first = (await readManualJudgments()).map((j) => j.text)
    await submitPersonaCourse('big5', opposite)

    const onDisk = (await readManualJudgments()).map((j) => j.text)
    for (const text of first) expect(onDisk).toContain(text)
    // Append-only is the safety property; the reading rule sits on top of it.
    expect(onDisk.length).toBeGreaterThan((await readLiveJudgments()).length)
  })

  it('a retake of ONE course leaves another course’s findings speaking', async () => {
    await submitPersonaCourse('big5', big5Decisive())
    await submitPersonaCourse('type', Array.from({ length: COURSES[1].itemCount }, () => 0))
    const typeTexts = (await readManualJudgments())
      .filter((j) => j.tags?.includes('type'))
      .map((j) => j.text)
    expect(typeTexts.length).toBeGreaterThan(0)

    await submitPersonaCourse('big5', BIG5_ITEMS.map(([, r]) => (r ? 4 : 0)))
    const live = (await readLiveJudgments()).map((j) => j.text)
    for (const text of typeTexts) expect(live).toContain(text)
  })

  it('the portrait counts what the stand-in reads, not what is on disk', async () => {
    await submitPersonaCourse('big5', big5Decisive())
    const onceCount = (await getPersonaPortrait()).nodeCount
    await submitPersonaCourse('big5', BIG5_ITEMS.map(([, r]) => (r ? 4 : 0)))

    // Two takes, one take's worth of knowledge — 「わかっていること」 must not
    // double just because the same course was answered twice.
    const portrait = await getPersonaPortrait()
    expect(portrait.nodeCount).toBe(onceCount)
    expect((await readManualJudgments()).length).toBeGreaterThan(portrait.nodeCount ?? 0)
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

  it('an UNREADABLE corpus makes the two counts ABSENT — never 0', async () => {
    // ⚠ MUTATION GUARD. This used to answer `nodeCount: 0, recentCount: 0`,
    // which the screen printed as 「わかっていること 0」 — telling the owner their
    // record is empty at the one moment it could not be looked at. Absent and
    // zero are different claims and the wire has to keep them apart; the screen
    // renders the absence as "could not read" (PersonaModule.test.tsx).
    await submitPersonaCourse('big5', big5Decisive())
    // A directory where the additions file should be: readFile throws EISDIR,
    // which the corpus reader deliberately does NOT swallow (an append must
    // never overwrite judgments it merely failed to see).
    await rm(youCorpusAdditionsFile(), { force: true })
    await mkdir(youCorpusAdditionsFile())
    await expect(readManualJudgments()).rejects.toThrow()

    const portrait = await getPersonaPortrait()
    expect(portrait.lines.length).toBeGreaterThan(0) // the courses half still speaks
    expect(portrait.nodeCount).toBeUndefined()
    expect(portrait.recentCount).toBeUndefined()
    // …and the keys are genuinely ABSENT, not present-and-undefined: this
    // crosses a JSON boundary, where `{nodeCount: undefined}` and a missing key
    // are the same thing on the way out but not on the way in.
    expect('nodeCount' in portrait).toBe(false)
    expect('recentCount' in portrait).toBe(false)
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

// ─── The portrait's OTHER half: what the stand-in DID ────────────────────────
//
// The courses above are self-report. These pin the wiring that lets the portrait
// speak from the DECISION LEDGER instead — written through the production
// `recordDecision` and read back through the production `getPersonaPortrait`, so
// a wiring that called the ledger but ignored its numbers would fail here.
describe('getPersonaPortrait — the work line comes from the real ledger', () => {
  const decide = async (
    verdict: 'answered' | 'asked' | 'abstained',
    n: number,
    at?: string,
  ): Promise<void> => {
    for (let i = 0; i < n; i++) {
      await recordDecision({
        projectPath: '/tmp/proj',
        question: `質問 ${verdict} ${i}`,
        verdict,
        ...(at ? { at } : {}),
      })
    }
  }
  const workLine = (p: Awaited<ReturnType<typeof getPersonaPortrait>>) =>
    p.lines.find((l) => l.detail.startsWith('実際の判断'))

  it('says NOTHING about the work until the stand-in has actually decided something', async () => {
    await submitPersonaCourse('big5', big5Decisive())
    const portrait = await getPersonaPortrait()
    expect(portrait.lines.length).toBeGreaterThan(0) // the courses half still speaks
    expect(workLine(portrait)).toBeUndefined()
  })

  it('reports the REAL tallies, and never flatters a stand-in that mostly asks', async () => {
    await decide('answered', 1)
    await decide('asked', 5)
    await decide('abstained', 4)

    const portrait = await getPersonaPortrait()
    const line = workLine(portrait)
    expect(line, 'the work line is missing entirely').toBeTruthy()
    // The numbers are the ledger's, not a constant: 1/10 answered.
    expect(line?.detail).toBe('実際の判断 10件 ・ 代わりに答えた1 / 聞いた5 / 棄権4')
    // …and the WORDS match that ratio rather than being cheerful boilerplate.
    expect(line?.text).toContain('まだ多くをあなたに聞いている')

    // Move the ratio and the sentence must move with it.
    await decide('answered', 20)
    const after = workLine(await getPersonaPortrait())
    expect(after?.detail).toBe('実際の判断 30件 ・ 代わりに答えた21 / 聞いた5 / 棄権4')
    expect(after?.text).toContain('あなたを待たずに引き受けている')
  })

  it('counts the WHOLE ledger, not just this week — the portrait is not a weekly report', async () => {
    const now = Date.UTC(2026, 5, 1, 12)
    // Every decision is old enough to fall outside the 7-day window the SCREEN's
    // own block uses. A portrait keyed on `week` would report zero and draw no
    // line at all; the portrait is a statement about who the stand-in has become.
    await decide('answered', 3, new Date(now - 40 * DAY_MS).toISOString())
    await decide('asked', 1, new Date(now - 40 * DAY_MS).toISOString())

    const line = workLine(await getPersonaPortrait({ now: () => now }))
    expect(line?.detail).toBe('実際の判断 4件 ・ 代わりに答えた3 / 聞いた1 / 棄権0')
  })

  it('an UNREADABLE ledger costs the work line, not the whole portrait', async () => {
    await submitPersonaCourse('big5', big5Decisive())
    const portrait = await getPersonaPortrait({
      readDecisions: async () => {
        throw new Error('EIO')
      },
    })
    expect(portrait.lines.length).toBeGreaterThan(0)
    expect(workLine(portrait)).toBeUndefined()
    expect(portrait.nodeCount).toBeGreaterThan(0)
  })
})

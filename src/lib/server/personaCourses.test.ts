import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, readFile, writeFile, realpath, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  MAX_HISTORY,
  UnknownPersonaCourseError,
  listPersonaCourses,
  readPersonaCoursesStore,
  submitPersonaCourse,
} from './personaCourses'
import { readManualJudgments } from './youCorpus'
import { personaCoursesFile } from './paths'
import { PersonaScoringError } from '@/lib/persona/instruments'
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

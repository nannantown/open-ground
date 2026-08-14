// personaCourses.ts — the STORE + write path behind the Persona tab's courses.
//
// The instrument itself (items, scales, scoring) lives in
// src/lib/persona/instruments.ts and is PURE: no fs, no React, so every number
// on a result sheet is reproducible from that file alone. This module is the
// side-effecting half — it persists what the owner scored and mints each
// finding into the corpus — and deliberately holds none of the psychometrics.
//
// TWO RULES SHAPE EVERYTHING HERE:
//
//  1. THE RESULT IS PERSISTED BEFORE ANY CORPUS APPEND. A course is 20-25
//     deliberate answers; the corpus append is a slow, failure-prone neighbour
//     (fsync + a full you-corpus.md reassembly). If appends ran first, one
//     EACCES on the additions file would throw away work the owner cannot
//     reproduce without retaking the whole thing. So: score → persist → append,
//     and `minted` reports how many appends ACTUALLY landed rather than how
//     many findings existed. A half-minted result is a true, recoverable state
//     (retaking re-mints); a lost result is not.
//
//  2. ONE WRITER FOR THE CORPUS. Findings go through appendJudgment() — the
//     same production path POST /api/you-corpus/append uses — never a second
//     writer poking at you-corpus-additions.json. That file is the one
//     irreplaceable, accumulate-only source in the app; its single-flight
//     chain, its corrupt-file preservation and its reassembly all live in
//     youCorpus.ts, and a bypass would silently drop every one of them.
//
// RETAKING NEVER ERASES. `records[courseId]` is the LAST result (what the tab
// shows), and the record it displaced is pushed onto `history[courseId]`,
// capped at the newest MAX_HISTORY. A personality result the owner replaced is
// still theirs — and a drift between two takes is exactly the kind of material
// the interview loop is built to notice.
//
// PERSONAL DATA: ~/.openground/persona-courses.json, 0600, never inside a repo
// (same promise as the corpus itself). Paths come from paths.ts so this file
// inherits the test-home fence instead of resolving a home of its own.

import { readFile, rename } from 'fs/promises'
import { atomicWriteJson } from './atomicWrite'
import { ensureOpenGroundHome, personaCoursesFile } from './paths'
import { appendJudgment, readManualJudgments } from './youCorpus'
import { COURSES, courseById, scoreCourse } from '@/lib/persona/instruments'
import type { PersonaCourse } from '@/lib/persona/instruments'
import { composePortrait } from '@/lib/persona/portrait'
import type {
  ManualJudgment,
  PersonaCourseHistoryResponse,
  PersonaCourseId,
  PersonaCourseRecord,
  PersonaCoursesResponse,
  PersonaPortrait,
  SubmitPersonaCourseResponse,
} from '@/lib/types'

/** Personal data — owner-only, like the corpus it feeds. */
const FILE_MODE = 0o600

/** Retained prior results per course. Ten takes is far more than anyone runs of
 *  a 25-item self-report, so the cap only ever bounds a pathological loop. */
export const MAX_HISTORY = 10

/** ~/.openground/persona-courses.json.
 *
 *  `records` is keyed by course id and holds the LAST result — the shape the
 *  tab reads. `history` is the displaced-records archive for the same key, so
 *  the "last result" lookup stays a single hop while a retake still keeps what
 *  it replaced. Both are partial: an untaken course is simply absent. */
export interface PersonaCoursesStore {
  version: 1
  records: Partial<Record<PersonaCourseId, PersonaCourseRecord>>
  /** Oldest → newest, capped at MAX_HISTORY. Excludes `records[id]` (the
   *  current one), so nothing is stored twice. */
  history: Partial<Record<PersonaCourseId, PersonaCourseRecord[]>>
}

const emptyStore = (): PersonaCoursesStore => ({ version: 1, records: {}, history: {} })

/** The route maps this to 404. A typed error (not a string match) so a rename
 *  of the message cannot silently turn a 404 into a 500. */
export class UnknownPersonaCourseError extends Error {}

// "This path does not exist" — the ONLY read failure a writer may read as
// "legitimately empty" (same rule and reasoning as youCorpus.ts).
const isMissingFileError = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

const parseStore = (raw: string): PersonaCoursesStore | null => {
  const parsed: unknown = JSON.parse(raw)
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const obj = parsed as Partial<PersonaCoursesStore>
  const records = obj.records
  if (records != null && (typeof records !== 'object' || Array.isArray(records))) return null
  const history = obj.history
  if (history != null && (typeof history !== 'object' || Array.isArray(history))) return null
  return {
    version: 1,
    records: (records ?? {}) as PersonaCoursesStore['records'],
    history: (history ?? {}) as PersonaCoursesStore['history'],
  }
}

/** TOLERANT read — the one every READER uses (list, and the tab behind it).
 *
 *  A corrupt or unreadable store must never take the Persona tab down with it:
 *  the worst case here is "the tab offers the course again", which is the same
 *  thing it says on a fresh machine and costs the owner one retake. That is a
 *  very different trade from the corpus's additions file (where "empty" would
 *  silently delete the owner's judgments), which is why THIS reader shrugs and
 *  the write path's reader below does not. */
export const readPersonaCoursesStore = async (): Promise<PersonaCoursesStore> => {
  await ensureOpenGroundHome()
  let raw: string
  try {
    raw = await readFile(personaCoursesFile(), 'utf8')
  } catch (err) {
    if (!isMissingFileError(err)) {
      console.error('[openground:persona-courses] store unreadable — reporting "never taken"', err)
    }
    return emptyStore()
  }
  try {
    return parseStore(raw) ?? emptyStore()
  } catch {
    console.error('[openground:persona-courses] store corrupt — reporting "never taken"')
    return emptyStore()
  }
}

/** STRICT read, for the write path only. Differs from the reader above in the
 *  two places where shrugging would DESTROY data rather than merely under-report
 *  it (both lifted from youCorpus.ts, same reasoning):
 *   • a non-ENOENT read failure (EACCES on a root-owned file, EIO…) means the
 *     prior results ARE there and we simply cannot see them — writing a fresh
 *     one-record store over that erases every earlier take. Refuse instead.
 *   • a PARSE failure preserves the damaged file aside as `.corrupt-<ts>` before
 *     we continue from empty, so a hand-mangled file stays recoverable. */
const readStoreForWrite = async (): Promise<PersonaCoursesStore> => {
  const file = personaCoursesFile()
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (err) {
    if (!isMissingFileError(err)) throw err
    return emptyStore()
  }
  try {
    const parsed = parseStore(raw)
    if (!parsed) throw new Error('persona-courses store is not an object')
    return parsed
  } catch {
    // Best-effort preservation; if even the rename fails we still refuse to
    // clobber — the throw propagates and the submit reports a real failure.
    await rename(file, `${file}.corrupt-${Date.now()}`)
    return emptyStore()
  }
}

// Single-flight chain for every read-modify-write of the store. Two windows on
// one machine (the Electron app and a browser on :5174) are a supported setup,
// so two submits really can overlap; without this, one course's record silently
// overwrites the other's. On globalThis for the same reason as the terminal pool
// and the interview lock: a `tsx watch` reload must not hand the two module
// copies two different locks.
const lockGlobal = globalThis as typeof globalThis & {
  __openground_persona_courses_chain?: Promise<unknown>
}

const withStoreLock = <T>(fn: () => Promise<T>): Promise<T> => {
  const prev = lockGlobal.__openground_persona_courses_chain ?? Promise.resolve()
  const run = prev.then(fn, fn)
  lockGlobal.__openground_persona_courses_chain = run.catch(() => undefined)
  return run
}

/** The catalogue + what the owner has already scored. Absent ⇒ nulls, which is
 *  the honest "never taken" the tab renders as an invitation. */
export const listPersonaCourses = async (): Promise<PersonaCoursesResponse> => {
  const store = await readPersonaCoursesStore()
  return {
    courses: COURSES.map((c) => {
      const rec = store.records[c.id]
      return {
        id: c.id,
        name: c.name,
        sub: c.sub,
        zone: c.zone,
        itemCount: c.itemCount,
        source: c.source,
        lastTakenAt: rec?.takenAt ?? null,
        headline: rec?.result.headline ?? null,
      }
    }),
  }
}

/** Every stored take of ONE course, NEWEST FIRST.
 *
 *  The store keeps the two halves in the shape the tab's hot path wants —
 *  `records[id]` is the current take and `history[id]` runs oldest → newest — so
 *  the wire order is `[current, ...history reversed]`. The reversal happens HERE,
 *  once: "which end is new" has exactly one answer in this codebase, and a
 *  history rendered backwards is not a visibly broken screen (it is a plausible
 *  one that tells the owner their drift ran the other way).
 *
 *  Throws `UnknownPersonaCourseError` for an id no instrument answers to (route
 *  ⇒ 404). A course that exists but was never taken is `takes: []` — the same
 *  honest "never taken" the catalogue reports as nulls, not a 404. */
export const getPersonaCourseHistory = async (
  courseId: string,
): Promise<PersonaCourseHistoryResponse> => {
  const course = courseById(courseId)
  if (!course) throw new UnknownPersonaCourseError(`unknown persona course: ${courseId}`)
  const store = await readPersonaCoursesStore()
  const current = store.records[course.id]
  // parseStore only guarantees `history` is an object — a hand-mangled file can
  // still hold a non-array under a course key, and spreading that would turn a
  // corrupt file into a 500 on a read-only screen. Same fail-open trade as the
  // reader above: show what is legible.
  const displaced = store.history[course.id]
  const older = Array.isArray(displaced) ? [...displaced].reverse() : []
  return {
    courseId: course.id,
    takes: [...(current ? [current] : []), ...older],
  }
}

/** The window `recentCount` counts — "how much of this arrived lately". */
const PORTRAIT_RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

export interface PortraitDeps {
  /** DI for tests: the clock. Fixes both the 7-day window and every line's age. */
  now?: () => number
}

/** The "で、私はどういう人?" digest: scored courses + how much the stand-in holds.
 *
 *  This function JOINS and COUNTS; it never writes a line. Every sentence is
 *  composed by the pure `composePortrait`, which is the only place allowed to
 *  turn evidence into words — so an empty `lines` here means "nothing is
 *  evidenced yet", and the screen shows its own empty state rather than being
 *  handed a sentence nobody earned.
 *
 *  FAIL-OPEN, like the catalogue: the store reader already shrugs at a corrupt
 *  file, and the corpus reader deliberately does NOT (it throws on EACCES/EIO so
 *  an append can never overwrite judgments it merely failed to see —
 *  readManualJudgments' own note). That fail-CLOSED rule is right for the writer
 *  and wrong for a glance, so the throw is caught here and the counts fall back
 *  to what is legible: an unreadable corpus costs the owner two numbers, not the
 *  whole screen. */
export const getPersonaPortrait = async (deps: PortraitDeps = {}): Promise<PersonaPortrait> => {
  const now = deps.now?.() ?? Date.now()
  const store = await readPersonaCoursesStore()
  let judgments: ManualJudgment[] = []
  try {
    judgments = await readManualJudgments()
  } catch (err) {
    console.error('[openground:persona-courses] corpus unreadable — portrait counts 0 nodes', err)
  }
  let recentCount = 0
  for (const j of judgments) {
    const t = Date.parse(j.addedAt)
    // Unparseable stamps are simply not recent (never counted as "today"); a
    // stamp slightly in the future (clock skew) still reads as recent.
    if (Number.isFinite(t) && now - t <= PORTRAIT_RECENT_WINDOW_MS) recentCount++
  }
  return composePortrait({ records: store.records, nodeCount: judgments.length, recentCount, now })
}

/** Local 'YYYY-MM-DD' for the provenance line. Local, not
 *  `toISOString().slice(0,10)`: the date is shown to the owner under the node
 *  ("いつ測ったか"), and a UTC roll would date an evening-in-JST take to the
 *  previous day. Kept private rather than shared with personaInterview's twin —
 *  importing that module would drag the registry, board and escalation readers
 *  into this one for four lines of date formatting. */
const localDay = (ms: number): string => {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export interface SubmitCourseDeps {
  /** DI for tests: the corpus write-back (default appendJudgment — the SAME
   *  writer POST /api/you-corpus/append uses). */
  appendMemory?: typeof appendJudgment
  /** DI for tests: the clock. */
  now?: () => number
}

/** Score a completed course, persist it, then mint its findings into the corpus.
 *
 *  Throws `UnknownPersonaCourseError` for an id no instrument answers to (route
 *  ⇒ 404) and lets `PersonaScoringError` propagate for an answer vector that
 *  does not match the instrument (route ⇒ 400). Both fire BEFORE anything is
 *  written: a half-answered course must neither persist a result sheet that
 *  looks finished nor mint nodes into the corpus off invented numbers.
 *
 *  `minted` is the number of appends that SUCCEEDED, counted as they land. A
 *  failing append is logged and skipped, never rethrown — the result itself is
 *  already on disk by then, and reporting the real count is what lets the tab
 *  say something true ("4 of 5 reached your corpus") instead of claiming a
 *  clean run or losing the sheet. */
export const submitPersonaCourse = async (
  courseId: string,
  answers: number[],
  deps: SubmitCourseDeps = {},
): Promise<SubmitPersonaCourseResponse> => {
  const course: PersonaCourse | null = courseById(courseId)
  if (!course) throw new UnknownPersonaCourseError(`unknown persona course: ${courseId}`)

  // Throws PersonaScoringError on a wrong-length / out-of-range vector — before
  // any write, which is the whole point of validating in the pure layer.
  const result = scoreCourse(course, answers)
  const takenAtMs = deps.now?.() ?? Date.now()
  const record: PersonaCourseRecord = {
    result,
    takenAt: new Date(takenAtMs).toISOString(),
    // Copied, not aliased: the caller's array is request-scoped and this one is
    // about to be persisted and kept for a possible re-scoring.
    answers: [...answers],
  }

  // ── 1. persist (the irreplaceable half) ───────────────────────────────────
  await withStoreLock(async () => {
    await ensureOpenGroundHome()
    const store = await readStoreForWrite()
    const previous = store.records[course.id]
    if (previous) {
      const prior = store.history[course.id] ?? []
      // Newest last, then trimmed from the FRONT — the oldest take is the one
      // that falls off, not the one just replaced.
      store.history[course.id] = [...prior, previous].slice(-MAX_HISTORY)
    }
    store.records[course.id] = record
    await atomicWriteJson(personaCoursesFile(), store, { mode: FILE_MODE, fsync: true })
  })

  // ── 2. mint (best-effort, counted honestly) ───────────────────────────────
  const append = deps.appendMemory ?? appendJudgment
  const day = localDay(takenAtMs)
  let minted = 0
  for (const finding of result.findings) {
    try {
      await append({
        // The finding's own sentence is the judgment; the instrument + the
        // number it came from ride in `context`, which the corpus renders under
        // the node. A node whose provenance is unreadable is a node the owner
        // cannot argue with later.
        text: finding.text,
        tags: ['persona', course.id],
        context: `${finding.detail} ・ ${day}`,
      })
      minted++
    } catch (err) {
      // Deliberately swallowed: the result is already on disk, and failing the
      // whole submit here would make the tab offer a retake that re-mints every
      // finding that DID land. The count below is what tells the truth.
      console.warn(
        `[openground:persona-courses] finding not appended to the corpus (${course.id}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }

  return { record, minted }
}

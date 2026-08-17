// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, waitFor, screen, within, act } from '@testing-library/react'
import {
  IMPORT_POLL_GRACE,
  PersonaModule,
  courseRailState,
  parseTags,
  quoteForCorrection,
  unchangedRunningImport,
} from './PersonaModule'
import { RESOLVED_NOTICE_MS } from './PersonaConversation'
import { MAX_EXPORT_UPLOAD_BYTES, megabytes } from '@/lib/claudeExport'
import {
  COURSE_REGION,
  buildPersonaNodes,
  courseIdFromJudgment,
  personaHash,
  placeJudgment,
  regionForQuestion,
} from '@/lib/persona/regions'
import {
  BIG5_ITEMS,
  COURSES,
  LIKERT_AGREE,
  PERSONA_RESULT_CAVEAT,
  WORK_ITEMS,
  WORK_THEMES,
  courseById,
  scoreCourse,
} from '@/lib/persona/instruments'
import { portraitAgeLabel } from '@/lib/persona/portrait'
import { messages } from '@/i18n/messages'
import type {
  ManualJudgment,
  PersonaChatTurnResponse,
  PersonaCourseRecord,
  PersonaImportJobResponse,
  PersonaRegion,
  PersonaLedgerCounts,
  PersonaLedgerEntry,
  PersonaLedgerResponse,
  PersonaLedgerSummary,
  PersonaLedgerWhy,
  PersonaPortrait,
  PersonaPortraitLine,
  PersonaQuestion,
  YouCorpusStatus,
} from '@/lib/types'

// The Persona SCREEN — UI-side contract only: it reads the corpus status, the
// hand-written notes (drawn as the figure) and the course catalogue, and writes
// through POST /api/you-corpus/append, the interview routes, and
// POST /api/persona/courses/:id/submit. The server journey (assembly, scoring,
// the fail-safe, the loopback gate) is covered by youCorpus.test.ts /
// personaCourses.test.ts + the route tests; here the fetch layer is stubbed.
//
// NOTHING HERE ASSERTS ON PIXELS. The figure is a <canvas> (jsdom has no 2D
// context at all), so every lit point is ALSO a real button in an off-screen
// list — which is how a keyboard-only owner reaches it, and how these tests
// open a note. The geometry-free logic (which region a note belongs to, how a
// judgment becomes a node) is exported and tested as plain functions below.
//
// `useT` is stubbed to echo keys, so the assertions pin WHICH string a surface
// uses rather than its wording — the copy is owner-facing and gets reworded.

vi.mock('@/i18n/I18nContext', () => ({
  useT: () => ({
    lang: 'en',
    t: (k: string, v?: Record<string, unknown>) => (v ? `${k}:${JSON.stringify(v)}` : k),
  }),
}))

const status = (over: Partial<YouCorpusStatus> = {}): YouCorpusStatus => ({
  path: '/home/u/.openground/you-corpus.md',
  exists: true,
  sizeBytes: 4096,
  assembledAt: '2026-07-18T04:30:00.000Z',
  manualCount: 1,
  memoryDir: '/home/u/.claude/projects/x/memory',
  memoryDirExists: true,
  memoryCount: 62,
  conceptPath: '/repo/CONCEPT.md',
  conceptExists: true,
  businessVisionExists: true,
  ...over,
})

const judgment = (over: Partial<ManualJudgment> = {}): ManualJudgment => ({
  id: 'j-1',
  text: 'Price on value, never on cost.',
  addedAt: '2026-07-18T04:00:00.000Z',
  ...over,
})

const question = (over: Partial<PersonaQuestion> = {}): PersonaQuestion => ({
  id: 'q-1',
  date: '2026-07-19',
  kind: 'card-rework',
  subjectKey: 'card-rework:card-1:2',
  contextJa: 'Board のカードを、できあがりに納得がいかず差し戻したときの話です。',
  contextEn: 'About a card on your board that you sent back rather than accepting.',
  textJa: '「課金フロー」を2回やり直してもらいました — 何が足りなかったのですか?',
  textEn: 'You sent "billing flow" back 2 times — what kept being missing?',
  createdAt: '2026-07-19T03:00:00.000Z',
  status: 'open',
  ...over,
})

/** Every question kind the interview can produce (PersonaQuestionKind). Listed
 *  here rather than derived, so ADDING a kind makes these tests fail until its
 *  region is decided — the point of the list. */
const QUESTION_KINDS = [
  'decision-speed-contrast',
  'escalation-answer-rule',
  'escalation-dismissed',
  'escalation-long-open',
  'corpus-gap',
  'card-rework',
  'card-approved',
  'card-stale-blocked',
  'todo-passed-over',
] as const

/** The course catalogue as the server sends it — built FROM the instruments so
 *  a course renamed there is renamed here too. Any field can be overridden per
 *  course, which is how the tests tell "the rail read the API" apart from "the
 *  rail printed the local instrument list". */
const coursesPayload = (over: Partial<Record<string, Record<string, unknown>>> = {}) =>
  COURSES.map((c) => ({
    id: c.id,
    name: c.name,
    sub: c.sub,
    region: COURSE_REGION[c.id],
    itemCount: c.itemCount,
    source: c.source,
    lastTakenAt: null as string | null,
    headline: null as string | null,
    badge: null as string | null,
    ...(over[c.id] ?? {}),
  }))

let statusPayload: YouCorpusStatus
let judgmentsPayload: ManualJudgment[]
let retiredPayload: { judgment: ManualJudgment; retiredAt: string }[]
let rebuildSkipped: string | null
let rebuildFails: boolean
let checkPayload: { id: string; options: { id: string; text: string }[] } | null
let checkAnswerFails: boolean
let retireFails: boolean
let judgmentsFail: boolean
let appendSkipped: boolean
let appendFails: boolean
let statusFails: boolean
let posts: Array<Record<string, unknown>>
let questionPayload: PersonaQuestion | null
let questionFails: boolean
let resolveFails: boolean
let answerCorpusStale: boolean
/** One composed portrait line as the server sends it. Japanese, because the
 *  COMPOSER writes Japanese (src/lib/persona/portrait.ts) — the screen frames
 *  these lines, it does not write them. */
const portraitLine = (over: Partial<PersonaPortraitLine> = {}): PersonaPortraitLine => ({
  text: '正確さを、いちばん上に置く人。',
  detail: '価値観の順位 ・ 1位「正確さ」',
  courseId: 'values',
  takenAt: '2026-08-01T09:00:00.000Z',
  ageDays: 13,
  ...over,
})

const portraitOf = (over: Partial<PersonaPortrait> = {}): PersonaPortrait => ({
  lines: [portraitLine()],
  nodeCount: 41,
  takenCount: 2,
  courseCount: 4,
  ...over,
})

/** A stored take, scored by the REAL scorer so a headline is a headline the
 *  product can actually produce. */
const take = (id: string, answers: number[], takenAt: string): PersonaCourseRecord => ({
  result: scoreCourse(courseById(id)!, answers),
  takenAt,
  answers,
})

/** The day a strip entry prints, formatted the way any en-US surface would —
 *  NOT by importing the component's own formatter, which would agree with it by
 *  construction. */
const dayLabel = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

let courses: ReturnType<typeof coursesPayload>
let coursesFail: boolean
let submitFails: boolean
/** null ⇒ "every finding landed"; a number pins a partial mint. */
let mintedOverride: number | null
/** null ⇒ the portrait endpoint fails (which is also "not built yet"). */
let portraitPayload: PersonaPortrait | null
let historyPayload: PersonaCourseRecord[]
let historyFails: boolean
/** The decision ledger. `null` ⇒ the endpoint fails (an older server, a read
 *  that broke); anything else is served AS-IS with a 200 — which is how the
 *  "a 200 that is not a ledger" case below is written without a second knob. */
let ledgerPayload: unknown

// ── the conversation (2026-08-15) ───────────────────────────────────────────
// Talking is the main way into the corpus now, so the screen polls two job
// endpoints. Both are stubbed the way the real ones behave: POST answers 202
// with an id, and GET answers 'running' until the test says otherwise.
/** Served AS-IS by GET /api/persona/chat. `null` ⇒ the read FAILS, which is a
 *  different state from an empty thread and must render differently. */
let chatStatePayload: unknown
/** What GET /api/persona/chat/turn/:id answers. */
let chatTurnPayload: Partial<PersonaChatTurnResponse>
/** Non-null ⇒ POST /api/persona/chat rejects with this status + body. */
let chatStartRejection: { status: number; body: Record<string, unknown> } | null
let importJobPayload: Partial<PersonaImportJobResponse>
let importStartRejection: { status: number; body: Record<string, unknown> } | null
/** How many import-job polls 500 before the stub starts answering. The job is
 *  server-side; a dropped poll is NOT a failed import, and this knob is how the
 *  grace tests say "the network blinked N times". */
let importPollFailures: number
/** Import-job polls actually asked, so a test can wait for "N more ticks
 *  passed" instead of sleeping and hoping. */
let importPolls: number

/** One kept line as the server hands it back: the FULL stored judgment, so the
 *  chip is pressable with no round-trip. */
const keptWrite = (over: Partial<ManualJudgment> = {}, region: PersonaRegion = 'legs') => ({
  judgment: judgment({
    id: 'k-1',
    text: '決めたあとに手が止まる',
    context: 'This conversation ・ Aug 15',
    tags: ['chat', `region:${region}`],
    ...over,
  }),
  region,
})

const counts = (answered: number, asked: number, abstained: number): PersonaLedgerCounts => ({
  answered,
  asked,
  abstained,
})

const ledgerEntry = (over: Partial<PersonaLedgerEntry> = {}): PersonaLedgerEntry => ({
  id: 'l-1',
  at: '2026-08-12T09:00:00.000Z',
  // An absolute path under the owner's home, exactly as the store holds it —
  // the screen may only ever show the folder name out of it.
  projectPath: '/Users/me/dev/billing-api',
  verdict: 'answered',
  question: 'Ship the price change tonight?',
  ...over,
})

const ledgerOf = (
  summary: Partial<PersonaLedgerSummary> = {},
  recent: PersonaLedgerEntry[] = [],
): PersonaLedgerResponse => ({
  summary: { week: counts(0, 0, 0), total: counts(0, 0, 0), lastAt: null, ...summary },
  recent,
})

beforeEach(() => {
  // jsdom ships no 2D canvas context. The figure already handles that (it draws
  // nothing and everything else on the screen still works — which is why the
  // data lives outside it), so this only silences jsdom's not-implemented dump.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  statusPayload = status()
  judgmentsPayload = [judgment()]
  rebuildSkipped = null
  rebuildFails = false
  checkPayload = null
  checkAnswerFails = false
  retiredPayload = []
  retireFails = false
  judgmentsFail = false
  appendSkipped = false
  appendFails = false
  statusFails = false
  posts = []
  questionPayload = null
  questionFails = false
  resolveFails = false
  answerCorpusStale = false
  courses = coursesPayload()
  coursesFail = false
  submitFails = false
  mintedOverride = null
  // Default OFF for both new reads: the screen must survive a server that does
  // not serve them yet, and every test above this line was written before they
  // existed.
  portraitPayload = null
  historyPayload = []
  historyFails = false
  ledgerPayload = null
  // Default: the thread reads clean and is EMPTY. Every test written before the
  // conversation existed still gets a screen with no thread on it.
  chatStatePayload = { turns: [], live: false }
  chatTurnPayload = { state: 'running', elapsedMs: 0 }
  chatStartRejection = null
  importJobPayload = { state: 'running', elapsedMs: 0 }
  importStartRejection = null
  importPollFailures = 0
  importPolls = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      // ABOVE every other /api/persona/* branch: '/api/persona/chat' and
      // '/api/persona/import' must never be scored as a course answer vector.
      if (url.startsWith('/api/persona/chat/turn/')) {
        return new Response(JSON.stringify(chatTurnPayload), { status: 200 })
      }
      if (url === '/api/persona/chat') {
        if (init?.method === 'POST') {
          const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
          posts.push({ url, ...body })
          if (chatStartRejection)
            return new Response(JSON.stringify(chatStartRejection.body), {
              status: chatStartRejection.status,
            })
          return new Response(JSON.stringify({ turnId: 't-1' }), { status: 202 })
        }
        if (chatStatePayload === null) return new Response('{}', { status: 500 })
        return new Response(JSON.stringify(chatStatePayload), { status: 200 })
      }
      // The bytes route FIRST — '/api/persona/import/file' also matches the
      // job-poll prefix below, and scoring an upload as a poll would make every
      // import test silently green over a request that never happened.
      if (url === '/api/persona/import/file') {
        // What is recorded is the UPLOAD ITSELF: the body is the File, not JSON.
        const f = init?.body as File
        posts.push({
          url,
          uploadedName: f?.name,
          uploadedSize: f?.size,
          contentType: (init?.headers as Record<string, string>)?.['Content-Type'],
        })
        if (importStartRejection)
          return new Response(JSON.stringify(importStartRejection.body), {
            status: importStartRejection.status,
          })
        return new Response(JSON.stringify({ importId: 'i-1' }), { status: 202 })
      }
      if (url.startsWith('/api/persona/import/')) {
        importPolls += 1
        if (importPollFailures > 0) {
          importPollFailures -= 1
          return new Response('{}', { status: 500 })
        }
        return new Response(JSON.stringify(importJobPayload), { status: 200 })
      }
      // NOTE: every /api/you-corpus/* branch must sit ABOVE the bare
      // '/api/you-corpus' catch-all at the bottom — otherwise a new endpoint
      // silently receives a YouCorpusStatus payload instead of its own shape.
      if (url === '/api/you-corpus/interview/answer' || url === '/api/you-corpus/interview/skip') {
        if (resolveFails) return new Response('{}', { status: 500 })
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        posts.push({ url, ...body })
        const resolved = question({
          ...questionPayload,
          status: url.endsWith('/answer') ? 'answered' : 'skipped',
        })
        questionPayload = resolved
        return new Response(
          JSON.stringify({ question: resolved, ...(answerCorpusStale ? { corpusStale: true } : {}) }),
          { status: 200 },
        )
      }
      if (url === '/api/you-corpus/interview') {
        if (questionFails) return new Response('{}', { status: 500 })
        return new Response(
          JSON.stringify({
            question: questionPayload,
            ...(questionPayload ? {} : { reason: 'no-material' }),
          }),
          { status: 200 },
        )
      }
      if (url.startsWith('/api/you-corpus/judgments')) {
        if (judgmentsFail) return new Response('{}', { status: 500 })
        return new Response(
          JSON.stringify({ judgments: judgmentsPayload, retired: retiredPayload }),
          { status: 200 },
        )
      }
      // 「取り消す」/「戻す」. The FAKE MOVES THE LINE between the two arrays, so a
      // test asserts the screen after a real state change rather than after a
      // 200 that changed nothing.
      // 「どれが自分ではないか」 — the check, its answer and its dismissal.
      if (url === '/api/you-corpus/tell-apart') {
        posts.push({ url })
        return new Response(JSON.stringify({ check: checkPayload }), { status: 200 })
      }
      if (url === '/api/you-corpus/tell-apart/answer') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { optionId?: string }
        posts.push({ url, ...body })
        if (checkAnswerFails) return new Response('{}', { status: 500 })
        const correct = body.optionId === 'barnum:0'
        return new Response(
          JSON.stringify({
            correct,
            ...(correct ? {} : { mistookText: 'ぼくの言葉' }),
            strangerText: '誰にでも当てはまる文',
          }),
          { status: 200 },
        )
      }
      if (url === '/api/you-corpus/tell-apart/skip') {
        posts.push({ url })
        return new Response(JSON.stringify({ skipped: true }), { status: 200 })
      }
      if (url === '/api/you-corpus/rebuild') {
        posts.push({ url })
        if (rebuildFails) return new Response('{}', { status: 500 })
        return new Response(
          JSON.stringify(
            rebuildSkipped ? { skipped: true, warning: rebuildSkipped } : { assembledAt: 'now' },
          ),
          { status: 200 },
        )
      }
      if (url === '/api/you-corpus/retire' || url === '/api/you-corpus/restore') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { id?: string }
        posts.push({ url, ...body })
        if (retireFails) return new Response('{}', { status: 500 })
        if (url === '/api/you-corpus/retire') {
          const target = judgmentsPayload.find((j) => j.id === body.id)
          if (!target) return new Response('{}', { status: 404 })
          judgmentsPayload = judgmentsPayload.filter((j) => j.id !== body.id)
          retiredPayload = [
            { judgment: target, retiredAt: '2026-08-16T09:30:00.000Z' },
            ...retiredPayload,
          ]
        } else {
          const back = retiredPayload.find((r) => r.judgment.id === body.id)
          if (!back) return new Response('{}', { status: 404 })
          retiredPayload = retiredPayload.filter((r) => r.judgment.id !== body.id)
          judgmentsPayload = [back.judgment, ...judgmentsPayload]
        }
        return new Response(JSON.stringify({ meta: {} }), { status: 200 })
      }
      if (url === '/api/you-corpus/append') {
        if (appendFails) return new Response('{}', { status: 500 })
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        posts.push(body)
        const stored = judgment({
          id: `j-${judgmentsPayload.length + 1}`,
          text: String(body.text),
          ...(body.tags ? { tags: body.tags as string[] } : {}),
          ...(body.context ? { context: String(body.context) } : {}),
        })
        // The server appends, then the tab re-reads: newest first.
        judgmentsPayload = [stored, ...judgmentsPayload]
        return new Response(
          JSON.stringify({
            judgment: stored,
            meta: { manualCount: judgmentsPayload.length, ...(appendSkipped ? { skipped: true } : {}) },
          }),
          { status: 200 },
        )
      }
      if (url === '/api/persona/portrait') {
        if (!portraitPayload) return new Response('{}', { status: 500 })
        return new Response(JSON.stringify(portraitPayload), { status: 200 })
      }
      if (url.startsWith('/api/persona/ledger')) {
        if (ledgerPayload === null) return new Response('{}', { status: 500 })
        return new Response(JSON.stringify(ledgerPayload), { status: 200 })
      }
      // ABOVE the submit branch: `/api/persona/courses/big5/history` starts with
      // the same prefix, and being scored as an answer vector is not a failure
      // mode worth discovering in the product.
      if (url.startsWith('/api/persona/courses/') && url.endsWith('/history')) {
        if (historyFails) return new Response('{}', { status: 500 })
        return new Response(
          JSON.stringify({ courseId: url.split('/')[4], takes: historyPayload }),
          { status: 200 },
        )
      }
      if (url.startsWith('/api/persona/courses/')) {
        const id = url.split('/')[4]
        const body = JSON.parse(String(init?.body ?? '{}')) as { answers: number[] }
        posts.push({ url, ...body })
        if (submitFails) return new Response('{}', { status: 500 })
        // Scored with the REAL scorer, exactly like the route does: an answer
        // vector of the wrong length or with an out-of-range entry throws here
        // instead of quietly producing a sheet.
        const result = scoreCourse(courseById(id)!, body.answers)
        return new Response(
          JSON.stringify({
            record: { result, takenAt: '2026-08-14T02:00:00.000Z', answers: body.answers },
            minted: mintedOverride ?? result.findings.length,
          }),
          { status: 200 },
        )
      }
      if (url.startsWith('/api/persona/courses')) {
        if (coursesFail) return new Response('{}', { status: 500 })
        return new Response(JSON.stringify({ courses }), { status: 200 })
      }
      if (url.startsWith('/api/you-corpus')) {
        if (statusFails) return new Response('{}', { status: 500 })
        return new Response(JSON.stringify(statusPayload), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Open a lit point by its note text. The figure's off-screen list is the
 *  keyboard path to the same node the canvas click opens. */
const openNode = (text: string) => fireEvent.click(screen.getByRole('button', { name: text }))

/** Start a correction from an open note — the ONLY way the composer opens now
 *  (the add-note button went with the conversation, 2026-08-15). */
const startCorrecting = (noteText: string) => {
  openNode(noteText)
  fireEvent.click(screen.getByText('persona.correct.start'))
}

const typeNote = (text: string) => {
  const box = screen.getByPlaceholderText('persona.correct.placeholder')
  fireEvent.change(box, { target: { value: text } })
  return box
}

/** The conversation's input. Found by its STABLE accessible name — the
 *  placeholder rotates through 18 examples and cannot be queried on. */
const talkInput = () => screen.getByLabelText('persona.chat.inputLabel') as HTMLInputElement

const say = (text: string) => {
  fireEvent.change(talkInput(), { target: { value: text } })
  fireEvent.keyDown(talkInput(), { key: 'Enter' })
}

const rail = (name: string) => screen.getByRole('button', { name: new RegExp(name) })

/** A course row, found by the course's own name. ONE button per row now:
 *  never-taken starts it, 済 reads the last result back, and re-taking lives
 *  inside that sheet. */
const railRow = (name: string) => screen.getByText(name).closest('button') as HTMLButtonElement

/** ⚠ THE COURSES ARE BEHIND A CLICK. The rail carries one line — 「コース n/N」 —
 *  and pressing it raises the list in the reading column. Every course test
 *  enters through here, so the entrance is exercised by all of them rather
 *  than pinned once and assumed everywhere else.
 *
 *  The wait is on the COUNT LINE, not on a timer: it appears only once the
 *  catalogue read has landed (or failed), and clicking before that would open
 *  a panel that is empty for reasons having nothing to do with the test. */
const awaitCourses = async () => {
  fireEvent.click(await screen.findByRole('button', { name: /persona\.counts\.courses/ }))
  return screen.findByRole('region', { name: 'persona.course.railHeading' })
}

/** The counts corner. The whole block is absent when the portrait could not be
 *  read, which is why the tests query it as a named region. */
const countsBlock = () => screen.getByRole('region', { name: 'persona.counts.label' })

/** Raise 「分身が知っていること」 the way the owner does: press the count.
 *
 *  ⚠ THIS USED TO OPEN THE PORTRAIT — five composed lines and nothing else. The
 *  label promised an inventory and delivered a summary, which is precisely why
 *  the owner said the labels stopped meaning anything (2026-08-16). It opens the
 *  full list now, and the portrait is that list's header block, so every
 *  assertion about the portrait still holds — it is just no longer alone. */
const openPortrait = () =>
  fireEvent.click(
    within(countsBlock()).getByRole('button', { name: /^persona\.counts\.known/ }),
  )

/** Wait for the count button to actually exist, then press it. `countsBlock()`
 *  is not a sufficient wait — that block also renders for the COURSES line, so
 *  it can appear a tick before the portrait read lands. */
const openKnown = async () => {
  fireEvent.click(await screen.findByRole('button', { name: /^persona\.counts\.known/ }))
}

/** The known-list panel, once raised. Named for the portrait it contains so the
 *  older assertions read unchanged. */
const portraitBlock = () => screen.getByRole('region', { name: 'persona.counts.known' })

describe('PersonaModule — reading what the stand-in runs on', () => {
  // The meta strip is DETAIL, so it lives inside the portrait card rather than
  // standing on the stage (2026-08-15: 「文字は極力少なくしたい」). It is still
  // reachable in one press, and it still says the same two numbers.
  // ⚠ BEHIND A DISCLOSURE (owner: 「いらない情報は出さないように気をつけて」). What the
  // stand-in is built FROM is asked rarely and answered permanently, so it earns
  // a line rather than a panel — but the line has to be openable, and what it
  // opens has to be the real numbers.
  it('says how much is in there: what it remembered and what you wrote', async () => {
    portraitPayload = portraitOf()
    render(<PersonaModule />)
    await screen.findByText('persona.tabLabel')
    await openKnown()

    // Collapsed: the counts are NOT on screen.
    await waitFor(() => expect(screen.getByText(/persona\.material\.heading/)).toBeTruthy())
    expect(portraitBlock().textContent).not.toContain('persona.meta.count.other')

    fireEvent.click(screen.getByText(/persona\.material\.heading/))
    // The key carries the plural form: English says "1 note", not "1 notes".
    await waitFor(() =>
      expect(portraitBlock().textContent).toContain('persona.meta.count.other:{"count":62}'),
    )
    expect(portraitBlock().textContent).toContain('persona.meta.count.one:{"count":1}')
  })

  it('⚠ NAMES A SOURCE THAT DID NOT RESOLVE rather than leaving it out', async () => {
    // A list of only what landed reads as "this is everything" — and the absent
    // source is exactly what explains a stand-in that knows less than expected.
    portraitPayload = portraitOf()
    statusPayload = status({ conceptExists: false, businessVisionExists: false })
    render(<PersonaModule />)
    await openKnown()
    fireEvent.click(await screen.findByText(/persona\.material\.heading/))

    expect(screen.getByText('persona.material.concept')).toBeTruthy()
    expect(screen.getAllByText('persona.material.missing').length).toBeGreaterThan(1)
  })

  it('an unresolved memory dir is NOT the same as an empty one', async () => {
    // 0 is a measurement; "could not find the directory" is a failure to look.
    portraitPayload = portraitOf()
    statusPayload = status({ memoryDirExists: false, memoryCount: 0 })
    render(<PersonaModule />)
    await openKnown()
    fireEvent.click(await screen.findByText(/persona\.material\.heading/))

    const rows = screen.getByText('persona.meta.memory').closest('li') as HTMLElement
    expect(rows.textContent).toContain('persona.material.missing')
    expect(rows.textContent).not.toContain('count":0')
  })

  it('作り直す rebuilds, and says so', async () => {
    portraitPayload = portraitOf()
    render(<PersonaModule />)
    await openKnown()
    fireEvent.click(await screen.findByText(/persona\.material\.heading/))
    fireEvent.click(screen.getByText('persona.material.rebuild'))

    expect(await screen.findByText('persona.material.rebuilt')).toBeTruthy()
    expect(posts.some((p) => p.url === '/api/you-corpus/rebuild')).toBe(true)
  })

  // ⚠ THE ONE THAT MATTERS. The route answers 200 with `meta.skipped` when the
  // assembler REFUSED to overwrite a real corpus from sources that did not
  // resolve. Reporting that as done would tell the owner the file was rebuilt at
  // the exact moment it was not.
  it('a SKIPPED rebuild is not reported as a rebuild — and prints the reason', async () => {
    portraitPayload = portraitOf()
    rebuildSkipped = 'no mechanical source resolved; the corpus on disk was left alone'
    render(<PersonaModule />)
    await openKnown()
    fireEvent.click(await screen.findByText(/persona\.material\.heading/))
    fireEvent.click(screen.getByText('persona.material.rebuild'))

    expect(await screen.findByText('persona.material.rebuildFailed')).toBeTruthy()
    expect(screen.queryByText('persona.material.rebuilt')).toBeNull()
    // The server's own sentence, verbatim: it is the only thing that says WHY.
    expect(screen.getByText(/no mechanical source resolved/)).toBeTruthy()
  })

  it('says so plainly when the corpus has never been assembled', async () => {
    portraitPayload = portraitOf()
    statusPayload = status({ exists: false, assembledAt: null })
    render(<PersonaModule />)
    await openKnown()
    await waitFor(() => expect(portraitBlock().textContent).toContain('persona.meta.never'))
  })

  // ── the counts corner ─────────────────────────────────────────────────────

  it('prints the counts over a portrait it READ', async () => {
    portraitPayload = portraitOf({ nodeCount: 159, recentCount: 16, takenCount: 4, courseCount: 4 })
    render(<PersonaModule />)
    await waitFor(() => expect(countsBlock()).toBeTruthy())
    const text = countsBlock().textContent ?? ''
    expect(text).toContain('159')
    expect(text).toContain('16')
  })

  // MUTATION GUARD (R4 #2). `portrait?.nodeCount ?? 0` would print a 0 over a
  // read that never happened — a measurement nobody took. The whole block is
  // absent instead.
  it('does NOT show a count when the portrait could not be read', async () => {
    portraitPayload = null // ⇒ /api/persona/portrait 500s
    render(<PersonaModule />)
    await screen.findByText('persona.tabLabel')
    await waitFor(() => expect(screen.getByText('persona.intro.lead')).toBeTruthy())
    // ⚠ NOT "the block is absent" any more — the courses line sits in the same
    // block and is fed by a different read, so demanding an empty block would
    // be pinning the bug where one failed read blanks another's answer. What
    // must not exist is a NODE count nobody took.
    expect(screen.queryByText('persona.counts.known')).toBeNull()
    expect(screen.queryByText('persona.counts.week')).toBeNull()
  })

  // `recentCount` is optional on the wire: a server that did not count is not a
  // week in which nothing happened, so the line is absent rather than zero.
  it('drops the week line when the server did not count one', async () => {
    portraitPayload = portraitOf({ nodeCount: 7 })
    delete (portraitPayload as { recentCount?: number }).recentCount
    render(<PersonaModule />)
    await waitFor(() => expect(countsBlock()).toBeTruthy())
    expect(countsBlock().textContent).not.toContain('persona.counts.week')
  })

  // MUTATION GUARD. The portrait ITSELF was read — the courses half answered
  // fine — but the corpus behind `nodeCount` could not be. That is the state a
  // `?? 0` turns into 「わかっていること 0」 over a record that may be entirely
  // intact. It must read as "could not read", and the number must not appear.
  it('says COULD NOT READ, not 0, when the corpus behind the count was unreadable', async () => {
    portraitPayload = portraitOf({ takenCount: 2, courseCount: 4 })
    delete (portraitPayload as { nodeCount?: number }).nodeCount
    delete (portraitPayload as { recentCount?: number }).recentCount
    render(<PersonaModule />)
    await waitFor(() => expect(countsBlock()).toBeTruthy())
    const text = countsBlock().textContent ?? ''
    // The line is still there — the owner is told the state, not left guessing.
    expect(text).toContain('persona.counts.known')
    expect(text).toContain('persona.counts.unread')
    // …and no zero anywhere near it.
    expect(text).not.toMatch(/persona\.counts\.known\s*0/)
    expect(text).not.toContain('persona.counts.week')
    // The course tally is a different read and still speaks (it comes from the
    // catalogue, not from this portrait — see the courses describe).
    expect(text).toContain('persona.counts.courses')
  })

  it('opens one note with its provenance, tags and what it is based on', async () => {
    judgmentsPayload = [
      judgment({
        id: 'j-9',
        text: 'Ship before it is pretty.',
        // `region:arms` is the EXPLICIT seat a writer leaves (regions.ts tier
        // 1) — the tier the course minter, the chat distiller and the import
        // all write. A note that carries one names its region on screen.
        tags: ['shipping', 'region:arms'],
        context: 'Learned the hard way.',
      }),
    ]
    render(<PersonaModule />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Ship before it is pretty.' })).toBeTruthy())

    openNode('Ship before it is pretty.')
    expect(screen.getByText('shipping')).toBeTruthy()
    expect(screen.getByText('Learned the hard way.')).toBeTruthy()
    expect(screen.getByText('persona.notes.basis')).toBeTruthy()
    // The region it sits in is named, not left as a dot on a body.
    expect(screen.getByText(/^persona\.region\.arms ・ /)).toBeTruthy()
    // ⚠ …AND THE MACHINE TAG THAT ENCODES IT IS NOT PRINTED BESIDE IT. `region:
    // arms` is our bookkeeping; as a chip it reads as if the owner had filed his
    // own sentence under it, and it says in our punctuation exactly what the
    // line above just said in words. Scoped to the card: the same string is a
    // legitimate part of other surfaces' keys.
    const card = screen.getByText('persona.correct.start').closest('article') as HTMLElement
    expect(card.textContent).toContain('shipping')
    expect(card.textContent).not.toContain('region:arms')
    // The raw ISO string is never shown to the owner.
    expect(screen.queryByText('2026-07-18T04:00:00.000Z')).toBeNull()

    fireEvent.click(screen.getByText('persona.node.close'))
    expect(screen.queryByText('persona.notes.basis')).toBeNull()
  })

  // ── 元の言葉 (plan step 6) ───────────────────────────────────────────────
  it('shows the words a line was distilled FROM, so the reading can be checked', async () => {
    judgmentsPayload = [
      judgment({
        id: 'j-src',
        text: '説明が要る画面は、画面のほうが悪い',
        tags: ['chat', 'region:head'],
        source: '正直、あの画面は説明されないと分からなかった。ああいうのは画面のほうが悪いと思う。',
      }),
    ]
    render(<PersonaModule />)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '説明が要る画面は、画面のほうが悪い' })).toBeTruthy(),
    )
    openNode('説明が要る画面は、画面のほうが悪い')

    expect(screen.getByText('persona.source.heading')).toBeTruthy()
    expect(screen.getByText(/正直、あの画面は説明されないと分からなかった/)).toBeTruthy()
    expect(screen.queryByText('persona.source.missing')).toBeNull()
  })

  it('⚠ SAYS SO when the original wording was never kept — never a blank quote', async () => {
    // Everything written before this field existed. An empty box under 「元の言葉」
    // reads as "he said nothing", which is a claim about him.
    judgmentsPayload = [judgment({ id: 'j-old', text: '古い行', tags: ['chat'] })]
    render(<PersonaModule />)
    await waitFor(() => expect(screen.getByRole('button', { name: '古い行' })).toBeTruthy())
    openNode('古い行')

    expect(screen.getByText('persona.source.missing')).toBeTruthy()
  })

  // MUTATION GUARD (R1 #2). ~159 notes on the owner's machine predate regions
  // entirely: they carry no course tag, no interview kind and no `region:` tag,
  // so the seating rule SPREADS them across the body rather than reading them.
  // They still light a point — density is honest — but the line under the
  // owner's own sentence must not name a region nobody chose. Flipping tier 4
  // to `placed: true` reds this test and nothing else on the screen.
  it('does NOT claim a region for a note it merely spread', async () => {
    judgmentsPayload = [
      judgment({ id: 'j-old', text: 'Written long before regions existed.', tags: [] }),
    ]
    render(<PersonaModule />)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Written long before regions existed.' })).toBeTruthy(),
    )

    openNode('Written long before regions existed.')
    // The provenance line under the note: it says the seat is undecided…
    const provenance = screen.getByText(/^persona\.region\.unplaced ・ /)
    const note = provenance.closest('article')
    expect(note).toBeTruthy()
    // …and names NONE of the five regions anywhere in the opened note.
    for (const region of ['head', 'chest', 'arms', 'legs', 'people']) {
      expect(note?.textContent).not.toContain(`persona.region.${region}`)
    }
  })

  // ── the region probe, from the module's side ─────────────────────────────
  // PersonaFigure.test.tsx pins how the probe RENDERS a summary; these pin the
  // summary the module composes, which is where the counting happens (the
  // figure holds no corpus and must never appear to have counted one).

  const openRegion = (region: string) =>
    fireEvent.click(
      within(screen.getByRole('list', { name: 'persona.figure.regionList' })).getByRole('button', {
        name: new RegExp(`persona\\.region\\.${region}`),
      }),
    )

  it('counts what it READ apart from what it merely spread', async () => {
    // 40 notes with no tags at all — the shape of the ~159 that predate regions.
    // They are seated on the body by hash and are NOT readings, so the probe
    // must report them under their own line and never inside 分かっていること.
    const spread = Array.from({ length: 40 }, (_, i) =>
      judgment({ id: `old-${i}`, text: `Old note ${i}`, tags: [] }),
    )
    const spreadInLegs = spread.filter((j) => placeJudgment(j).region === 'legs').length
    expect(spreadInLegs, 'the fixture actually spreads notes into legs').toBeGreaterThan(0)
    judgmentsPayload = [
      ...spread,
      judgment({ id: 'read-1', text: 'Nights are when it moves.', tags: ['region:legs'] }),
    ]
    render(<PersonaModule />)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Nights are when it moves.' })).toBeTruthy(),
    )

    openRegion('legs')
    const probe = screen.getByRole('status')
    expect(probe.textContent).toContain('persona.figure.regionKnown:{"count":1}')
    expect(probe.textContent).toContain(
      `persona.figure.regionUnplaced:{"count":${spreadInLegs}}`,
    )
    // The one thing it DID read is quoted, with where it came from.
    expect(probe.textContent).toContain('Nights are when it moves.')
    // And the sum is never printed — that number would claim 1 + N readings.
    expect(probe.textContent).not.toContain(`"count":${spreadInLegs + 1}`)
  })

  it('says a region is EMPTY only when it read one', async () => {
    // The halo is reachable only from evidence (regions.ts): nothing spreads
    // there, so with a corpus of untagged notes it is genuinely empty — and
    // "empty" is a measurement, printed as such.
    judgmentsPayload = [judgment({ id: 'j-a', text: 'Something.', tags: [] })]
    render(<PersonaModule />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Something.' })).toBeTruthy())

    openRegion('people')
    const probe = screen.getByRole('status')
    expect(probe.textContent).toContain('persona.region.none')
    expect(probe.textContent).not.toContain('persona.figure.regionKnown')
    expect(probe.textContent).not.toContain('persona.region.unreadable')
  })

  it('does NOT report a count for a region it could not read', async () => {
    // Same law as the portrait and the ledger: a failed read says so, and says
    // nothing else. A 0 here is a measurement nobody took.
    statusFails = true
    render(<PersonaModule />)
    await screen.findByText('persona.loadFailed')

    openRegion('head')
    const probe = screen.getByRole('status')
    expect(probe.textContent).toContain('persona.region.unreadable')
    expect(probe.textContent).not.toMatch(/\d/)
  })

  // ⚠ THIS TEST USED TO ASSERT THE OPPOSITE. It pinned a footnote in the rail
  // teaching the pan/zoom gestures, and a variant of it during a probe. The
  // owner cut both (2026-08-16: 「操作の仕方の説明はいりません。スクロールとかの」),
  // so the pin is inverted: the stage carries no operating instructions, in
  // either state. Kept rather than deleted because "explain the gesture in a
  // corner" is the reflex this screen keeps having, and a deletion leaves
  // nothing behind to notice it coming back.
  it('teaches no gestures — not at rest, and not while a region is up', async () => {
    judgmentsPayload = [judgment({ text: 'Something.' })]
    render(<PersonaModule />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Something.' })).toBeTruthy())
    expect(screen.queryByText('persona.figure.hint')).toBeNull()

    openRegion('chest')
    expect(screen.queryByText('persona.figure.hint')).toBeNull()
    expect(screen.queryByText('persona.figure.probeHint')).toBeNull()
  })

  it('invites the first note when nothing is lit yet', async () => {
    judgmentsPayload = []
    render(<PersonaModule />)
    expect(await screen.findByText('persona.figure.empty')).toBeTruthy()
    expect(screen.getByText('persona.intro.title')).toBeTruthy()
  })

  it('offers a retry when the read fails instead of an endless spinner', async () => {
    statusFails = true
    render(<PersonaModule />)
    expect(await screen.findByText('persona.loadFailed')).toBeTruthy()

    statusFails = false
    fireEvent.click(screen.getByText('persona.retry'))
    await waitFor(() => expect(screen.queryByText('persona.loadFailed')).toBeNull())
    expect(screen.getByRole('button', { name: 'Price on value, never on cost.' })).toBeTruthy()
  })

  // "Nothing is lit yet" is a CLAIM about the corpus, and a failed read is not
  // in a position to make it. An empty figure over a failed read says "you have
  // told me nothing" — the wrong lie to tell on the one surface whose entire job
  // is to be an honest mirror.
  it('does NOT claim the figure is empty when it simply could not be read', async () => {
    statusFails = true
    judgmentsPayload = []
    render(<PersonaModule />)

    expect(await screen.findByText('persona.loadFailed')).toBeTruthy()
    expect(screen.queryByText('persona.figure.empty')).toBeNull()
    expect(screen.queryByText('persona.intro.title')).toBeNull()

    // And once the read succeeds, the invitation is correct and comes back.
    statusFails = false
    fireEvent.click(screen.getByText('persona.retry'))
    expect(await screen.findByText('persona.figure.empty')).toBeTruthy()
  })

  // MUTATION GUARD. The retry above checks the two ENDS — failed, then read.
  // The bug lived in the MIDDLE: `load()` cleared `loadError` at the START of
  // the attempt, and by then `loading` is false and `judgments` is still empty
  // from the failure, so for the whole duration of the retry the stage printed
  // 「まだ何も光っていません」 over a corpus that may be perfectly intact. That is
  // the forbidden sentence — "you have said nothing" — from a source nobody has
  // read yet. The state is only allowed to change when a read LANDS.
  it('does not flash "nothing is lit" while the retry is still in flight', async () => {
    statusFails = true
    judgmentsPayload = []
    render(<PersonaModule />)
    expect(await screen.findByText('persona.loadFailed')).toBeTruthy()

    // Hold the corpus reads open so the in-flight window is observable at all.
    const real = global.fetch as unknown as (u: string, i?: RequestInit) => Promise<Response>
    let release: (() => void) | undefined
    const opened = new Promise<void>((r) => {
      release = r
    })
    statusFails = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).startsWith('/api/you-corpus')) await opened
        return real(String(url), init)
      }),
    )

    fireEvent.click(screen.getByText('persona.retry'))

    // MID-FLIGHT: the last KNOWN state is "could not read", and it is still what
    // the screen says. Nothing claims the figure is empty.
    await waitFor(() => expect(screen.getByText('persona.loading')).toBeTruthy())
    expect(screen.getByText('persona.loadFailed')).toBeTruthy()
    expect(screen.queryByText('persona.figure.empty')).toBeNull()
    expect(screen.queryByText('persona.intro.title')).toBeNull()

    // …and once it lands, the invitation is a fact and appears.
    release?.()
    expect(await screen.findByText('persona.figure.empty')).toBeTruthy()
    expect(screen.queryByText('persona.loadFailed')).toBeNull()
  })

  // A failed REFRESH is different from a failed first read: notes already on
  // screen were read successfully once, so they stay lit. Only the "it is empty"
  // claim is withheld.
  it('keeps already-lit notes when a later refresh fails', async () => {
    judgmentsPayload = [judgment({ text: 'Loaded before the failure.' })]
    render(<PersonaModule />)
    await screen.findByRole('button', { name: 'Loaded before the failure.' })

    // The append lands; the re-read that follows it does not.
    statusFails = true
    startCorrecting('Loaded before the failure.')
    typeNote('A new note.')
    fireEvent.click(screen.getByText('persona.correct.submit'))

    expect(await screen.findByText('persona.loadFailed')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Loaded before the failure.' })).toBeTruthy()
  })
})

// THE ADD-NOTE BUTTON IS GONE (2026-08-15). Talking is how things go in, so the
// composer only ever opens over an existing line — but the WRITE underneath is
// the same POST /api/you-corpus/append it always was, so these tests moved onto
// the correction path rather than being deleted.
describe('PersonaModule — writing into it', () => {
  it('offers no add-note button at all — the way in is the conversation', async () => {
    render(<PersonaModule />)
    await screen.findByText('persona.tabLabel')
    expect(screen.queryByText('persona.add.open')).toBeNull()
    expect(screen.queryByText('persona.add.heading')).toBeNull()
    // …and the conversation's input is there instead.
    expect(talkInput()).toBeTruthy()
  })

  it('will not submit an empty or whitespace-only correction', async () => {
    judgmentsPayload = [judgment({ id: 'j-old', text: 'Old call.' })]
    render(<PersonaModule />)
    await screen.findByRole('button', { name: 'Old call.' })
    startCorrecting('Old call.')

    const submit = screen.getByText('persona.correct.submit').closest('button')!
    expect(submit.disabled).toBe(true)

    typeNote('   ')
    expect(submit.disabled).toBe(true)

    typeNote('real content')
    expect(submit.disabled).toBe(false)
  })

  it('posts the correction with its tags and lights it on the figure', async () => {
    judgmentsPayload = [judgment({ id: 'j-old', text: 'Old call.' })]
    render(<PersonaModule />)
    await screen.findByRole('button', { name: 'Old call.' })
    startCorrecting('Old call.')

    typeNote('Say no to features that need a manual.')
    fireEvent.change(screen.getByPlaceholderText('persona.add.tagsPlaceholder'), {
      target: { value: 'product, scope' },
    })
    fireEvent.click(screen.getByText('persona.correct.submit'))

    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].text).toBe('Say no to features that need a manual.')
    expect(posts[0].tags).toEqual(['product', 'scope'])
    expect(posts[0].correctsId).toBe('j-old')

    // It is on the body now, not in a list somewhere.
    expect(
      await screen.findByRole('button', { name: 'Say no to features that need a manual.' }),
    ).toBeTruthy()
    // The composer closes and empties, so the next one starts clean.
    expect(screen.queryByPlaceholderText('persona.correct.placeholder')).toBeNull()
    startCorrecting('Old call.')
    expect(
      (screen.getByPlaceholderText('persona.correct.placeholder') as HTMLTextAreaElement).value,
    ).toBe('')
  })

  it('omits tags entirely when none were typed', async () => {
    judgmentsPayload = [judgment({ id: 'j-old', text: 'Old call.' })]
    render(<PersonaModule />)
    await screen.findByRole('button', { name: 'Old call.' })
    startCorrecting('Old call.')
    typeNote('No tags here.')
    fireEvent.click(screen.getByText('persona.correct.submit'))

    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].tags).toBeUndefined()
  })

  it('surfaces a write failure rather than pretending it saved', async () => {
    appendFails = true
    judgmentsPayload = [judgment({ id: 'j-old', text: 'Old call.' })]
    render(<PersonaModule />)
    await screen.findByRole('button', { name: 'Old call.' })
    startCorrecting('Old call.')

    typeNote('This will not land.')
    fireEvent.click(screen.getByText('persona.correct.submit'))

    expect(await screen.findByText('persona.add.failed')).toBeTruthy()
    // The text is KEPT so the owner does not lose what they wrote.
    expect(
      (screen.getByPlaceholderText('persona.correct.placeholder') as HTMLTextAreaElement).value,
    ).toBe('This will not land.')
  })

  it('warns when the note landed but the corpus could not be rebuilt', async () => {
    appendSkipped = true
    judgmentsPayload = [judgment({ id: 'j-old', text: 'Old call.' })]
    render(<PersonaModule />)
    await screen.findByRole('button', { name: 'Old call.' })
    startCorrecting('Old call.')

    typeNote('Landed, but sources were unreadable.')
    fireEvent.click(screen.getByText('persona.correct.submit'))

    expect(await screen.findByText('persona.meta.stale')).toBeTruthy()
  })

  // The IME contract: a bare Enter must reach the composition (it CONFIRMS a
  // Japanese conversion), so only the modified chord submits.
  it('submits on Cmd/Ctrl+Enter but never on a bare Enter', async () => {
    judgmentsPayload = [judgment({ id: 'j-old', text: 'Old call.' })]
    render(<PersonaModule />)
    await screen.findByRole('button', { name: 'Old call.' })
    startCorrecting('Old call.')
    const box = typeNote('IME safe?')

    fireEvent.keyDown(box, { key: 'Enter' })
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true })
    expect(posts).toHaveLength(0)

    fireEvent.keyDown(box, { key: 'Enter', metaKey: true })
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].text).toBe('IME safe?')
  })
})

// ─── TALKING IS THE WAY IN ──────────────────────────────────────────────────
//
// PersonaConversation.test.tsx pins what the conversation RENDERS; these pin
// the WIRING the module owns — which route a message goes to, that a turn is
// polled as a job rather than held on one connection, and that what came back
// is read back through the corpus rather than taken on faith.
describe('PersonaModule — talking to it', () => {
  it('posts what the owner said, then shows the reply and lights what was kept', async () => {
    chatTurnPayload = {
      state: 'done',
      elapsedMs: 21_000,
      reply: 'どのあたりが重いですか。',
      kept: [keptWrite()],
    }
    render(<PersonaModule />)
    await screen.findByText('persona.tabLabel')

    say('仕事で手が止まる')
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]).toEqual({ url: '/api/persona/chat', text: '仕事で手が止まる' })
    // The owner's words are on screen BEFORE anything comes back.
    expect(screen.getByText('仕事で手が止まる')).toBeTruthy()

    // …and the turn is polled as a job, not held on the POST.
    expect(await screen.findByText('どのあたりが重いですか。', undefined, { timeout: 4000 })).toBeTruthy()
    expect(
      screen.getByRole('button', { name: /決めたあとに手が止まる/ }),
    ).toBeTruthy()
  })

  it('re-reads the corpus when a turn lands, so the figure is never a version behind', async () => {
    chatTurnPayload = { state: 'done', elapsedMs: 1, reply: 'ふむ。', kept: [keptWrite()] }
    render(<PersonaModule />)
    await screen.findByText('persona.tabLabel')

    // The server has ALREADY written it; the screen must go and read it rather
    // than drawing what it hoped happened.
    judgmentsPayload = [judgment({ id: 'k-1', text: '決めたあとに手が止まる' }), ...judgmentsPayload]
    say('仕事で手が止まる')

    // The figure's own list is where a lit point is reachable — two buttons now
    // carry that text: the kept chip and the node.
    await waitFor(
      () =>
        expect(screen.getAllByRole('button', { name: /決めたあとに手が止まる/ }).length).toBe(2),
      { timeout: 4000 },
    )
  })

  it('a second message while one is running is refused, and the words survive', async () => {
    chatStartRejection = { status: 409, body: { error: 'busy', busy: true } }
    render(<PersonaModule />)
    await screen.findByText('persona.tabLabel')

    say('二通目')
    expect(await screen.findByText('persona.chat.busy')).toBeTruthy()
    expect(screen.getByText('二通目')).toBeTruthy()
    expect(screen.getByText('persona.chat.retry')).toBeTruthy()
  })

  // SUBSCRIPTION-ONLY: the server preflights the owner's own `claude` and
  // answers 503 before anything spawns. The screen has to name which of the two
  // it was, because the fixes are different.
  it('says which way the CLI is unavailable, and never spends a turn on it', async () => {
    chatStartRejection = { status: 503, body: { claudeLoggedOut: true } }
    render(<PersonaModule />)
    await screen.findByText('persona.tabLabel')

    say('話しかける')
    expect(await screen.findByText('persona.chat.claudeLoggedOut')).toBeTruthy()
    expect(screen.getByText('話しかける')).toBeTruthy()
  })

  it('a thread that could not be READ is never drawn as an empty one', async () => {
    chatStatePayload = null // ⇒ GET /api/persona/chat 500s
    render(<PersonaModule />)
    expect(await screen.findByText('persona.chat.stateUnreadable')).toBeTruthy()
  })

  // Same 200-with-a-bare-object that took the portrait and the ledger down.
  it('a 200 that is NOT a thread is treated as unread, not as empty', async () => {
    chatStatePayload = {}
    render(<PersonaModule />)
    expect(await screen.findByText('persona.chat.stateUnreadable')).toBeTruthy()
  })

  // A TURN OUTLIVES THIS SCREEN. The run is a job, not the POST's connection,
  // so closing the panel mid-turn leaves a `claude` going — and a reopened
  // panel that does not re-attach the poll sits at 「送っています」 forever over
  // a turn that finished minutes ago.
  it('picks a turn that was still running back up when the panel reopens', async () => {
    chatStatePayload = {
      turns: [
        {
          id: 't-live',
          askedAt: '2026-08-15T01:00:00.000Z',
          text: 'まだ返事待ち',
          state: 'running',
        },
      ],
      live: true,
    }
    chatTurnPayload = {
      state: 'done',
      elapsedMs: 30_000,
      reply: '待たせました。',
      kept: [keptWrite()],
    }
    render(<PersonaModule />)
    expect(await screen.findByText('まだ返事待ち')).toBeTruthy()

    // …and it lands without the owner having to do anything.
    expect(await screen.findByText('待たせました。', undefined, { timeout: 4000 })).toBeTruthy()
  })

  it('does NOT poll a thread the server says has nothing in flight', async () => {
    chatStatePayload = {
      turns: [
        {
          id: 't-stale',
          askedAt: '2026-08-15T01:00:00.000Z',
          text: '取り残された行',
          state: 'running',
        },
      ],
      live: false,
    }
    render(<PersonaModule />)
    await screen.findByText('取り残された行')
    await new Promise((r) => setTimeout(r, 900))
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
    expect(calls.filter((c) => String(c[0]).includes('/api/persona/chat/turn/'))).toHaveLength(0)
  })

  it('re-opening the panel does not lose the conversation', async () => {
    chatStatePayload = {
      turns: [
        {
          id: 't-old',
          askedAt: '2026-08-15T01:00:00.000Z',
          text: '前に話したこと',
          state: 'done',
          reply: 'おぼえています。',
          kept: [],
        },
      ],
      live: false,
    }
    render(<PersonaModule />)
    expect(await screen.findByText('前に話したこと')).toBeTruthy()
    expect(screen.getByText('おぼえています。')).toBeTruthy()
  })
})

describe('PersonaModule — taking in a claude.ai export', () => {
  const drop = (name: string, body: string) => {
    const file = new File([body], name, { type: 'application/json' })
    fireEvent.drop(talkInput(), { dataTransfer: { files: [file] } })
    return file
  }

  it('UPLOADS THE FILE ITSELF — it parses nothing on this thread', async () => {
    importJobPayload = {
      state: 'done',
      elapsedMs: 900,
      result: {
        conversations: 2,
        ownerMessages: 5,
        unreadable: 1,
        droppedNonOwner: 4,
        considered: 5,
        notConsidered: 0,
        kept: [keptWrite()],
        duplicatesSkipped: 0,
        keptUnreadable: 0,
      },
    }
    render(<PersonaModule />)
    await screen.findByText('persona.tabLabel')

    drop('conversations.json', '[{"name":"a"}]')
    await waitFor(() => expect(posts).toHaveLength(1))
    // ⚠ THE WHOLE POINT OF THE ROUTE. The owner's real export is 23 MB zipped /
    // 98 MB raw; the old path read, hashed, decoded, parsed and re-serialised it
    // on the thread that draws the screen. Now the File goes up as bytes and
    // Node does all of it — including the digest, which is then a fact about
    // what ARRIVED rather than a number the client claims it computed.
    expect(posts[0].url).toBe('/api/persona/import/file')
    expect(posts[0].contentType).toBe('application/octet-stream')
    expect(posts[0].uploadedName).toBe('conversations.json')
    expect(posts[0].json).toBeUndefined()
    expect(posts[0].fileSha).toBeUndefined()

    // The read-count sentence carries its own denominator (5 of 5); the ZERO
    // notConsidered line is silence, per the receipt's zero-gate.
    expect(
      await screen.findByText('persona.import.considered:{"total":5,"count":5}', undefined, {
        timeout: 4000,
      }),
    ).toBeTruthy()
    expect(screen.queryByText(/persona\.import\.notConsidered/)).toBeNull()
  })

  // ⚠ THE ZIP IS THE NORMAL CASE (2026-08-15). claude.ai hands the export over
  // AS a zip. The app used to refuse it and tell the owner to open the archive
  // and pull conversations.json out themselves — homework, at the one moment it
  // is asking for their history. The server sniffs content, so nothing here is
  // decided by file name.
  it('UPLOADS a zip like any other file — it is what claude.ai actually gives you', async () => {
    render(<PersonaModule />)
    await screen.findByText('persona.tabLabel')

    drop('data-2026-08-15.zip', 'PK-binary-bytes')
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].url).toBe('/api/persona/import/file')
    expect(posts[0].uploadedName).toBe('data-2026-08-15.zip')
    expect(screen.queryByText('persona.import.zipUnsupported')).toBeNull()
  })

  // MUTATION GUARD. Everything the drop handler does runs on the thread that
  // draws the screen and holds several live copies of the file at once (buffer →
  // hash → decoded string → parsed object → request body). A years-deep export
  // is hundreds of MB, and dropping one froze the window with no message and no
  // way back. The check has to happen BEFORE the first read — after it there is
  // nothing left to check with.
  it('refuses an export too big to open, before reading a single byte', async () => {
    render(<PersonaModule />)
    await screen.findByText('persona.tabLabel')

    // A real 65MB string would make this test itself the thing that hangs, so
    // the size is stubbed — the production check reads `file.size`, which is
    // exactly what a browser reports without touching the contents.
    const huge = new File(['[]'], 'conversations.json', { type: 'application/json' })
    Object.defineProperty(huge, 'size', { value: MAX_EXPORT_UPLOAD_BYTES + 1 })
    let read = false
    huge.arrayBuffer = () => {
      read = true
      return Promise.resolve(new ArrayBuffer(0))
    }
    fireEvent.drop(talkInput(), { dataTransfer: { files: [huge] } })

    expect(
      await screen.findByText(
        `persona.import.tooLarge:{"size":${megabytes(MAX_EXPORT_UPLOAD_BYTES + 1)},"max":${megabytes(MAX_EXPORT_UPLOAD_BYTES)}}`,
      ),
    ).toBeTruthy()
    // The observable claim, not "a function was called": nothing was read and
    // nothing was posted.
    expect(read).toBe(false)
    expect(posts).toHaveLength(0)
  })

  it('a file one byte under the cap is opened normally', async () => {
    // The other side of the boundary — a cap that refuses everything would pass
    // the test above and break the feature.
    importJobPayload = {
      state: 'done',
      elapsedMs: 10,
      result: {
        conversations: 1,
        ownerMessages: 1,
        unreadable: 0,
        droppedNonOwner: 0,
        considered: 1,
        notConsidered: 0,
        kept: [],
        duplicatesSkipped: 0,
        keptUnreadable: 0,
      },
    }
    render(<PersonaModule />)
    await screen.findByText('persona.tabLabel')

    const ok = new File(['[{"name":"a"}]'], 'conversations.json', { type: 'application/json' })
    Object.defineProperty(ok, 'size', { value: MAX_EXPORT_UPLOAD_BYTES })
    fireEvent.drop(talkInput(), { dataTransfer: { files: [ok] } })

    await waitFor(() => expect(posts).toHaveLength(1))
    expect(screen.queryByText(/persona\.import\.tooLarge/)).toBeNull()
  })

  it('a file that is not an export at all reports NO COUNTS, only the failure', async () => {
    // The judgement moved to the server with the parsing, so the upload DOES
    // happen now and the refusal comes back as a 400. What must not change is
    // the part that matters: a partial count over a file nobody could read is
    // the exact failure mode this screen exists to avoid, so nothing is
    // reported at all.
    importStartRejection = { status: 400, body: { unreadableFile: true } }
    render(<PersonaModule />)
    await screen.findByText('persona.tabLabel')

    drop('conversations.json', 'this is not json')
    expect(await screen.findByText('persona.import.unreadableFile')).toBeTruthy()
    expect(screen.queryByText(/persona\.import\.parsed/)).toBeNull()
    expect(screen.queryByText(/persona\.import\.notConsidered/)).toBeNull()
  })

  it('the same export twice is refused with the day it landed', async () => {
    importStartRejection = {
      status: 409,
      body: { alreadyImported: true, at: '2026-08-12T09:00:00.000Z' },
    }
    render(<PersonaModule />)
    await screen.findByText('persona.tabLabel')

    drop('conversations.json', '[]')
    expect(
      await screen.findByText(
        `persona.import.already:{"date":"${dayLabel('2026-08-12T09:00:00.000Z')}"}`,
      ),
    ).toBeTruthy()
  })
})

describe('PersonaModule — correcting is appending', () => {
  it('writes a NEW note carrying the old one, and never deletes the original', async () => {
    judgmentsPayload = [judgment({ id: 'j-old', text: 'Always ship on Friday.' })]
    render(<PersonaModule />)
    await screen.findByRole('button', { name: 'Always ship on Friday.' })

    openNode('Always ship on Friday.')
    fireEvent.click(screen.getByText('persona.correct.start'))
    // The composer opens in correction mode and quotes what is being corrected.
    expect(screen.getByText('persona.correct.heading')).toBeTruthy()

    fireEvent.change(screen.getByPlaceholderText('persona.correct.placeholder'), {
      target: { value: 'Never ship on Friday.' },
    })
    fireEvent.click(screen.getByText('persona.correct.submit'))

    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].text).toBe('Never ship on Friday.')
    // The correction points at the note it supersedes…
    expect(String(posts[0].context)).toContain('Always ship on Friday.')
    expect(String(posts[0].context)).toContain('persona.correct.contextPrefix')
    // …by id as well as by quote. The quote is what a reader understands, but
    // it is capped at 280 chars and two notes can read alike — the id is the
    // part that stays exact.
    expect(posts[0].correctsId).toBe('j-old')

    // …and the original is still lit. Nothing is destroyed — the request was an
    // append, never a delete or an edit.
    expect(await screen.findByRole('button', { name: 'Never ship on Friday.' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Always ship on Friday.' })).toBeTruthy()
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
    const methods = calls.map((c) => (c[1] as RequestInit | undefined)?.method ?? 'GET')
    expect(methods).not.toContain('DELETE')
    expect(methods).not.toContain('PUT')
    expect(methods).not.toContain('PATCH')
  })

  // One slot under a note holds two different things, and the label has to say
  // which: a correction carries the note it REPLACES, a plain note carries where
  // it came from. Calling a superseded note "where this came from" reads as if
  // the owner had cited it approvingly — the opposite of what happened.
  it('labels a correction’s pointer as a replacement, not as a source', async () => {
    judgmentsPayload = [
      judgment({ id: 'j-fix', text: 'The corrected version.', context: 'the old wording', correctsId: 'j-old' }),
      judgment({ id: 'j-cited', text: 'A note that cites its origin.', context: 'from a call last week' }),
    ]
    render(<PersonaModule />)
    await screen.findByRole('button', { name: 'The corrected version.' })

    openNode('The corrected version.')
    expect(screen.getByText('persona.notes.corrects')).toBeTruthy()
    fireEvent.click(screen.getByText('persona.node.close'))

    openNode('A note that cites its origin.')
    expect(screen.getByText('persona.notes.basis')).toBeTruthy()
  })

  it('carries the corrected note’s tags forward as the starting point', async () => {
    judgmentsPayload = [judgment({ id: 'j-old', text: 'Old call.', tags: ['pricing', 'risk'] })]
    render(<PersonaModule />)
    await screen.findByRole('button', { name: 'Old call.' })

    openNode('Old call.')
    fireEvent.click(screen.getByText('persona.correct.start'))
    expect((screen.getByPlaceholderText('persona.add.tagsPlaceholder') as HTMLInputElement).value).toBe(
      'pricing, risk',
    )
  })

  // Losing typed words is the one thing this surface must never do. A React
  // value reset is not undoable, so a draft cleared by an unrelated click is
  // gone for good.
  it('KEEPS an in-progress note when the owner starts correcting something else', async () => {
    judgmentsPayload = [
      judgment({ id: 'j-a', text: 'First call.' }),
      judgment({ id: 'j-b', text: 'Second call.' }),
    ]
    render(<PersonaModule />)
    await screen.findByRole('button', { name: 'First call.' })

    startCorrecting('First call.')
    typeNote('half-written thought I am not done with')
    // …and now they change their mind about WHICH note they are correcting.
    startCorrecting('Second call.')

    expect(
      (screen.getByPlaceholderText('persona.correct.placeholder') as HTMLTextAreaElement).value,
    ).toBe('half-written thought I am not done with')
  })

  it('does not overwrite tags the owner is already typing', async () => {
    judgmentsPayload = [
      judgment({ id: 'j-a', text: 'First call.' }),
      judgment({ id: 'j-b', text: 'Second call.', tags: ['pricing'] }),
    ]
    render(<PersonaModule />)
    await screen.findByRole('button', { name: 'First call.' })

    startCorrecting('First call.')
    fireEvent.change(screen.getByPlaceholderText('persona.add.tagsPlaceholder'), {
      target: { value: 'mine' },
    })
    startCorrecting('Second call.')

    expect((screen.getByPlaceholderText('persona.add.tagsPlaceholder') as HTMLInputElement).value).toBe(
      'mine',
    )
  })

  it('cancelling drops the correction, not the words', async () => {
    judgmentsPayload = [
      judgment({ id: 'j-a', text: 'Old call.' }),
      judgment({ id: 'j-b', text: 'Another one.' }),
    ]
    render(<PersonaModule />)
    await screen.findByRole('button', { name: 'Old call.' })

    startCorrecting('Old call.')
    fireEvent.change(screen.getByPlaceholderText('persona.correct.placeholder'), {
      target: { value: 'words worth keeping' },
    })
    fireEvent.click(screen.getByText('persona.correct.cancel'))

    // Re-opening on ANOTHER note still carries the words: cancelling dropped
    // the correction, not what the owner had written.
    startCorrecting('Another one.')
    expect(
      (screen.getByPlaceholderText('persona.correct.placeholder') as HTMLTextAreaElement).value,
    ).toBe('words worth keeping')
  })

  it('cancelling really drops the correction — the next write points elsewhere', async () => {
    judgmentsPayload = [
      judgment({ id: 'j-old', text: 'The note being corrected.' }),
      judgment({ id: 'j-other', text: 'A different note.' }),
    ]
    render(<PersonaModule />)
    await screen.findByRole('button', { name: 'The note being corrected.' })

    startCorrecting('The note being corrected.')
    expect(screen.getByText('persona.correct.heading')).toBeTruthy()
    fireEvent.click(screen.getByText('persona.correct.cancel'))

    // The real contract: the next write points at the note it was actually
    // opened on, never at the one the owner decided NOT to correct.
    startCorrecting('A different note.')
    typeNote('An unrelated new thought.')
    fireEvent.click(screen.getByText('persona.correct.submit'))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].correctsId).toBe('j-other')
    expect(String(posts[0].context)).not.toContain('The note being corrected.')
  })
})

// Owner, 2026-08-16: 「質問に答えたら質問や返答は消えるようにできてるね? ずっと残って
// てもいみないからね」 and, on the courses panel, 「これじゃどのコースを受けたか、コース
// を受けられるのかなど全然わからないね」.
describe('what a finished exchange leaves behind, and what a course row says', () => {
  it('the ANSWER goes with the receipt — the whole exchange clears together', async () => {
    vi.useFakeTimers()
    try {
      questionPayload = question()
      render(<PersonaModule />)
      await vi.waitFor(() => expect(screen.getByText(question().textEn)).toBeInTheDocument())
      say('もう要りません')

      // The owner's words are on screen the whole time the save is in flight —
      // that invariant is older than this change and must survive it.
      await vi.waitFor(() => expect(screen.getByText('もう要りません')).toBeInTheDocument())

      await act(async () => {
        await vi.advanceTimersByTimeAsync(RESOLVED_NOTICE_MS + 200)
      })
      // ⚠ An interview answer is a form submission, not a conversation. Its
      // record is the corpus line and the lit point — neither of which is this
      // bubble, so parking it above the box for the rest of the day says
      // nothing the screen does not already say better.
      expect(screen.queryByText('もう要りません')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a FAILED answer keeps the words forever — they are the one thing not to lose', async () => {
    vi.useFakeTimers()
    try {
      questionPayload = question()
      resolveFails = true
      render(<PersonaModule />)
      await vi.waitFor(() => expect(screen.getByText(question().textEn)).toBeInTheDocument())
      say('消えたら困る言葉')
      await vi.waitFor(() => expect(screen.getByText('消えたら困る言葉')).toBeInTheDocument())

      await act(async () => {
        await vi.advanceTimersByTimeAsync(RESOLVED_NOTICE_MS * 3)
      })
      expect(screen.getByText('消えたら困る言葉')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  // ⚠ THE VERB IS THE ACCESSIBLE NAME, NOT DRAWN TEXT. The owner cut the drawn
  // verbs (「テキストで表現をしなくてよくて…UIとして」) in favour of the row's own
  // shape — a chevron and a ✓. A chevron is silent to a screen reader, so the
  // sentence has to survive somewhere, and `aria-label` is that somewhere.
  // Asserted through getByRole, which reads exactly what assistive tech reads.
  it('every row still TELLS a screen reader what pressing it does', async () => {
    courses = coursesPayload({ big5: { lastTakenAt: '2026-08-01T09:00:00.000Z' } })
    render(<PersonaModule />)
    await awaitCourses()

    expect(
      screen.getByRole('button', { name: `${COURSES[0].name} — persona.course.action.result` }),
    ).toBeTruthy()
    expect(
      screen.getByRole('button', { name: `${COURSES[1].name} — persona.course.action.take` }),
    ).toBeTruthy()
  })

  it('…and does NOT draw those verbs — the row shape carries it', async () => {
    // The regression this stops is the obvious one: someone re-adds the label
    // "to be clearer" and the four rows are paragraphs again.
    courses = coursesPayload({ big5: { lastTakenAt: '2026-08-01T09:00:00.000Z' } })
    render(<PersonaModule />)
    const panel = await awaitCourses()
    expect(panel.textContent).not.toContain('persona.course.action.take')
    expect(panel.textContent).not.toContain('persona.course.action.result')
  })

  it('a taken course SHOWS WHAT IT FOUND — its badge and its own sentence', async () => {
    // Owner, 2026-08-16: 「NBTIだったら、ENTPとかあるじゃん。そういうの。それの軽い
    // 説明一文ぐらいとタイトルと一文ぐらいあってもいい」. The headline was already
    // on the wire and drawn nowhere; the badge was on the sheet only.
    courses = coursesPayload({
      type: {
        lastTakenAt: '2026-08-01T09:00:00.000Z',
        badge: 'ENTP',
        headline: 'あなたのタイプは ENTP。外向、直観、思考、柔軟。',
      },
    })
    render(<PersonaModule />)
    const panel = await awaitCourses()
    expect(within(panel).getByTestId('course-badge').textContent).toBe('ENTP')
    expect(
      within(panel).getByText('あなたのタイプは ENTP。外向、直観、思考、柔軟。'),
    ).toBeTruthy()
  })

  it('a course with NO badge shows none — never an invented one', async () => {
    // ⚠ Only the 16-type instrument produces a label. The other three produce a
    // profile, and a badge synthesised for them would be a made-up summary of a
    // real measurement — the one thing this whole surface refuses to do.
    courses = coursesPayload({
      big5: {
        lastTakenAt: '2026-08-01T09:00:00.000Z',
        headline: '5つのうち、いちばんはっきり出たのは「開放性」。',
      },
    })
    render(<PersonaModule />)
    const panel = await awaitCourses()
    expect(within(panel).getByText('5つのうち、いちばんはっきり出たのは「開放性」。')).toBeTruthy()
    // ⚠ NO CHIP AT ALL — not an empty one, not a dash. A first version of this
    // test only checked the headline and the tick, and stayed green against a
    // build that drew a '—' placeholder for every badge-less course.
    expect(within(panel).queryAllByTestId('course-badge')).toHaveLength(0)
    // The row is still marked taken, by the tick — the badge's absence is not
    // allowed to make it look untaken.
    expect(panel.querySelectorAll('svg.lucide-check').length).toBe(1)
  })

  it('an UNTAKEN course shows no result line at all — only what it costs', async () => {
    render(<PersonaModule />)
    const panel = await awaitCourses()
    expect(panel.textContent).toContain('persona.course.state.new')
    expect(panel.querySelectorAll('svg.lucide-check').length).toBe(0)
  })

  it('a taken course is marked WITHOUT a sentence saying so', async () => {
    courses = coursesPayload({ big5: { lastTakenAt: '2026-08-01T09:00:00.000Z' } })
    render(<PersonaModule />)
    const panel = await awaitCourses()
    // The ✓ is the mark; the date is the detail. Neither is the word "taken".
    expect(panel.querySelectorAll('svg.lucide-check').length).toBe(1)
    expect(panel.textContent).toContain('persona.course.state.done')
  })
})

// Owner, 2026-08-16: 「わかっていることとかクリックしたら、今まで答えたものがカテゴリー
// 分けされて一覧でみれたり」. The label promised an inventory and opened a five-line
// summary; now it opens the list, with that summary as the list's header.
describe('「分身が知っていること」 — the corpus, read back', () => {
  const corpus = (): ManualJudgment[] => [
    judgment({ id: 'j-chat', text: '値段より、直せることを見る', tags: ['chat', 'region:head'] }),
    judgment({ id: 'j-int', text: '保留のままなのは要らないと決めきれないから', tags: ['interview', 'card-stale-blocked'] }),
    judgment({ id: 'j-imp', text: '人に渡すより自分で一度通したい', tags: ['import', 'region:arms'] }),
    judgment({ id: 'j-crs', text: '新しい考え方や表現に向かう', tags: ['persona', 'big5', 'region:head'] }),
    judgment({ id: 'j-fix', text: '朝ではなく夜のほうが速い', tags: ['chat'], correctsId: 'j-chat' }),
    judgment({ id: 'j-none', text: '出どころの記録がない行' }),
  ]
  const panel = () => screen.getByRole('region', { name: 'persona.counts.known' })

  // The file's default is `portraitPayload = null`, i.e. the portrait read 500s
  // — and the count that opens this screen only renders over a portrait that
  // was READ. These tests are about the list, so give them a portrait.
  beforeEach(() => {
    portraitPayload = portraitOf()
  })

  it('groups every line by where it came from, in a fixed order', async () => {
    judgmentsPayload = corpus()
    render(<PersonaModule />)
    await openKnown()

    const card = await screen.findByRole('region', { name: 'persona.counts.known' })
    const headings = Array.from(card.querySelectorAll('.label-cap'))
      .map((el) => el.textContent)
      .filter((x): x is string => !!x?.startsWith('persona.known.group.'))
    expect(headings).toEqual([
      'persona.known.group.interview',
      'persona.known.group.chat',
      'persona.known.group.import',
      'persona.known.group.course',
      'persona.known.group.corrected',
      'persona.known.group.unrecorded',
    ])
    // Every line is on screen — this list's whole job is that nothing is hidden.
    for (const j of corpus()) expect(within(panel()).getByText(j.text)).toBeTruthy()
  })

  it('⚠ the header count is counted from the ROWS, never from the portrait', async () => {
    // The portrait's nodeCount comes from a different server-side read. If the
    // two ever drift, a number here would be labelling a list it does not
    // describe — so it is counted from the array being rendered.
    judgmentsPayload = corpus()
    portraitPayload = portraitOf({ nodeCount: 999 })
    render(<PersonaModule />)
    await openKnown()

    const header = (await screen.findByRole('region', { name: 'persona.counts.known' }))
      .firstElementChild as HTMLElement
    expect(header.textContent).toContain(String(corpus().length))
    expect(header.textContent).not.toContain('999')
  })

  it('(a) THE READ FAILED — says so, and prints no count at all', async () => {
    // ⚠ Not a 0, and not the portrait's number either. One read landing does not
    // license the other's figures, and a number here would describe a list
    // nobody could open.
    judgmentsFail = true
    render(<PersonaModule />)
    await openKnown()

    expect(await screen.findByText('persona.known.loadFailed')).toBeTruthy()
    expect(panel().textContent).not.toMatch(/\d/)
    expect(screen.queryByText('persona.known.empty')).toBeNull()
  })

  it('(b) READ FINE, NOTHING IN IT — a different sentence entirely', async () => {
    judgmentsPayload = []
    render(<PersonaModule />)
    await openKnown()

    expect(await screen.findByText('persona.known.empty')).toBeTruthy()
    expect(screen.queryByText('persona.known.loadFailed')).toBeNull()
  })

  it('(c) A GROUP WITH NOTHING IN IT is absent — never a zero row', async () => {
    judgmentsPayload = [judgment({ id: 'only', text: 'ひとつだけ', tags: ['chat'] })]
    render(<PersonaModule />)
    await openKnown()

    await waitFor(() => expect(within(panel()).getByText('ひとつだけ')).toBeTruthy())
    // A present group appears twice — as its filter chip and as its section
    // heading — so this counts occurrences rather than asserting a single node.
    expect(within(panel()).queryAllByText('persona.known.group.chat').length).toBeGreaterThan(0)
    // …and an empty group appears NOWHERE: no chip, no heading, no zero row.
    expect(within(panel()).queryAllByText('persona.known.group.import')).toHaveLength(0)
    expect(within(panel()).queryAllByText('persona.known.group.interview')).toHaveLength(0)
  })

  it('(d) THE FILTER MATCHED NOTHING — a fact about the filter, not about him', async () => {
    judgmentsPayload = corpus()
    render(<PersonaModule />)
    await openKnown()
    await waitFor(() => expect(within(panel()).getByText('値段より、直せることを見る')).toBeTruthy())

    fireEvent.change(screen.getByLabelText('persona.known.filterLabel'), {
      target: { value: 'そんな言葉はない' },
    })
    expect(screen.getByText('persona.known.noMatch')).toBeTruthy()
    // ⚠ NOT the empty-corpus sentence. That one is a claim about him.
    expect(screen.queryByText('persona.known.empty')).toBeNull()
  })

  it('filters on his own words, and the chips keep their FULL counts', async () => {
    judgmentsPayload = corpus()
    render(<PersonaModule />)
    await openKnown()
    await waitFor(() => expect(within(panel()).getByText('値段より、直せることを見る')).toBeTruthy())

    const chip = within(panel()).getByRole('button', { name: /persona\.known\.group\.chat/ })
    expect(chip.textContent).toContain('1')

    fireEvent.change(screen.getByLabelText('persona.known.filterLabel'), {
      target: { value: '値段' },
    })
    expect(within(panel()).getByText('値段より、直せることを見る')).toBeTruthy()
    expect(within(panel()).queryByText('人に渡すより自分で一度通したい')).toBeNull()
    // ⚠ The chip still says how many are in that group in TOTAL — narrowing must
    // never hide how much was narrowed away.
    expect(
      within(panel()).getByRole('button', { name: /persona\.known\.group\.chat/ }).textContent,
    ).toContain('1')
  })

  // ── A SCREEN, NOT A CARD (owner: 「情報が多いものはモーダルじゃなくてちゃんとした
  // スクリーン作るのもあり」/「いらない情報は出さないように気をつけて」) ────────────────
  it('takes the whole stage: the rail and the console step off, the body stays', async () => {
    judgmentsPayload = corpus()
    render(<PersonaModule />)
    await openKnown()
    await waitFor(() => expect(within(panel()).getByText('値段より、直せることを見る')).toBeTruthy())

    // ⚠ CLASS-LEVEL, AND DELIBERATELY SO. jsdom loads no stylesheet, so
    // `toBeVisible()` returns true for a `display:none` element — asserting it
    // would be the kind of green that measures nothing. The class IS the
    // mechanism here; that it reads as hidden in pixels is checked on the
    // running app.
    expect(screen.getByText('persona.intro.lead').closest('aside')?.className).toContain('hidden')
    expect(screen.getByTestId('persona-console').className).toContain('hidden')
    // …and the figure is STILL THERE beside the list. That pairing is the whole
    // reason this is a pane and not a page of its own.
    expect(screen.getByRole('list', { name: 'persona.figure.nodeList' })).toBeTruthy()
  })

  it('gives the rail and the console back when the screen is left', async () => {
    judgmentsPayload = corpus()
    render(<PersonaModule />)
    await openKnown()
    await waitFor(() => expect(within(panel()).getByText('値段より、直せることを見る')).toBeTruthy())
    fireEvent.click(within(panel()).getByRole('button', { name: /persona\.known\.back/ }))

    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'persona.counts.known' })).toBeNull(),
    )
    expect(screen.getByText('persona.intro.lead').closest('aside')?.className).not.toContain(
      'hidden',
    )
    expect(screen.getByTestId('persona-console').className).not.toContain('hidden')
  })

  // ── THE BINDING (step 4). Pointing at a line lights the point that line
  // lives on. The ring is painted on a canvas, so what is asserted here is the
  // state the ring is drawn FROM — announced on the figure's keyboard list,
  // which is where a screen reader meets the same fact. ───────────────────────
  const bodyPoint = (text: string) =>
    within(screen.getByRole('list', { name: 'persona.figure.nodeList' })).getByRole('button', {
      name: text,
    })

  it('pointing at a row lights that line ON THE BODY, and letting go puts it out', async () => {
    judgmentsPayload = corpus()
    render(<PersonaModule />)
    await openKnown()
    const row = (await within(panel()).findByText('値段より、直せることを見る')).closest(
      'button',
    ) as HTMLElement

    expect(bodyPoint('値段より、直せることを見る').getAttribute('aria-current')).toBeNull()
    fireEvent.mouseEnter(row)
    expect(bodyPoint('値段より、直せることを見る').getAttribute('aria-current')).toBe('true')
    // ⚠ EXACTLY ONE. A highlight that accumulates would light the whole body
    // after a minute of reading — the inverse of what pointing means.
    expect(
      screen
        .getByRole('list', { name: 'persona.figure.nodeList' })
        .querySelectorAll('[aria-current="true"]'),
    ).toHaveLength(1)
    fireEvent.mouseLeave(row)
    expect(bodyPoint('値段より、直せることを見る').getAttribute('aria-current')).toBeNull()
  })

  it('the KEYBOARD lights it too — tabbing the list is the same gesture', async () => {
    // Without this the binding does not exist at all for a keyboard-only owner:
    // there is no hover to give them.
    judgmentsPayload = corpus()
    render(<PersonaModule />)
    await openKnown()
    const row = (await within(panel()).findByText('値段より、直せることを見る')).closest(
      'button',
    ) as HTMLElement

    fireEvent.focus(row)
    expect(bodyPoint('値段より、直せることを見る').getAttribute('aria-current')).toBe('true')
    fireEvent.blur(row)
    expect(bodyPoint('値段より、直せることを見る').getAttribute('aria-current')).toBeNull()
  })

  it('⚠ LEAVING THE SCREEN PUTS THE LIGHT OUT — no ring for a list nobody sees', async () => {
    judgmentsPayload = corpus()
    render(<PersonaModule />)
    await openKnown()
    const row = (await within(panel()).findByText('値段より、直せることを見る')).closest(
      'button',
    ) as HTMLElement
    fireEvent.mouseEnter(row)
    expect(bodyPoint('値段より、直せることを見る').getAttribute('aria-current')).toBe('true')

    // Closing with the pointer still on the row fires NO mouseleave — the node
    // is simply gone — so nothing on the list's side can clear this.
    fireEvent.click(within(panel()).getByRole('button', { name: /persona\.known\.back/ }))
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'persona.counts.known' })).toBeNull(),
    )
    expect(bodyPoint('値段より、直せることを見る').getAttribute('aria-current')).toBeNull()
  })

  it('probing a part of the BODY marks the lines seated there', async () => {
    // The other direction of the same binding: press a region on the figure
    // (this is the keyboard path to the probe) and the rows that live in it are
    // marked. `region:head` is the explicit seat the writers stamp.
    judgmentsPayload = [
      judgment({ id: 'h-1', text: '頭に置いたもの', tags: ['chat', 'region:head'] }),
      judgment({ id: 'a-1', text: '腕に置いたもの', tags: ['chat', 'region:arms'] }),
    ]
    render(<PersonaModule />)
    await openKnown()
    await waitFor(() => expect(within(panel()).getByText('頭に置いたもの')).toBeTruthy())
    expect(panel().querySelectorAll('[data-region-hit="true"]')).toHaveLength(0)

    fireEvent.click(
      within(screen.getByRole('list', { name: 'persona.figure.regionList' })).getByRole('button', {
        name: /persona\.region\.head/,
      }),
    )

    const hits = Array.from(panel().querySelectorAll('[data-region-hit="true"]'))
    expect(hits).toHaveLength(1)
    expect(hits[0].textContent).toContain('頭に置いたもの')
  })

  it('a probe does not survive the screen being closed and re-opened', async () => {
    judgmentsPayload = [judgment({ id: 'h-1', text: '頭に置いたもの', tags: ['chat', 'region:head'] })]
    render(<PersonaModule />)
    await openKnown()
    await waitFor(() => expect(within(panel()).getByText('頭に置いたもの')).toBeTruthy())
    fireEvent.click(
      within(screen.getByRole('list', { name: 'persona.figure.regionList' })).getByRole('button', {
        name: /persona\.region\.head/,
      }),
    )
    expect(panel().querySelectorAll('[data-region-hit="true"]')).toHaveLength(1)

    fireEvent.click(within(panel()).getByRole('button', { name: /persona\.known\.back/ }))
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'persona.counts.known' })).toBeNull(),
    )
    await openKnown()
    await waitFor(() => expect(within(panel()).getByText('頭に置いたもの')).toBeTruthy())
    // A mark left over from last time would point at a part of the body the
    // owner is not pointing at.
    expect(panel().querySelectorAll('[data-region-hit="true"]')).toHaveLength(0)
  })

  // ── 「取り消す」 (plan step 3) ───────────────────────────────────────────────
  // A second act beside 「直す」: correcting says 「本当はこう」 and needs a
  // replacement sentence, taking back says 「これは要らない」 and needs none.
  it('takes a line back: it leaves the list, and lands in its own group', async () => {
    judgmentsPayload = [
      judgment({ id: 'j-keep', text: 'これは要る', tags: ['chat'] }),
      judgment({ id: 'j-gone', text: 'これは要らない', tags: ['chat'] }),
    ]
    render(<PersonaModule />)
    await openKnown()
    fireEvent.click(await within(panel()).findByText('これは要らない'))
    fireEvent.click(await screen.findByText('persona.retire.start'))

    // ⚠ ASSERTED THROUGH THE RELOADED LIST, not through the POST. A button that
    // fired the request and left the screen showing the withdrawn line would
    // pass any assertion about the call alone.
    await waitFor(() =>
      expect(within(panel()).queryAllByText('persona.known.group.retired').length).toBeGreaterThan(
        0,
      ),
    )
    expect(posts.some((p) => p.url === '/api/you-corpus/retire' && p.id === 'j-gone')).toBe(true)
    expect(within(panel()).getByText('これは要る')).toBeTruthy()
    // The line is still ON SCREEN — in the withdrawn group, with the date it was
    // withdrawn. Nothing is deleted, and a record you cannot see is a record you
    // cannot get back.
    expect(within(panel()).getByText('これは要らない')).toBeTruthy()
    expect(within(panel()).getByText(/^persona\.retire\.at/)).toBeTruthy()
  })

  it('⚠ DOES NOT COUNT what was taken back', async () => {
    // The number beside 「分身が知っていること」 answers one question — how much does
    // it hold — and a line he took back is precisely one it does not.
    judgmentsPayload = [
      judgment({ id: 'j-keep', text: 'これは要る', tags: ['chat'] }),
      judgment({ id: 'j-gone', text: 'これは要らない', tags: ['chat'] }),
    ]
    render(<PersonaModule />)
    await openKnown()
    const header = () => (panel().firstElementChild as HTMLElement).textContent ?? ''
    await waitFor(() => expect(header()).toContain('2'))

    fireEvent.click(await within(panel()).findByText('これは要らない'))
    fireEvent.click(await screen.findByText('persona.retire.start'))
    await waitFor(() => expect(header()).toContain('1'))
  })

  it('puts it back — taking something back is not a one-way door', async () => {
    judgmentsPayload = [judgment({ id: 'j-gone', text: 'やっぱり要る', tags: ['chat'] })]
    render(<PersonaModule />)
    await openKnown()
    fireEvent.click(await within(panel()).findByText('やっぱり要る'))
    fireEvent.click(await screen.findByText('persona.retire.start'))
    await waitFor(() =>
      expect(within(panel()).queryAllByText('persona.known.group.retired').length).toBeGreaterThan(
        0,
      ),
    )

    // Pressing the withdrawn row opens a card with ONE button: it is not on the
    // body, so there is nothing to correct — only to put back.
    fireEvent.click(within(panel()).getByText('やっぱり要る'))
    expect(await screen.findByText('persona.retire.undo')).toBeTruthy()
    expect(screen.queryByText('persona.correct.start')).toBeNull()

    fireEvent.click(screen.getByText('persona.retire.undo'))
    await waitFor(() =>
      expect(within(panel()).queryAllByText('persona.known.group.retired')).toHaveLength(0),
    )
    expect(within(panel()).getByText('やっぱり要る')).toBeTruthy()
  })

  it('says so when it could not save, and keeps the line where it was', async () => {
    judgmentsPayload = [judgment({ id: 'j-gone', text: 'これは要らない', tags: ['chat'] })]
    retireFails = true
    render(<PersonaModule />)
    await openKnown()
    fireEvent.click(await within(panel()).findByText('これは要らない'))
    fireEvent.click(await screen.findByText('persona.retire.start'))

    expect(await screen.findByText('persona.retire.failed')).toBeTruthy()
    // ⚠ NOT MOVED OPTIMISTICALLY. Whether a line is live is resolved by the
    // server replaying the whole log; a screen that guessed would show the owner
    // a belief withdrawn only in his browser.
    expect(within(panel()).queryAllByText('persona.known.group.retired')).toHaveLength(0)
  })

  // ── 「どれが自分ではないか」 (plan step 8) ─────────────────────────────────
  const CHECK = {
    id: 'chk-1',
    options: [
      { id: 'j-mine', text: 'ぼくの言葉' },
      { id: 'barnum:0', text: '誰にでも当てはまる文' },
      { id: 'j-other', text: 'もうひとつの言葉' },
    ],
  }

  it('offers the check at the top of the screen, and says which one fits anybody', async () => {
    judgmentsPayload = corpus()
    checkPayload = CHECK
    render(<PersonaModule />)
    await openKnown()

    await screen.findByText('persona.tellApart.lead')
    fireEvent.click(within(panel()).getByText('誰にでも当てはまる文'))

    expect(await screen.findByText('persona.tellApart.right')).toBeTruthy()
    // ⚠ THE ANSWER IS DECIDED BY THE SERVER. The page that asks the question
    // must not be carrying the answer to it.
    expect(posts.some((p) => p.url === '/api/you-corpus/tell-apart/answer')).toBe(true)
    expect(screen.queryByText('persona.tellApart.wrong')).toBeNull()
  })

  it('⚠ A WRONG ANSWER NAMES THE LINE, not a score', async () => {
    // "You got it wrong" with no line attached is a grade. The line is the only
    // part he can act on — and the copy says what it means: this sentence does
    // not read as particularly his.
    judgmentsPayload = corpus()
    checkPayload = CHECK
    render(<PersonaModule />)
    await openKnown()
    await screen.findByText('persona.tellApart.lead')
    fireEvent.click(within(panel()).getByText('ぼくの言葉'))

    expect(await screen.findByText('persona.tellApart.wrong')).toBeTruthy()
    expect(within(panel()).getAllByText('ぼくの言葉').length).toBeGreaterThan(0)
    expect(screen.getByText('persona.tellApart.wrongHint')).toBeTruthy()
    // The stranger is shown too, so the answer ends by showing what a
    // fits-anyone sentence looks like beside his own.
    expect(screen.getByText('誰にでも当てはまる文')).toBeTruthy()
  })

  it('「あとで」 takes it off the screen at once', async () => {
    judgmentsPayload = corpus()
    checkPayload = CHECK
    render(<PersonaModule />)
    await openKnown()
    await screen.findByText('persona.tellApart.lead')
    fireEvent.click(screen.getByText('persona.tellApart.later'))

    // ⚠ NOT AFTER A ROUND TRIP. Declining is the owner's call, and making him
    // wait to be rid of a question he just dismissed is the whole complaint
    // about this kind of card.
    await waitFor(() => expect(screen.queryByText('persona.tellApart.lead')).toBeNull())
    expect(posts.some((p) => p.url === '/api/you-corpus/tell-apart/skip')).toBe(true)
  })

  it('is simply ABSENT when none is due — the usual case', async () => {
    judgmentsPayload = corpus()
    checkPayload = null
    render(<PersonaModule />)
    await openKnown()
    await waitFor(() => expect(within(panel()).getByText('値段より、直せることを見る')).toBeTruthy())
    expect(screen.queryByText('persona.tellApart.heading')).toBeNull()
  })

  it('says so when the answer could not be sent, and keeps the question', async () => {
    judgmentsPayload = corpus()
    checkPayload = CHECK
    checkAnswerFails = true
    render(<PersonaModule />)
    await openKnown()
    await screen.findByText('persona.tellApart.lead')
    fireEvent.click(within(panel()).getByText('誰にでも当てはまる文'))

    expect(await screen.findByText('persona.tellApart.failed')).toBeTruthy()
    // Still answerable — a failed send must not consume the question.
    expect(screen.getByText('persona.tellApart.lead')).toBeTruthy()
  })

  it('a row opens the SAME note card a lit point opens', async () => {
    judgmentsPayload = corpus()
    render(<PersonaModule />)
    await openKnown()
    await waitFor(() => expect(within(panel()).getByText('値段より、直せることを見る')).toBeTruthy())
    fireEvent.click(within(panel()).getByText('値段より、直せることを見る'))

    // The card, with its correction path already wired — the list only had to
    // reach it.
    expect(await screen.findByText('persona.correct.start')).toBeTruthy()
  })
})

describe('PersonaModule — 「言ったこと / やったこと」', () => {
  // Every answer to the day's question is stored as ONE line: the record in its
  // own words, then what he said about it. This screen splits it back apart —
  // and says nothing about the two halves. See src/lib/persona/saidDid.ts.
  const pair = (id: string, record: string, said: string, addedAt: string) =>
    judgment({
      id,
      text: `Q: ${record}\n→ オーナーの回答: ${said}`,
      tags: ['interview', 'card-rework'],
      addedAt,
    })

  beforeEach(() => {
    portraitPayload = portraitOf()
  })

  const openSaidDid = async () =>
    fireEvent.click(await screen.findByRole('button', { name: /^persona\.saidDid\.heading/ }))

  it('opens a screen with both halves in their own columns', async () => {
    judgmentsPayload = [
      pair('p1', '66日前に作ったカードが保留のままです', '要らないと決めきれないから', '2026-08-15T00:00:00.000Z'),
    ]
    render(<PersonaModule />)
    await openSaidDid()

    const screenEl = await screen.findByRole('region', { name: 'persona.saidDid.heading' })
    expect(within(screenEl).getByText('66日前に作ったカードが保留のままです')).toBeTruthy()
    expect(within(screenEl).getByText('要らないと決めきれないから')).toBeTruthy()
    // ⚠ AND NO RULING ON THE PAIR. The stored line is not shown as one blob
    // either — the split is the whole feature.
    expect(within(screenEl).queryByText(/オーナーの回答/)).toBeNull()
  })

  it('⚠ OFFERS THE TWO EXITS on the line itself — the screen is not a dead end', async () => {
    // The point of putting a declaration beside its record is that the owner can
    // DO something about the mismatch. v1 was read-only, which made it a place
    // to feel bad rather than a place to act. There are exactly two acts, and
    // both are on the record (the only thing this app owns): rewrite it, or take
    // it back. A third button telling him to change his behaviour would turn the
    // screen into a lecture.
    judgmentsPayload = [pair('p1', '記録', 'そう決めている', '2026-08-15T00:00:00.000Z')]
    render(<PersonaModule />)
    await openSaidDid()
    const el = await screen.findByRole('region', { name: 'persona.saidDid.heading' })

    expect(within(el).getByText('persona.correct.start')).toBeTruthy()
    fireEvent.click(within(el).getByText('persona.retire.start'))

    await waitFor(() =>
      expect(posts.some((p) => p.url === '/api/you-corpus/retire' && p.id === 'p1')).toBe(true),
    )
    // The withdrawn line leaves the list, because it is not live any more —
    // and the screen STAYS OPEN saying so. Closing a screen out from under the
    // owner because his last row went is a worse surprise than an empty one.
    await waitFor(() => expect(screen.getByText('persona.saidDid.empty')).toBeTruthy())
    expect(screen.queryByText('そう決めている')).toBeNull()
  })

  it('「直す」 leaves for the composer rather than editing in place', async () => {
    // Rewriting is a different act from auditing, and the composer is where
    // every other correction on this surface is written. Two places to write a
    // correction, depending on where you started, would be the worse seam.
    judgmentsPayload = [pair('p1', '記録', 'そう決めている', '2026-08-15T00:00:00.000Z')]
    render(<PersonaModule />)
    await openSaidDid()
    const el = await screen.findByRole('region', { name: 'persona.saidDid.heading' })
    fireEvent.click(within(el).getByText('persona.correct.start'))

    expect(await screen.findByText('persona.correct.submit')).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'persona.saidDid.heading' })).toBeNull()
  })

  it('⚠ SAYS WHAT IT IS NOT — no comparison, no score, in the copy itself', async () => {
    // The screen's name implies 「そのあと何をしたか」. The record under each line
    // is what was true WHEN THE QUESTION WAS ASKED, so the lead has to say so —
    // and it has to say that nothing here is being scored, because a pair of
    // texts side by side invites exactly that reading.
    judgmentsPayload = [pair('p1', '記録', '答え', '2026-08-15T00:00:00.000Z')]
    render(<PersonaModule />)
    await openSaidDid()
    const el = await screen.findByRole('region', { name: 'persona.saidDid.heading' })
    expect(within(el).getByText('persona.saidDid.lead')).toBeTruthy()
    // ⚠ BOTH HALVES ARE LABELLED. Labelling only the record is what made the
    // screen unreadable in the first cut (owner: 「どれが言ったことでどれが
    // やったことかわからん」) — both halves are prose in the same voice, so size
    // and colour are a hierarchy, not a legend.
    expect(within(el).getByText('persona.saidDid.said')).toBeTruthy()
    expect(within(el).getByText('persona.saidDid.did')).toBeTruthy()
  })

  it('is a SCREEN: the rail and the console step off', async () => {
    judgmentsPayload = [pair('p1', '記録', '答え', '2026-08-15T00:00:00.000Z')]
    render(<PersonaModule />)
    await openSaidDid()
    await screen.findByRole('region', { name: 'persona.saidDid.heading' })

    expect(screen.getByText('persona.intro.lead').closest('aside')?.className).toContain('hidden')
    expect(screen.getByTestId('persona-console').className).toContain('hidden')
  })

  it('⚠ THE ROW IS ABSENT when there is no pair to show', async () => {
    // A row that opens a screen saying 「まだありません」 is a promise the record
    // cannot keep.
    judgmentsPayload = [judgment({ id: 'plain', text: 'ただの一文', tags: ['chat'] })]
    render(<PersonaModule />)
    await waitFor(() => expect(screen.getByText('persona.intro.lead')).toBeTruthy())
    expect(screen.queryByText(/^persona\.saidDid\.heading/)).toBeNull()
  })

  it('⚠ …AND ABSENT OVER A FAILED RE-READ, rather than printing a stale count', async () => {
    // ⚠ THE FIRST READ HAS TO LAND FOR THIS TO MEASURE ANYTHING. With no
    // successful read there are no pairs either way, so a test that only fails
    // the FIRST read passes whatever the code does — it was written that way
    // first, and the mutation pass caught it green. Here a real read lands, a
    // WRITE then forces a re-read, and that one fails: `judgments` still holds
    // the old list, so the count is available and must still not be printed.
    judgmentsPayload = [
      pair('p1', '記録', '答え', '2026-08-15T00:00:00.000Z'),
      judgment({ id: 'j-gone', text: '取り消す一文', tags: ['chat'] }),
    ]
    render(<PersonaModule />)
    await screen.findByRole('button', { name: /^persona\.saidDid\.heading/ })

    openNode('取り消す一文')
    judgmentsFail = true
    fireEvent.click(await screen.findByText('persona.retire.start'))

    await waitFor(() => expect(screen.getByText('persona.loadFailed')).toBeTruthy())
    expect(screen.queryByText(/^persona\.saidDid\.heading/)).toBeNull()
  })
})

describe('PersonaModule — the courses', () => {
  // ── WHERE THE COURSES LIVE ────────────────────────────────────────────────
  // They used to be four permanent rows at the foot of the rail. The owner cut
  // that (2026-08-16: 「ここの表示もずっとしておかなくてもいいかも」/「クリックしたら
  // 中身が表示されて受けることができるぐらいのやつでいい」), so the stage carries a
  // count and the list is raised on demand. These four pin that arrangement —
  // without them the cheapest way to make everything else below pass is to put
  // the list back on the stage, which is the change being undone.

  it('keeps the list OFF the stage until it is asked for', async () => {
    render(<PersonaModule />)
    // The entrance appears (the catalogue read landed) …
    await screen.findByRole('button', { name: /persona\.counts\.courses/ })
    // … and nothing of the list itself is drawn yet.
    expect(screen.queryByRole('region', { name: 'persona.course.railHeading' })).toBeNull()
    expect(screen.queryByText(COURSES[0].name)).toBeNull()

    await awaitCourses()
    expect(screen.getByText(COURSES[0].name)).toBeTruthy()
  })

  it('counts the SAME list the line opens, not the portrait\'s own tally', async () => {
    // Both reads carry a course tally and in production they agree. When they
    // do NOT, the number labelling a button has to describe what the button
    // opens — otherwise the stage says 4/4 over a panel showing two.
    portraitPayload = portraitOf({ nodeCount: 1, takenCount: 4, courseCount: 4 })
    courses = coursesPayload({
      [COURSES[0].id]: { lastTakenAt: '2026-08-01T09:00:00.000Z' },
      [COURSES[1].id]: { lastTakenAt: '2026-08-02T09:00:00.000Z' },
    })
    render(<PersonaModule />)

    const entry = await screen.findByRole('button', { name: /persona\.counts\.courses/ })
    expect(entry.textContent).toContain('2/4')
    expect(entry.textContent).not.toContain('4/4')
  })

  it('is still reachable when the PORTRAIT could not be read', async () => {
    // The entrance sits in the counts block, which used to open only for a
    // portrait. Feeding it one read while it is the only door to another is how
    // a feature disappears for a reason that has nothing to do with it.
    portraitPayload = null // ⇒ /api/persona/portrait 500s
    render(<PersonaModule />)

    await awaitCourses()
    expect(screen.getByText(COURSES[0].name)).toBeTruthy()
    // …and the portrait's own line is still absent, as it must be.
    expect(screen.queryByText('persona.counts.known')).toBeNull()
  })

  it('says the tally could not be READ rather than printing a 0/0', async () => {
    coursesFail = true
    render(<PersonaModule />)

    const entry = await screen.findByRole('button', { name: /persona\.counts\.courses/ })
    expect(entry.textContent).toContain('persona.counts.unread')
    expect(entry.textContent).not.toContain('0/0')
  })

  it('renders every course the server offers, with what it costs and what it grows', async () => {
    render(<PersonaModule />)
    await awaitCourses()

    for (const c of COURSES) {
      expect(screen.getByRole('button', { name: new RegExp(c.name) })).toBeTruthy()
    }
    // A never-taken course states its LENGTH — the owner decides whether to
    // spend 25 questions before starting. The region it grows was dropped from
    // the words on purpose: the figure lights that patch when the course
    // finishes, which shows it.
    expect(document.body.textContent).toContain(
      `persona.course.state.new:{"count":${COURSES[0].itemCount}}`,
    )
  })

  it('names each course the way the SERVER named it, not from a local copy', async () => {
    // The rail is the catalogue the server sent (name / itemCount / region), and
    // only the ITEMS come from the local instrument file. Printing COURSES here
    // would look identical on a matching build and drift silently on any other.
    courses = coursesPayload({ big5: { name: 'Renamed on the server' } })
    render(<PersonaModule />)
    await awaitCourses()
    expect(screen.getByRole('button', { name: /Renamed on the server/ })).toBeTruthy()
    expect(screen.queryByText(COURSES[0].name)).toBeNull()
  })

  it('shows the date instead of the price once a course has been taken', async () => {
    courses = coursesPayload({ big5: { lastTakenAt: '2026-08-01T09:00:00.000Z', headline: 'done' } })
    render(<PersonaModule />)
    await awaitCourses()
    await waitFor(() => expect(document.body.textContent).toContain('persona.course.state.done'))
  })

  it('says the courses could not be read rather than showing no courses at all', async () => {
    coursesFail = true
    render(<PersonaModule />)
    await awaitCourses()
    await waitFor(() => expect(screen.getByText('persona.loadFailed')).toBeTruthy())
    expect(screen.queryByRole('button', { name: new RegExp(COURSES[0].name) })).toBeNull()
  })

  it('starting a course asks item 1 of N, in the same card the question lives in', async () => {
    render(<PersonaModule />)
    await awaitCourses()

    fireEvent.click(rail(COURSES[0].name))
    expect(screen.getByText(BIG5_ITEMS[0][2])).toBeTruthy()
    expect(screen.getByText(`1 / ${BIG5_ITEMS.length}`)).toBeTruthy()
    // The five-point scale is offered as five real buttons, not a slider.
    for (const label of LIKERT_AGREE) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy()
    }
  })

  it('answering advances to the next item', async () => {
    render(<PersonaModule />)
    await awaitCourses()

    fireEvent.click(rail(COURSES[0].name))
    fireEvent.click(screen.getByRole('button', { name: LIKERT_AGREE[0] }))

    expect(screen.getByText(BIG5_ITEMS[1][2])).toBeTruthy()
    expect(screen.getByText(`2 / ${BIG5_ITEMS.length}`)).toBeTruthy()
    // Nothing is sent mid-course: a half-answered instrument must never be
    // scored.
    expect(posts.filter((p) => String(p.url ?? '').includes('/submit'))).toHaveLength(0)
  })

  it('a two-choice course offers both cards and records which one was picked', async () => {
    render(<PersonaModule />)
    await awaitCourses()

    const work = COURSES.find((c) => c.id === 'work')!
    fireEvent.click(rail(work.name))
    const [a, b] = WORK_ITEMS[0]
    const second = `${WORK_THEMES[b].name} — ${WORK_THEMES[b].d}`
    expect(screen.getByRole('button', { name: `${WORK_THEMES[a].name} — ${WORK_THEMES[a].d}` })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: second }))
    // Answers are INDICES into the item's own choice pair — the server scores.
    for (let i = 1; i < work.itemCount; i++) {
      const item = WORK_ITEMS[i]
      fireEvent.click(
        screen.getByRole('button', {
          name: `${WORK_THEMES[item[0]].name} — ${WORK_THEMES[item[0]].d}`,
        }),
      )
    }
    await waitFor(() => expect(screen.getByText('persona.result.kicker')).toBeTruthy())
    const submit = posts.find((p) => String(p.url ?? '').includes('/submit'))!
    expect(submit.answers).toEqual([1, ...Array(work.itemCount - 1).fill(0)])
  })

  it('finishing posts the WHOLE answer vector and shows the sheet, sourced and hedged', async () => {
    render(<PersonaModule />)
    await awaitCourses()

    const big5 = COURSES[0]
    fireEvent.click(rail(big5.name))
    for (let i = 0; i < big5.itemCount; i++) {
      fireEvent.click(screen.getByRole('button', { name: LIKERT_AGREE[0] }))
    }

    expect(await screen.findByText('persona.result.kicker')).toBeTruthy()
    const submit = posts.find((p) => String(p.url ?? '').includes('/submit'))!
    expect(submit.url).toBe('/api/persona/courses/big5/submit')
    expect(submit.answers).toEqual(Array(big5.itemCount).fill(0))

    // The sheet shows what was scored…
    const scored = scoreCourse(courseById('big5')!, Array(big5.itemCount).fill(0))
    expect(screen.getByText(scored.headline)).toBeTruthy()
    // …WHERE THE ITEMS CAME FROM, verbatim (the licensing/provenance promise)…
    expect(document.body.textContent).toContain(big5.source)
    // …every finding with the number behind it…
    expect(screen.getAllByText(new RegExp(`^${big5.name} ・ `))).toHaveLength(
      scored.findings.length,
    )
    // …and the caveat that this is a self-report, never a verdict.
    expect(screen.getByText('persona.result.caveat')).toBeTruthy()
  })

  // The caveat is not decoration: instruments.ts exports it so exactly one
  // wording exists, and the sheet renders it through i18n. If the two drift, the
  // shipped sheet stops matching the promise the instrument file makes.
  it('the Japanese caveat is the instrument file’s, word for word', () => {
    expect(messages.ja['persona.result.caveat']).toBe(PERSONA_RESULT_CAVEAT)
    expect(messages.en['persona.result.caveat']).toBeTruthy()
  })

  it('keeps the answers when the result cannot be saved, and re-sends the same vector', async () => {
    submitFails = true
    render(<PersonaModule />)
    await awaitCourses()

    const big5 = COURSES[0]
    fireEvent.click(rail(big5.name))
    for (let i = 0; i < big5.itemCount; i++) {
      fireEvent.click(screen.getByRole('button', { name: LIKERT_AGREE[0] }))
    }

    expect(await screen.findByText('persona.course.failed')).toBeTruthy()
    expect(screen.queryByText('persona.result.kicker')).toBeNull()

    // Retaking 25 questions because a write failed would be the cruel version.
    submitFails = false
    fireEvent.click(screen.getByText('persona.course.retry'))
    expect(await screen.findByText('persona.result.kicker')).toBeTruthy()
    const sent = posts.filter((p) => String(p.url ?? '').includes('/submit'))
    expect(sent).toHaveLength(2)
    expect(sent[1].answers).toEqual(sent[0].answers)
  })

  // The sheet's list is headed 「ペルソナに入ったもの」. When the corpus write
  // partly failed, that heading is a claim the corpus cannot back.
  it('does not claim a finding entered the persona when the corpus refused it', async () => {
    mintedOverride = 0
    render(<PersonaModule />)
    await awaitCourses()

    const big5 = COURSES[0]
    fireEvent.click(rail(big5.name))
    for (let i = 0; i < big5.itemCount; i++) {
      fireEvent.click(screen.getByRole('button', { name: LIKERT_AGREE[0] }))
    }

    expect(await screen.findByText('persona.result.mintedPartial')).toBeTruthy()
  })

  it('a fully-minted result does NOT show the partial warning', async () => {
    render(<PersonaModule />)
    await awaitCourses()

    const big5 = COURSES[0]
    fireEvent.click(rail(big5.name))
    for (let i = 0; i < big5.itemCount; i++) {
      fireEvent.click(screen.getByRole('button', { name: LIKERT_AGREE[0] }))
    }

    await screen.findByText('persona.result.kicker')
    expect(screen.queryByText('persona.result.mintedPartial')).toBeNull()
  })

  it('shows the SETTING above the question — the quotes never arrive naked', async () => {
    // The complaint that produced this (owner, 2026-08-15): the question read
    // as two quotes with no world around them. The server now sends a sentence
    // that says when it was and what kind of moment it was; if the screen
    // silently drops it, the owner is back to reading a fragment.
    questionPayload = question()
    render(<PersonaModule />)

    const setting = await screen.findByText(question().contextEn!)
    const asked = screen.getByText(question().textEn)
    expect(setting).toBeTruthy()
    // ABOVE, not beside or below: it is what you read to understand the ask.
    expect(setting.compareDocumentPosition(asked) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('a question from an OLDER build, with no setting, still renders', async () => {
    // `context*` is optional precisely so a question written before this
    // existed stays answerable rather than blanking the corner.
    questionPayload = question({ contextJa: undefined, contextEn: undefined })
    render(<PersonaModule />)
    expect(await screen.findByText(question().textEn)).toBeTruthy()
  })

  it('quitting a course sends nothing and gives the day’s question back', async () => {
    questionPayload = question()
    render(<PersonaModule />)
    await awaitCourses()

    fireEvent.click(rail(COURSES[0].name))
    fireEvent.click(screen.getByRole('button', { name: LIKERT_AGREE[0] }))
    fireEvent.click(screen.getByText('persona.ask.quit'))

    expect(screen.getByText(question().textEn)).toBeTruthy()
    expect(posts.filter((p) => String(p.url ?? '').includes('/submit'))).toHaveLength(0)
  })
})

// ─── THE PORTRAIT ───────────────────────────────────────────────────────────
//
// 「で、私はどういう人?」 answered at a glance. The screen composes NOTHING: it
// renders the lines the server composed from scored results, with the evidence
// under each one. The failure this suite exists to catch is the one that would
// make the whole feature a horoscope — a sentence on screen that no course
// backs.
describe('PersonaModule — the portrait', () => {
  it('a 200 that is NOT a portrait renders nothing — and takes nothing else down', async () => {
    // Measured 2026-08-14: the loader stored any 200 body, and the render path
    // reaches straight into `lines`, so a bare `{}` (an older server, an error
    // page, a proxy's JSON) threw inside render and blanked the whole panel —
    // App.render's gate test caught it, three suites away from the cause.
    // "Not a portrait" and "never read" have to be the same state.
    portraitPayload = { nodeCount: 3, takenCount: 1, courseCount: 4 } as unknown as PersonaPortrait
    render(<PersonaModule />)

    // The rest of the screen is alive…
    expect(await screen.findByText('persona.tabLabel')).toBeTruthy()
    // …and the portrait says nothing at all — not even its invitation, which
    // would be a claim that the portrait WAS read and is empty.
    expect(screen.queryByText('persona.portrait.invite')).toBeNull()
    expect(screen.queryByRole('region', { name: 'persona.portrait.heading' })).toBeNull()
  })

  it('renders the composed lines, each with the evidence under it', async () => {
    const values = portraitLine()
    const big5 = portraitLine({
      text: '新しい考え方に向かう人。',
      detail: '性格の5因子 ・ 開放性 78%(やや高め)',
      courseId: 'big5',
      ageDays: 0,
    })
    portraitPayload = portraitOf({ lines: [values, big5] })
    render(<PersonaModule />)
    await openKnown()

    expect(await screen.findByText(values.text)).toBeTruthy()
    expect(screen.getByText(big5.text)).toBeTruthy()
    // Provenance is VISIBLE, not a tooltip — and its age wording is
    // portraitAgeLabel's, never a second vocabulary invented here.
    expect(screen.getByText(`${values.detail} ・ ${portraitAgeLabel(13)}`)).toBeTruthy()
    expect(screen.getByText(`${big5.detail} ・ ${portraitAgeLabel(0)}`)).toBeTruthy()
  })

  // THE ONE THAT MATTERS. With no evidence there is nothing true to say about
  // who the owner is, so the block asks — and says nothing else.
  it('invites a course instead of composing a sentence when nothing is evidenced', async () => {
    portraitPayload = portraitOf({ lines: [], nodeCount: 3, takenCount: 0, courseCount: 4 })
    render(<PersonaModule />)
    await openKnown()

    await screen.findByText('persona.portrait.empty')
    // The invitation, and NOT ONE composed line: no headline, no "you are a
    // balanced person" filler smuggled in beside it.
    // ⚠ SCOPED TO THE SUMMARY BLOCK, and asserted as EXACT TEXT. This used to
    // count <li> elements in the whole card, which worked only while the card
    // held nothing but the portrait; the same card now carries the corpus list,
    // whose rows are <li>, so that proxy would fail for a reason unrelated to
    // what it was guarding. Exact text is what "not one composed line" means:
    // anything smuggled in beside the invitation makes this string longer.
    const summary = screen.getByTestId('portrait-summary')
    expect(summary.textContent).toBe('persona.known.portraitHeadingpersona.portrait.empty')
  })

  // Same rule as the figure's empty state: "nothing to say yet" is a CLAIM, and
  // a read that failed is in no position to make it — nor to invite anyone
  // anywhere on the strength of it.
  it('shows no portrait at all when the portrait could not be read', async () => {
    portraitPayload = null
    render(<PersonaModule />)

    await awaitCourses()
    expect(screen.queryByRole('region', { name: 'persona.counts.known' })).toBeNull()
    expect(screen.queryByText('persona.portrait.empty')).toBeNull()
    // …and there is no way IN to it either. NOT "the counts block is absent" —
    // that block also carries the courses line, which is a different read and
    // has no business disappearing with this one. What must be absent is the
    // portrait's OWN count, which is what raises the portrait.
    expect(screen.queryByText('persona.counts.known')).toBeNull()
  })

  it('re-reads the portrait when a course finishes, so it is never a version behind', async () => {
    portraitPayload = portraitOf({ lines: [], nodeCount: 3, takenCount: 0, courseCount: 4 })
    render(<PersonaModule />)
    await awaitCourses()
    openPortrait()
    await screen.findByText('persona.portrait.empty')
    // The reading column holds exactly ONE thing, so raising the portrait put
    // the course list away — it has to be asked for again.
    expect(screen.queryByText(COURSES[0].name)).toBeNull()
    await awaitCourses()

    // The course the owner is about to take is the evidence for the new line.
    portraitPayload = portraitOf({
      lines: [portraitLine({ text: '型は INFP — 内向、感情。', courseId: 'type' })],
      nodeCount: 8,
      takenCount: 1,
      courseCount: 4,
    })
    const big5 = COURSES[0]
    fireEvent.click(rail(big5.name))
    for (let i = 0; i < big5.itemCount; i++) {
      fireEvent.click(screen.getByRole('button', { name: LIKERT_AGREE[0] }))
    }

    // Raise the portrait again and read what is in it NOW. The re-read happens
    // whether or not anyone is looking (see `sendCourse`); this asks for it
    // afterwards, which is also how the owner would find out.
    openPortrait()
    expect(await screen.findByText('型は INFP — 内向、感情。')).toBeTruthy()
    expect(screen.queryByText('persona.portrait.empty')).toBeNull()
  })
})

// ─── THE DECISION LEDGER ────────────────────────────────────────────────────
//
// 「分身は今週、何回あなたの代わりに答えたか」. Everything above is SELF-REPORT;
// this block is the record of the stand-in acting on real work. The failures
// this suite exists to catch are the ones that would make it a flattering
// dashboard instead of a record: lifetime totals printed under a cap that says
// "this week", an empty ledger padded into activity, the owner's own correction
// dropped from the row it belongs to, and a read that failed pretending the
// stand-in has simply never acted.
describe('PersonaModule — the decision ledger', () => {
  // The ledger's own CARD is gone (2026-08-15): it is one line in the counts
  // corner now, and pressing it opens the very list the card opened. Nothing
  // about the feature was removed — the corner just stopped being a dashboard.
  const ledgerLine = () =>
    within(countsBlock()).getByRole('button', { name: 'persona.ledger.label' })
  const ledgerDetail = () => screen.getByRole('region', { name: 'persona.ledger.detail.heading' })
  const openLedger = () => fireEvent.click(ledgerLine())
  const AT = '2026-08-12T09:00:00.000Z'

  it('counts THIS WEEK, not everything the ledger holds', async () => {
    // The line answers one question — how often did it speak for me lately.
    // Printing the lifetime tally under that question inflates the only number
    // on the screen that is supposed to be checkable.
    ledgerPayload = ledgerOf(
      { week: counts(3, 2, 1), total: counts(30, 20, 10), lastAt: AT },
      [ledgerEntry()],
    )
    render(<PersonaModule />)

    await waitFor(() => expect(ledgerLine()).toBeTruthy())
    const text = ledgerLine().textContent ?? ''
    expect(text).toContain('persona.counts.decided')
    expect(text).toContain('3')
    // …and the lifetime number is nowhere on it.
    expect(text).not.toContain('30')
  })

  it('shows NOTHING at all when nothing has been recorded — no counts, no placeholder', async () => {
    // An all-zero ledger is a first run. A 0 there reads as a dashboard that is
    // measuring something, and a line promising what will appear here one day
    // explains a feature the reader has no way to want yet (owner, 2026-08-15).
    // The corner stays empty until the stand-in has actually decided something.
    ledgerPayload = ledgerOf({ week: counts(0, 0, 0), total: counts(0, 0, 0), lastAt: null })
    render(<PersonaModule />)

    // The REST of the screen is up — so this asserts absence, not a slow load.
    await screen.findByText('persona.intro.lead')
    expect(screen.queryByLabelText('persona.ledger.label')).toBeNull()
    const body = document.body.textContent ?? ''
    expect(body).not.toContain('persona.counts.decided')
  })

  it('an idle WEEK still shows its zero — that is a measurement, not an empty ledger', async () => {
    // "It has never done anything" and "it did nothing in the last seven days"
    // are different claims. The first draws no line; the second draws a 0.
    ledgerPayload = ledgerOf(
      { week: counts(0, 0, 0), total: counts(4, 2, 1), lastAt: '2026-08-02T09:00:00.000Z' },
      [ledgerEntry()],
    )
    render(<PersonaModule />)

    await waitFor(() => expect(ledgerLine()).toBeTruthy())
    expect(ledgerLine().textContent).toContain('0')
    // …and the row behind it is still reachable, which is where the day it last
    // acted is actually readable.
    openLedger()
    expect(ledgerDetail()).toBeTruthy()
  })

  it('opens the decisions themselves: what it did, to what question, and why', async () => {
    ledgerPayload = ledgerOf({ week: counts(1, 1, 0), total: counts(1, 1, 0), lastAt: AT }, [
      ledgerEntry({
        id: 'l-ask',
        verdict: 'asked',
        why: 'irreversible',
        question: 'Delete the staging database?',
      }),
      ledgerEntry({
        id: 'l-ans',
        verdict: 'answered',
        confidence: 'high',
        question: 'Ship the price change tonight?',
      }),
    ])
    render(<PersonaModule />)

    await waitFor(() => expect(ledgerLine()).toBeTruthy())
    openLedger()

    const detail = ledgerDetail()
    expect(within(detail).getByText('persona.ledger.verdict.asked')).toBeTruthy()
    expect(within(detail).getByText('Delete the staging database?')).toBeTruthy()
    expect(within(detail).getByText('persona.ledger.verdict.answered')).toBeTruthy()
    expect(within(detail).getByText('Ship the price change tonight?')).toBeTruthy()
    // The reason CLASS in plain words, the project by its folder name, and how
    // well grounded the answer was — as ONE meta line per row, so this pins the
    // wording of the whole line rather than the presence of a substring.
    expect(
      within(detail).getByText(`billing-api ・ ${dayLabel(AT)} ・ persona.ledger.why.irreversible`),
    ).toBeTruthy()
    expect(
      within(detail).getByText(
        `billing-api ・ ${dayLabel(AT)} ・ persona.ledger.confidence.high`,
      ),
    ).toBeTruthy()
  })

  // THE ROW THAT MATTERS. The proxy asked, and the human answered — the one pair
  // on this screen that can measure the stand-in against the owner. Losing the
  // stamp turns the highest-value row into an ordinary "it asked you" row.
  it('marks the questions the OWNER answered afterwards', async () => {
    ledgerPayload = ledgerOf({ week: counts(0, 1, 0), total: counts(0, 1, 0), lastAt: AT }, [
      ledgerEntry({
        id: 'l-owner',
        verdict: 'asked',
        why: 'policy',
        question: 'Do we take the enterprise deal?',
        answered: { at: '2026-08-13T02:00:00.000Z', byOwner: true },
      }),
      ledgerEntry({ id: 'l-plain', verdict: 'asked', why: 'policy', question: 'Still open.' }),
    ])
    render(<PersonaModule />)

    await waitFor(() => expect(ledgerLine()).toBeTruthy())
    openLedger()

    expect(
      within(ledgerDetail()).getByText(
        `persona.ledger.ownerAnswered:{"date":"${dayLabel('2026-08-13T02:00:00.000Z')}"}`,
      ),
    ).toBeTruthy()
    // Exactly ONE row carries it — the stamp is evidence, not decoration.
    expect(
      within(ledgerDetail()).getAllByText(/persona\.ledger\.ownerAnswered/),
    ).toHaveLength(1)
  })

  it('shows the folder, never the home path — and never the correlation key', async () => {
    // `projectPath` is absolute under the owner's home and `key` is an opaque
    // join column. Neither is something the owner asked to see; one of them is
    // their home directory.
    ledgerPayload = ledgerOf({ week: counts(1, 0, 0), total: counts(1, 0, 0), lastAt: AT }, [
      ledgerEntry({ projectPath: '/Users/me/dev/billing-api', key: 'op4qu3-hash-key' }),
    ])
    render(<PersonaModule />)

    await waitFor(() => expect(ledgerLine()).toBeTruthy())
    openLedger()

    expect(within(ledgerDetail()).getByText(/billing-api/)).toBeTruthy()
    expect(document.body.textContent).not.toContain('/Users/me')
    expect(document.body.textContent).not.toContain('op4qu3-hash-key')
  })

  it('a reason class the build does not know is left unsaid, never printed as a slug', async () => {
    ledgerPayload = ledgerOf({ week: counts(0, 0, 1), total: counts(0, 0, 1), lastAt: AT }, [
      // The cast is the POINT, not a workaround. `why` is a union
      // (PersonaLedgerWhy), so no build can produce this value — but a ledger
      // written by a NEWER build can, and this screen reads that file. The type
      // pins what we emit; this pins what we survive.
      ledgerEntry({
        id: 'l-unknown',
        verdict: 'abstained',
        why: 'quantum' as PersonaLedgerWhy,
        question: 'Odd one.',
      }),
    ])
    render(<PersonaModule />)

    await waitFor(() => expect(ledgerLine()).toBeTruthy())
    openLedger()

    // The verdict already says what happened; a slug says nothing to anyone.
    expect(within(ledgerDetail()).getByText('persona.ledger.verdict.abstained')).toBeTruthy()
    expect(ledgerDetail().textContent).not.toContain('quantum')
  })

  // Measured on the portrait, 2026-08-14: the loader stored any 200 body and the
  // render path reached straight into it, so a bare `{}` from an older server
  // threw inside render and blanked the whole panel. This route is newer than
  // the screen, so that body is what a not-yet-updated server actually sends.
  it('a 200 that is NOT a ledger renders nothing — and takes nothing else down', async () => {
    ledgerPayload = {}
    render(<PersonaModule />)

    expect(await screen.findByText('persona.tabLabel')).toBeTruthy()
    expect(await awaitCourses()).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'persona.ledger.label' })).toBeNull()
  })

  it('a ledger that could not be read says NOTHING — not that nothing happened', async () => {
    // Same rule as the portrait and the figure: "it has never spoken for you" is
    // a claim, and a failed read is in no position to make it.
    ledgerPayload = null
    render(<PersonaModule />)

    expect(await awaitCourses()).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'persona.ledger.label' })).toBeNull()
    expect(screen.queryByText('persona.ledger.week')).toBeNull()
  })

  it('reads in the same one place a note does — never two cards at once', async () => {
    judgmentsPayload = [judgment({ text: 'Price on value.' })]
    ledgerPayload = ledgerOf({ week: counts(1, 0, 0), total: counts(1, 0, 0), lastAt: AT }, [
      ledgerEntry({ question: 'Ship the price change tonight?' }),
    ])
    render(<PersonaModule />)

    await waitFor(() => expect(ledgerLine()).toBeTruthy())
    openLedger()
    expect(screen.getByText('Ship the price change tonight?')).toBeTruthy()

    // Opening a lit point takes the column back…
    openNode('Price on value.')
    expect(screen.queryByText('Ship the price change tonight?')).toBeNull()
    // (the note card is the thing in the column now — it is the only surface
    // that offers 直す)
    expect(screen.getByText('persona.correct.start')).toBeTruthy()

    // …and opening the ledger again takes it from the note.
    openLedger()
    expect(screen.getByText('Ship the price change tonight?')).toBeTruthy()
    expect(screen.queryByText('persona.correct.start')).toBeNull()
  })
})

// ─── RE-OPENING A FINISHED COURSE ───────────────────────────────────────────
//
// A result you can only see once is a result you did not get. The rail's 済
// entry reads the last one back in the same sheet the course ends on, and the
// re-read writes NOTHING — no submit, no mint, no re-score.
describe('PersonaModule — re-opening a finished course', () => {
  const NEWER = '2026-08-12T09:00:00.000Z'
  const OLDER = '2026-06-02T09:00:00.000Z'

  /** big5, taken twice with opposite answers ⇒ two genuinely different sheets. */
  const twoTakes = () => {
    const n = COURSES[0].itemCount
    return [take('big5', Array(n).fill(4), NEWER), take('big5', Array(n).fill(0), OLDER)]
  }

  const doneRail = (lastTakenAt = NEWER) =>
    coursesPayload({ big5: { lastTakenAt, headline: 'なにか' } })

  it('opens the LAST result, and writes nothing to do it', async () => {
    const takes = twoTakes()
    courses = doneRail()
    historyPayload = takes
    render(<PersonaModule />)
    await awaitCourses()

    fireEvent.click(railRow(COURSES[0].name))

    expect(await screen.findByText('persona.result.kicker')).toBeTruthy()
    // NEWEST FIRST is the API's contract, and the newest is what 「結果を見る」
    // promises.
    expect(screen.getByText(takes[0].result.headline)).toBeTruthy()
    expect(screen.queryByText(takes[1].result.headline)).toBeNull()
    // Read-only, and not "read-only-ish": the mock records every write path
    // (append / answer / skip / submit), and reading a result uses none.
    expect(posts).toEqual([])
  })

  // ── 前回から動いたところ (plan step 7) ────────────────────────────────────
  it('shows what MOVED against the previous take, both numbers and the difference', async () => {
    const takes = twoTakes()
    courses = doneRail()
    historyPayload = takes
    render(<PersonaModule />)
    await awaitCourses()
    fireEvent.click(railRow(COURSES[0].name))
    await screen.findByText('persona.result.kicker')

    expect(screen.getByText('persona.delta.heading')).toBeTruthy()
    // The two takes answered 4 and 0 to every item, so every factor moved by the
    // full width — and BOTH numbers are printed, not just the movement.
    expect(screen.getByText(/persona\.delta\.since/)).toBeTruthy()
    expect(screen.getAllByText(/^\d+% → \d+%$/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/^\+\d+$/).length).toBeGreaterThan(0)
    // ⚠ AND NOT ONE WORD ABOUT WHAT IT MEANS — the caveat is what stands in for
    // the interpretation this app refuses to write.
    expect(screen.getByText('persona.delta.caveat')).toBeTruthy()
    expect(screen.queryByText('persona.delta.only')).toBeNull()
  })

  it('⚠ COMPARES EACH SHEET WITH WHAT CAME BEFORE IT, not with the newest', async () => {
    // Walking back through the strip and seeing every old sheet measured against
    // TODAY would print movements that run backwards through time.
    const takes = twoTakes()
    courses = doneRail()
    historyPayload = takes
    render(<PersonaModule />)
    await awaitCourses()
    fireEvent.click(railRow(COURSES[0].name))
    await screen.findByText('persona.result.takes')

    // Step back to the OLDEST take: it has nothing before it.
    fireEvent.click(screen.getByRole('button', { name: dayLabel(OLDER) }))
    await waitFor(() => expect(screen.getByText('persona.delta.only')).toBeTruthy())
    expect(screen.queryByText('persona.delta.caveat')).toBeNull()
  })

  it('says there is nothing to compare when a course was taken ONCE', async () => {
    // ⚠ THE SECTION IS PRESENT AND SAYS SO, rather than being absent. 「これしか
    // 無い」 is a fact about the record; an absent section is a question left
    // hanging over a screen full of numbers.
    const n = COURSES[0].itemCount
    courses = doneRail()
    historyPayload = [take('big5', Array(n).fill(4), NEWER)]
    render(<PersonaModule />)
    await awaitCourses()
    fireEvent.click(railRow(COURSES[0].name))
    await screen.findByText('persona.result.kicker')

    expect(screen.getByText('persona.delta.heading')).toBeTruthy()
    expect(screen.getByText('persona.delta.only')).toBeTruthy()
  })

  it('⚠ THE COURSES PANEL STEPS OFF UNDER THE SHEET it was opened from', async () => {
    // Found on the running app: the sheet is z-overlay-local (20) and the
    // reading column is z-30, so the list of courses drew ON TOP of the result.
    // Class-level assertion for the usual reason — jsdom loads no stylesheet.
    const takes = twoTakes()
    courses = doneRail()
    historyPayload = takes
    render(<PersonaModule />)
    await awaitCourses()
    fireEvent.click(railRow(COURSES[0].name))
    await screen.findByText('persona.result.kicker')

    expect(screen.getByTestId('persona-reading').className).toContain('hidden')
  })

  // ── tapping the empty stage puts the reading down ─────────────────────────
  // Owner, 2026-08-17: 「モーダル系はモーダル外をタップすると閉じる仕様にしてね。全部」.
  // Every other surface gets this from the Overlay shell (Overlay.test.tsx);
  // the reading column is a card floating on the stage with no backdrop of its
  // own, so it needs the rule spelt out.
  //
  // The two 「…DOES NOT TAKE…」 tests below are not guarding a check — there is
  // no check. The composer and a running course own the column outright, so
  // clearing `reading` under them does nothing. What those two DO catch is the
  // obvious next refactor: "make the tap close everything", i.e. clearing
  // `correcting` / `run` here too. Both were measured red against exactly that.
  //
  // The gesture is a real pointer press on the figure's host: the canvas picks
  // nothing in jsdom (no 2D context), which is exactly the "you pressed empty
  // stage" branch.
  const tapEmptyStage = () => {
    const host = document.querySelector('.touch-none') as HTMLElement
    fireEvent.pointerDown(host, { button: 0, clientX: 5, clientY: 5, pointerId: 1 })
    fireEvent.pointerUp(host, { button: 0, clientX: 5, clientY: 5, pointerId: 1 })
  }

  it('a tap on the empty stage closes the courses panel', async () => {
    courses = doneRail()
    render(<PersonaModule />)
    await awaitCourses()

    tapEmptyStage()

    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'persona.course.railHeading' })).toBeNull(),
    )
  })

  it('⚠ IT DOES NOT TAKE A HALF-WRITTEN CORRECTION', async () => {
    // The composer sits in the same column. Discarding typed text on a stray
    // tap is the one way this convenience could cost something real — cancelling
    // is a button, and it stays a button.
    render(<PersonaModule />)
    const note = judgment()
    await screen.findByRole('button', { name: note.text })
    startCorrecting(note.text)
    typeNote('書きかけの訂正')

    tapEmptyStage()

    expect(
      (screen.getByPlaceholderText('persona.correct.placeholder') as HTMLTextAreaElement).value,
    ).toBe('書きかけの訂正')
  })

  it('⚠ IT DOES NOT TAKE A COURSE IN FLIGHT', async () => {
    courses = coursesPayload()
    render(<PersonaModule />)
    await awaitCourses()
    fireEvent.click(railRow(COURSES[0].name))
    await screen.findByText(BIG5_ITEMS[0][2])

    tapEmptyStage()

    expect(screen.getByText(BIG5_ITEMS[0][2])).toBeTruthy()
  })

  it('walks the takes with a date strip, newest first, marking the one on screen', async () => {
    const takes = twoTakes()
    courses = doneRail()
    historyPayload = takes
    render(<PersonaModule />)
    await awaitCourses()

    fireEvent.click(railRow(COURSES[0].name))
    await screen.findByText('persona.result.takes')

    const strip = screen.getAllByRole('button', { name: /^[A-Z][a-z]{2} \d+$/ })
    expect(strip.map((b) => b.textContent)).toEqual([dayLabel(NEWER), dayLabel(OLDER)])
    expect(screen.getByRole('button', { name: dayLabel(NEWER) }).getAttribute('aria-current')).toBe('true')
    expect(screen.getByRole('button', { name: dayLabel(OLDER) }).getAttribute('aria-current')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: dayLabel(OLDER) }))

    // The OTHER take is on screen now — headline and mark both moved.
    expect(screen.getByText(takes[1].result.headline)).toBeTruthy()
    expect(screen.queryByText(takes[0].result.headline)).toBeNull()
    expect(screen.getByRole('button', { name: dayLabel(OLDER) }).getAttribute('aria-current')).toBe('true')
    expect(screen.getByRole('button', { name: dayLabel(NEWER) }).getAttribute('aria-current')).toBeNull()
    // Still a read: switching takes is not a re-score.
    expect(posts).toEqual([])
  })

  it('draws no strip at all for a course taken once', async () => {
    courses = doneRail()
    historyPayload = [take('big5', Array(COURSES[0].itemCount).fill(4), NEWER)]
    render(<PersonaModule />)
    await awaitCourses()

    fireEvent.click(railRow(COURSES[0].name))
    await screen.findByText('persona.result.kicker')

    // A strip of one is furniture that implies there is somewhere else to go.
    expect(screen.queryByText('persona.result.takes')).toBeNull()
    expect(screen.queryAllByRole('button', { name: /^[A-Z][a-z]{2} \d+$/ })).toHaveLength(0)
  })

  it('「もう一度やる」 from the sheet starts the course at item 1', async () => {
    courses = doneRail()
    historyPayload = twoTakes()
    render(<PersonaModule />)
    await awaitCourses()

    fireEvent.click(railRow(COURSES[0].name))
    await screen.findByText('persona.result.kicker')
    fireEvent.click(screen.getByText('persona.result.again'))

    expect(screen.queryByText('persona.result.kicker')).toBeNull()
    expect(screen.getByText(BIG5_ITEMS[0][2])).toBeTruthy()
    expect(screen.getByText(`1 / ${BIG5_ITEMS.length}`)).toBeTruthy()
    // A re-take is a NEW observation: nothing of the take being read carries in.
    expect(posts).toEqual([])
  })

  // The rail has to hold both offers, because they are different intentions.
  // Making someone read their old result to get to the questions is the version
  // that gets described as "it makes you click through a wall of text".
  // ONE BUTTON PER ROW (2026-08-15). The 済 row used to carry a second
  // 「もう一度」 control beside it; the corner is a quiet list now, and re-taking
  // lives inside the sheet the row opens (`persona.result.again`, covered
  // above). This pins that the second control really is gone — a row that still
  // grew one would put the corner back where it was.
  it('a finished row offers exactly ONE control — reading the result back', async () => {
    courses = doneRail()
    historyPayload = twoTakes()
    render(<PersonaModule />)
    await awaitCourses()

    expect(screen.queryByText('persona.course.retake')).toBeNull()
    const row = railRow(COURSES[0].name)
    expect(row.textContent).toContain('persona.course.state.done')

    fireEvent.click(row)
    // …and it reads, rather than starting a fresh take over the old result.
    expect(await screen.findByText('persona.result.kicker')).toBeTruthy()
    expect(screen.queryByText(BIG5_ITEMS[0][2])).toBeNull()
  })

  it('says the past result could not be opened rather than opening an empty sheet', async () => {
    courses = doneRail()
    historyFails = true
    render(<PersonaModule />)
    await awaitCourses()

    fireEvent.click(railRow(COURSES[0].name))

    expect(await screen.findByText('persona.course.historyFailed')).toBeTruthy()
    expect(screen.queryByText('persona.result.kicker')).toBeNull()
  })

  // 済 on the rail with nothing stored is a disagreement between two server
  // reads. The sheet is not the place to paper over it.
  it('does not open a sheet when the history comes back empty', async () => {
    courses = doneRail()
    historyPayload = []
    render(<PersonaModule />)
    await awaitCourses()

    fireEvent.click(railRow(COURSES[0].name))

    expect(await screen.findByText('persona.course.historyFailed')).toBeTruthy()
    expect(screen.queryByText('persona.result.kicker')).toBeNull()
  })

  it('a never-taken course still starts the course when its row is clicked', async () => {
    // The 済 row changed; the plain one must not have.
    render(<PersonaModule />)
    await awaitCourses()

    fireEvent.click(railRow(COURSES[0].name))
    expect(screen.getByText(BIG5_ITEMS[0][2])).toBeTruthy()
    expect(screen.queryByText('persona.result.kicker')).toBeNull()
  })
})

describe('helpers', () => {
  it('parseTags splits on commas of either width and drops the empties', () => {
    expect(parseTags('a, b、 c，d')).toEqual(['a', 'b', 'c', 'd'])
    expect(parseTags('  ')).toEqual([])
    expect(parseTags('one,,two,')).toEqual(['one', 'two'])
  })

  it('quoteForCorrection passes a short note through untouched', () => {
    expect(quoteForCorrection('short')).toBe('short')
  })

  it('quoteForCorrection caps a long note so a correction chain cannot balloon', () => {
    const long = 'x'.repeat(500)
    const quoted = quoteForCorrection(long)
    expect(quoted.length).toBe(281) // 280 + the ellipsis
    expect(quoted.endsWith('…')).toBe(true)
  })

  it('courseRailState separates never-taken / running / done', () => {
    expect(courseRailState({ id: 'big5', lastTakenAt: null }, null)).toBe('new')
    expect(courseRailState({ id: 'big5', lastTakenAt: null }, 'big5')).toBe('running')
    expect(courseRailState({ id: 'big5', lastTakenAt: '2026-08-01' }, null)).toBe('done')
    // Running wins over done: a retake in progress must not read as finished.
    expect(courseRailState({ id: 'big5', lastTakenAt: '2026-08-01' }, 'big5')).toBe('running')
  })

})

describe('where a note lands on the figure (pure)', () => {
  it('puts a course finding in the region that course grows', () => {
    for (const c of COURSES) {
      const j = judgment({ id: `j-${c.id}`, tags: ['persona', c.id], context: `${c.name} ・ 1位` })
      expect(courseIdFromJudgment(j)).toBe(c.id)
      expect(placeJudgment(j)).toEqual({ region: COURSE_REGION[c.id], placed: true })
    }
  })

  it('reads the course out of a prefixed tag too (the server owns its prefix)', () => {
    expect(courseIdFromJudgment({ tags: ['persona:big5'] })).toBe('big5')
    expect(courseIdFromJudgment({ tags: ['course-work'] })).toBe('work')
    // …and falls back to the course NAME carried in the provenance line.
    expect(courseIdFromJudgment({ context: `${COURSES[1].name} ・ 外向 ↔ 内向` })).toBe(COURSES[1].id)
    expect(courseIdFromJudgment({ tags: ['pricing'], context: 'from a call' })).toBeNull()
  })

  it('lands an interview answer in the patch its question was digging in', () => {
    // personaInterview.ts writes the answer back tagged ['interview', kind], so
    // the point that lights up is the one that was pulsing while it was asked.
    //
    // ONE id for all nine kinds, deliberately: if the kind tag were ignored,
    // every answer below would fall into the same hashed region, and no single
    // region can satisfy nine kinds that span five. (Measured — with the kind
    // lookup removed, a single-kind version of this test still passed by hash
    // coincidence. A guard that green-lights the bug it exists to catch is
    // worse than none.)
    for (const kind of QUESTION_KINDS) {
      const answer = judgment({ id: 'j-int', tags: ['interview', kind] })
      expect(placeJudgment(answer)).toEqual({
        region: regionForQuestion(question({ kind })),
        placed: true,
      })
    }
  })

  it('spreads a free-form note deterministically — the same note never moves', () => {
    const j = judgment({ id: 'j-free', tags: ['pricing'] })
    const first = placeJudgment(j).region
    expect(placeJudgment(j).region).toBe(first)
    expect(placeJudgment({ ...j }).region).toBe(first)
    // Different notes do not all pile into one region. (The STRONG version of
    // this — the spread never reaches the halo — is in regions.test.ts; a
    // `size > 1` check passes a five-region spread just as happily.)
    const regions = new Set(
      Array.from({ length: 40 }, (_, i) => placeJudgment(judgment({ id: `j-${i}` })).region),
    )
    expect(regions.size).toBeGreaterThan(1)
  })

  it('personaHash is stable and unsigned (a negative index would seat nothing)', () => {
    expect(personaHash('abc')).toBe(personaHash('abc'))
    expect(personaHash('abc')).not.toBe(personaHash('abd'))
    for (const s of ['', 'a', '日本語', 'j-1']) {
      expect(personaHash(s)).toBeGreaterThanOrEqual(0)
      expect(Number.isInteger(personaHash(s))).toBe(true)
    }
  })

  it('buildPersonaNodes carries the whole note, not just its text', () => {
    const nodes = buildPersonaNodes([
      judgment({ id: 'j-1', text: 'A.', tags: ['x'], context: 'ctx', correctsId: 'j-0' }),
      judgment({ id: 'j-2', text: 'B.' }),
    ])
    expect(nodes.map((n) => n.id)).toEqual(['j-1', 'j-2'])
    expect(nodes[0]).toMatchObject({ text: 'A.', tags: ['x'], context: 'ctx', correctsId: 'j-0' })
    expect(nodes[1].tags).toEqual([])
    expect(nodes[1].context).toBeUndefined()
  })

  it('every question kind has a region (a new kind must not fall off the body)', () => {
    for (const kind of QUESTION_KINDS) {
      expect(regionForQuestion(question({ kind }))).toBeTruthy()
    }
    expect(regionForQuestion(null)).toBeNull()
  })
})

// THE DAY'S QUESTION IS THE CONVERSATION'S OPENING TURN (2026-08-15). It used
// to be a fourth card in the bottom-right corner; the owner asked for less text
// on this stage, and a question is a thing being said to you — so it is said in
// the place things are said, and the next thing typed answers it.
describe('PersonaModule — the always-on question', () => {
  const answerBox = () => talkInput()

  it('shows the question drawn from the owner’s own week', async () => {
    questionPayload = question()
    render(<PersonaModule />)
    await waitFor(() => expect(screen.getByText('persona.interview.heading')).toBeInTheDocument())
    // `lang` is stubbed to 'en', so the English rendering is the one shown.
    expect(screen.getByText(question().textEn)).toBeInTheDocument()
  })

  it('GENERATES through a POST — a read must never mint the day’s question', async () => {
    questionPayload = question()
    render(<PersonaModule />)
    await waitFor(() => expect(screen.getByText(question().textEn)).toBeInTheDocument())
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
    const interview = calls.find((c) => c[0] === '/api/you-corpus/interview')
    expect(interview).toBeTruthy()
    expect((interview?.[1] as RequestInit | undefined)?.method).toBe('POST')
  })

  // A day with nothing to ask now says NOTHING — the four lines it used to
  // spend announcing its own absence were text on a stage the owner asked to
  // keep quiet, and the rotating placeholder already invites.
  it('says nothing at all on a day with no question', async () => {
    questionPayload = null
    render(<PersonaModule />)
    await screen.findByText('persona.intro.lead')
    expect(screen.queryByText('persona.interview.heading')).not.toBeInTheDocument()
    // …and the way in is still there.
    expect(talkInput()).toBeTruthy()
  })

  // "No question today" is a CLAIM. A read that failed may not make it — and it
  // may not silently swallow the next thing typed into the interview route
  // either, which is why `questionLoaded` gates the question prop.
  it('does NOT claim there is no question when the read simply failed', async () => {
    questionFails = true
    render(<PersonaModule />)
    // The rest of the screen still loads, so this is a real assertion about the
    // question rather than about an unmounted component.
    await awaitCourses()
    expect(screen.queryByText('persona.interview.heading')).not.toBeInTheDocument()
    // What the owner types goes to the CONVERSATION, never to an interview
    // route for a question that was never read.
    say('何か話す')
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].url).toBe('/api/persona/chat')
  })

  it('sends the answer with the question’s id and shows it landed', async () => {
    questionPayload = question()
    render(<PersonaModule />)
    await waitFor(() => expect(screen.getByText(question().textEn)).toBeInTheDocument())
    say('可逆だから即決した')

    await waitFor(() =>
      expect(screen.getByText('persona.interview.answered')).toBeInTheDocument(),
    )
    expect(posts).toContainEqual({
      url: '/api/you-corpus/interview/answer',
      id: 'q-1',
      answer: '可逆だから即決した',
    })
    // The words the owner typed are still on screen as their own bubble.
    expect(screen.getByText('可逆だから即決した')).toBeInTheDocument()
    // Answered ⇒ the question is spent, so the skip offer is gone…
    expect(screen.queryByText('persona.interview.skip')).not.toBeInTheDocument()
    // …and the NEXT thing typed goes to the stand-in, not to the answer route.
    say('つぎの話')
    await waitFor(() => expect(posts.some((p) => p.url === '/api/persona/chat')).toBe(true))
  })

  it('will not send an empty answer', async () => {
    questionPayload = question()
    render(<PersonaModule />)
    await waitFor(() => expect(screen.getByText(question().textEn)).toBeInTheDocument())
    say('   ')
    expect(posts).toHaveLength(0)
  })

  it('KEEPS the words when the save fails, instead of pretending it saved', async () => {
    questionPayload = question()
    resolveFails = true
    render(<PersonaModule />)
    await waitFor(() => expect(screen.getByText(question().textEn)).toBeInTheDocument())
    say('失われてはいけない答え')

    await waitFor(() => expect(screen.getByText('persona.chat.turnFailed')).toBeInTheDocument())
    // The one thing this surface must never do is cost the owner their words:
    // they are still on screen, in their own bubble, with a retry under them.
    expect(screen.getByText('失われてはいけない答え')).toBeInTheDocument()
    expect(screen.getByText('persona.chat.retry')).toBeInTheDocument()
    expect(screen.queryByText('persona.interview.answered')).not.toBeInTheDocument()

    // And retrying really re-sends the SAME words to the SAME route — the
    // question never moved off 'open'.
    // (the failed attempt never reached the server's recorder — it 500'd — so
    //  the ONE post below is the retry, carrying the words back unchanged.)
    resolveFails = false
    fireEvent.click(screen.getByText('persona.chat.retry'))
    await waitFor(() =>
      expect(posts.filter((p) => p.url === '/api/you-corpus/interview/answer')).toHaveLength(1),
    )
    expect(posts[0]).toEqual({
      url: '/api/you-corpus/interview/answer',
      id: 'q-1',
      answer: '失われてはいけない答え',
    })
    expect(await screen.findByText('persona.interview.answered')).toBeInTheDocument()
  })

  it('skipping records the pass and does not write to the corpus', async () => {
    questionPayload = question()
    render(<PersonaModule />)
    await waitFor(() => expect(screen.getByText(question().textEn)).toBeInTheDocument())
    fireEvent.click(screen.getByText('persona.interview.skip'))

    await waitFor(() => expect(screen.getByText('persona.interview.skipped')).toBeInTheDocument())
    expect(posts).toContainEqual({ url: '/api/you-corpus/interview/skip', id: 'q-1' })
    expect(posts.some((p) => p.url === '/api/you-corpus/append')).toBe(false)
  })

  // ⚠ THIS TEST USED TO ASSERT THE OPPOSITE — that a cold load onto an answered
  // question drew 「保存しました」 and the question with it. That is the standing
  // panel the owner cut (2026-08-16: 「答えたらずっと表示する必要なくない?」): the
  // loop asks once a day, so an answered question is finished business and a
  // reload at 22:00 has nothing to report about it. The receipt is an event
  // shown to whoever was watching, never a state re-announced on mount — see
  // the phases block in PersonaConversation.test.tsx.
  it('an already-answered question is simply OVER — the reload says nothing of it', async () => {
    questionPayload = question({ status: 'answered', resolvedAt: '2026-07-19T05:00:00.000Z' })
    render(<PersonaModule />)
    // Waited on a landmark that DOES appear, so this is not green merely because
    // the screen had not finished loading.
    await screen.findByText('persona.tabLabel')
    await waitFor(() => expect(screen.getByLabelText('persona.chat.inputLabel')).toBeTruthy())

    expect(screen.queryByText('persona.interview.answered')).not.toBeInTheDocument()
    expect(screen.queryByText(question().textEn)).not.toBeInTheDocument()
    expect(screen.queryByText('persona.interview.heading')).not.toBeInTheDocument()
    expect(screen.queryByText('persona.interview.skip')).not.toBeInTheDocument()
  })

  // THE IME CONTRACT, inverted from the old card on purpose: the conversation's
  // input is one line and Enter sends it, so the guard is `isComposing` — the
  // Enter that CONFIRMS a Japanese conversion must never post half a sentence.
  it('sends on Enter but never on the Enter that confirms an IME conversion', async () => {
    questionPayload = question()
    render(<PersonaModule />)
    await waitFor(() => expect(screen.getByText(question().textEn)).toBeInTheDocument())
    fireEvent.change(answerBox(), { target: { value: '答え' } })

    fireEvent.keyDown(answerBox(), { key: 'Enter', isComposing: true })
    expect(posts).toHaveLength(0)

    fireEvent.keyDown(answerBox(), { key: 'Enter' })
    await waitFor(() => expect(posts).toHaveLength(1))
  })
})

describe('PersonaModule — the question, honest about what actually landed', () => {
  it('does NOT say the stand-in has the answer when the corpus was not rebuilt', async () => {
    // appendJudgment stores the judgment but does not throw when the file the
    // stand-in reads cannot be rebuilt. Claiming "your stand-in has this now"
    // over that is the exact false reassurance the note form already avoids.
    questionPayload = question()
    answerCorpusStale = true
    render(<PersonaModule />)
    await waitFor(() => expect(screen.getByText(question().textEn)).toBeInTheDocument())
    say('答え')

    await waitFor(() => expect(screen.getByText('persona.meta.stale')).toBeInTheDocument())
    // THE ASSERTION THAT MATTERS. Warning-is-present alone is toothless: the
    // false claim sat right next to the warning and this test still passed.
    expect(screen.queryByText('persona.interview.answered')).not.toBeInTheDocument()
    // ...and the owner is told the honest version instead of nothing at all —
    // their answer IS saved, it just has not reached the stand-in yet.
    expect(screen.getByText('persona.interview.answeredStale')).toBeInTheDocument()
  })

  it('DOES say the stand-in has it when the corpus really was rebuilt', async () => {
    // The other half of the pin: if the honest-but-hedged wording were shown
    // unconditionally, the loop would deny every save that actually worked.
    questionPayload = question()
    render(<PersonaModule />)
    await waitFor(() => expect(screen.getByText(question().textEn)).toBeInTheDocument())
    say('答え')

    await waitFor(() => expect(screen.getByText('persona.interview.answered')).toBeInTheDocument())
    expect(screen.queryByText('persona.interview.answeredStale')).not.toBeInTheDocument()
  })

  it('a stale NOTE does not make a healthy ANSWER deny itself', async () => {
    // The staleness banner is shared with the note form, so keying the answer's
    // wording off it would let an earlier failed note rewrite the confirmation
    // of an answer that landed perfectly.
    appendSkipped = true
    questionPayload = question()
    judgmentsPayload = [judgment({ id: 'j-old', text: 'Old call.' })]
    render(<PersonaModule />)
    await waitFor(() => expect(screen.getByText(question().textEn)).toBeInTheDocument())

    // A correction first — it stores, but the corpus is not rebuilt.
    startCorrecting('Old call.')
    typeNote('メモ')
    fireEvent.click(screen.getByText('persona.correct.submit'))
    await waitFor(() => expect(screen.getByText('persona.meta.stale')).toBeInTheDocument())

    // Now the answer, which the server reports as fully landed.
    say('答え')

    await waitFor(() => expect(screen.getByText('persona.interview.answered')).toBeInTheDocument())
    expect(screen.queryByText('persona.interview.answeredStale')).not.toBeInTheDocument()
  })

  it('a failed SKIP does not tell the owner their answer is still here', async () => {
    // There is no answer on the skip path — the answer-path wording would be
    // nonsense.
    questionPayload = question()
    resolveFails = true
    render(<PersonaModule />)
    await waitFor(() => expect(screen.getByText(question().textEn)).toBeInTheDocument())
    fireEvent.click(screen.getByText('persona.interview.skip'))

    await waitFor(() => expect(screen.getByText('persona.interview.skipFailed')).toBeInTheDocument())
    // No bubble, no retry: there were no words on the skip path, so the wording
    // that promises they are still here would be nonsense.
    expect(screen.queryByText('persona.chat.turnFailed')).not.toBeInTheDocument()
    expect(screen.queryByText('persona.chat.retry')).not.toBeInTheDocument()
  })
})

// ─── THE POLL MUST NOT WEAR THE SCREEN OUT ──────────────────────────────────
//
// Two module-side halves of the owner's 「スクロールも適当な感じ」 report
// (2026-08-17). The component now follows only a reader who is at the bottom —
// but the MODULE was re-minting the importJob object every 500ms tick, so the
// thread's append-effect fired twice a second for the whole distillation:
// scrolling was fought all the way up, and after the fix it would still have
// raised the 「↓ 最新へ」 pill over content that never changed. And one dropped
// POLL painted minutes of real server-side work as a failed import.
describe('PersonaModule — the import poll is not the screen’s enemy', () => {
  const doneResult = () => ({
    conversations: 2,
    ownerMessages: 5,
    unreadable: 0,
    droppedNonOwner: 4,
    considered: 5,
    notConsidered: 0,
    kept: [keptWrite()],
    duplicatesSkipped: 0,
    keptUnreadable: 0,
  })
  const runningCounts = () => ({
    conversations: 2,
    ownerMessages: 5,
    unreadable: 0,
    droppedNonOwner: 4,
    considered: 5,
    notConsidered: 0,
  })
  const drop = (name = 'conversations.json') => {
    const file = new File(['[{"name":"a"}]'], name, { type: 'application/json' })
    fireEvent.drop(talkInput(), { dataTransfer: { files: [file] } })
  }

  it('an UNCHANGED running poll leaves a reader in history alone — no pill, no pull', async () => {
    importJobPayload = { state: 'running', elapsedMs: 0, counts: runningCounts() }
    render(<PersonaModule />)
    await screen.findByText('persona.tabLabel')
    drop()
    await screen.findByText('persona.import.considered:{"total":5,"count":5}', undefined, {
      timeout: 4000,
    })

    // Climb up into history, with stubbed geometry (jsdom lays nothing out).
    const el = screen.getByTestId('chat-thread')
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: 300 })
    Object.defineProperty(el, 'scrollTop', { configurable: true, writable: true, value: 100 })
    fireEvent.scroll(el)

    // Let at least three more identical polls land…
    const seen = importPolls
    await waitFor(() => expect(importPolls).toBeGreaterThanOrEqual(seen + 3), { timeout: 4000 })
    // …and nothing moved and nothing was announced: identical state is not
    // new content (unchangedRunningImport keeps the same object, so the
    // thread's append-effect never fires).
    expect(el.scrollTop).toBe(100)
    expect(screen.queryByText('persona.chat.jumpLatest')).toBeNull()
  })

  it('a BLINKED poll keeps polling — the import is on the server, not on this fetch', async () => {
    importPollFailures = 2
    importJobPayload = { state: 'done', elapsedMs: 900, result: doneResult() }
    render(<PersonaModule />)
    await screen.findByText('persona.tabLabel')
    drop()
    // Two 500s, then the truth: the receipt lands DONE, and the blink was
    // never spoken of.
    await screen.findByText('persona.import.notChat', undefined, { timeout: 5000 })
    expect(screen.queryByText('persona.import.failed')).toBeNull()
  })

  it(`${IMPORT_POLL_GRACE} consecutive misses IS a dead server — then, and only then, failed`, async () => {
    importPollFailures = Number.MAX_SAFE_INTEGER
    render(<PersonaModule />)
    await screen.findByText('persona.tabLabel')
    drop()
    await screen.findByText('persona.import.failed', undefined, { timeout: 10000 })
    // The grace was actually consumed, not skipped.
    expect(importPolls).toBeGreaterThanOrEqual(IMPORT_POLL_GRACE)
  }, 15000)

  it('the NEXT message clears a finished receipt — a receipt is not a resident', async () => {
    importJobPayload = { state: 'done', elapsedMs: 900, result: doneResult() }
    render(<PersonaModule />)
    await screen.findByText('persona.tabLabel')
    drop()
    await screen.findByText('persona.import.notChat', undefined, { timeout: 4000 })

    say('で、それはどういう意味?')
    // Gone at once — the conversation moved on, and the numbers had been read.
    expect(screen.queryByTestId('import-receipt')).toBeNull()
  })

  it('…but never a RUNNING one — it is still reporting', async () => {
    importJobPayload = { state: 'running', elapsedMs: 0, counts: runningCounts() }
    render(<PersonaModule />)
    await screen.findByText('persona.tabLabel')
    drop()
    await screen.findByText('persona.import.considered:{"total":5,"count":5}', undefined, {
      timeout: 4000,
    })

    say('とちゅうだけど聞きたい')
    expect(screen.getByTestId('import-receipt')).toBeTruthy()
  })
})

// ─── unchangedRunningImport — the comparator the poll leans on ──────────────
describe('unchangedRunningImport', () => {
  const countsOf = () => ({
    conversations: 2,
    ownerMessages: 5,
    unreadable: 1,
    droppedNonOwner: 4,
    considered: 5,
    notConsidered: 0,
  })
  const runningJob = () => ({
    fileName: 'conversations.json',
    state: 'running' as const,
    counts: countsOf(),
  })

  it('says UNCHANGED for the same file, still running, byte-identical counts', () => {
    expect(unchangedRunningImport(runningJob(), 'conversations.json', countsOf())).toBe(true)
  })

  it('says unchanged while BOTH sides are still count-less (parsing not landed)', () => {
    expect(
      unchangedRunningImport(
        { fileName: 'conversations.json', state: 'running' },
        'conversations.json',
        undefined,
      ),
    ).toBe(true)
  })

  it('counts LANDING is a change — the parse line must be allowed on screen', () => {
    expect(
      unchangedRunningImport(
        { fileName: 'conversations.json', state: 'running' },
        'conversations.json',
        countsOf(),
      ),
    ).toBe(false)
  })

  it('EVERY count field is compared — a drift in any one of them is a change', () => {
    const keys = Object.keys(countsOf()) as Array<keyof ReturnType<typeof countsOf>>
    expect(keys).toHaveLength(6)
    for (const key of keys) {
      const bumped = { ...countsOf(), [key]: countsOf()[key] + 1 }
      expect(unchangedRunningImport(runningJob(), 'conversations.json', bumped)).toBe(false)
    }
  })

  it('a different file, a finished state, or no previous job are all changes', () => {
    expect(unchangedRunningImport(runningJob(), 'other.json', countsOf())).toBe(false)
    expect(
      unchangedRunningImport(
        { ...runningJob(), state: 'done' as const },
        'conversations.json',
        countsOf(),
      ),
    ).toBe(false)
    expect(unchangedRunningImport(null, 'conversations.json', countsOf())).toBe(false)
  })
})

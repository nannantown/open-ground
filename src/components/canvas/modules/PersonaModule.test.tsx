// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, waitFor, screen } from '@testing-library/react'
import { PersonaModule, asZone, courseRailState, parseTags, quoteForCorrection } from './PersonaModule'
import {
  buildPersonaNodes,
  courseIdFromJudgment,
  personaHash,
  zoneForJudgment,
  zoneForQuestion,
} from './PersonaFigure'
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
import { messages } from '@/i18n/messages'
import type { ManualJudgment, PersonaQuestion, YouCorpusStatus } from '@/lib/types'

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
    zone: c.zone,
    itemCount: c.itemCount,
    source: c.source,
    lastTakenAt: null as string | null,
    headline: null as string | null,
    ...(over[c.id] ?? {}),
  }))

let statusPayload: YouCorpusStatus
let judgmentsPayload: ManualJudgment[]
let appendSkipped: boolean
let appendFails: boolean
let statusFails: boolean
let posts: Array<Record<string, unknown>>
let questionPayload: PersonaQuestion | null
let questionFails: boolean
let resolveFails: boolean
let answerCorpusStale: boolean
let courses: ReturnType<typeof coursesPayload>
let coursesFail: boolean
let submitFails: boolean
/** null ⇒ "every finding landed"; a number pins a partial mint. */
let mintedOverride: number | null

beforeEach(() => {
  // jsdom ships no 2D canvas context. The figure already handles that (it draws
  // nothing and everything else on the screen still works — which is why the
  // data lives outside it), so this only silences jsdom's not-implemented dump.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  statusPayload = status()
  judgmentsPayload = [judgment()]
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
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
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
        return new Response(JSON.stringify({ judgments: judgmentsPayload }), { status: 200 })
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

const openComposer = () => fireEvent.click(screen.getByText('persona.add.open'))

const typeNote = (text: string) => {
  const box = screen.getByPlaceholderText('persona.add.placeholder')
  fireEvent.change(box, { target: { value: text } })
  return box
}

const rail = (name: string) => screen.getByRole('button', { name: new RegExp(name) })

describe('PersonaModule — reading what the stand-in runs on', () => {
  it('says how much is in there: what it remembered and what you wrote', async () => {
    render(<PersonaModule />)
    await screen.findByText('persona.tabLabel')

    // The key carries the plural form: English says "1 note", not "1 notes".
    await waitFor(() =>
      expect(document.body.textContent).toContain('persona.meta.count.other:{"count":62}'),
    )
    expect(document.body.textContent).toContain('persona.meta.count.one:{"count":1}')
  })

  it('says so plainly when the corpus has never been assembled', async () => {
    statusPayload = status({ exists: false, assembledAt: null })
    render(<PersonaModule />)
    await waitFor(() => expect(document.body.textContent).toContain('persona.meta.never'))
  })

  it('opens one note with its provenance, tags and what it is based on', async () => {
    judgmentsPayload = [
      judgment({
        id: 'j-9',
        text: 'Ship before it is pretty.',
        tags: ['shipping'],
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
    expect(screen.getByText(/^persona\.zone\.\w+ ・ /)).toBeTruthy()
    // The raw ISO string is never shown to the owner.
    expect(screen.queryByText('2026-07-18T04:00:00.000Z')).toBeNull()

    fireEvent.click(screen.getByText('persona.node.close'))
    expect(screen.queryByText('persona.notes.basis')).toBeNull()
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
    expect(document.body.textContent).toContain('persona.meta.count.other:{"count":62}')
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

  // A failed REFRESH is different from a failed first read: notes already on
  // screen were read successfully once, so they stay lit. Only the "it is empty"
  // claim is withheld.
  it('keeps already-lit notes when a later refresh fails', async () => {
    judgmentsPayload = [judgment({ text: 'Loaded before the failure.' })]
    render(<PersonaModule />)
    await screen.findByRole('button', { name: 'Loaded before the failure.' })

    // The append lands; the re-read that follows it does not.
    statusFails = true
    openComposer()
    typeNote('A new note.')
    fireEvent.click(screen.getByText('persona.add.submit'))

    expect(await screen.findByText('persona.loadFailed')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Loaded before the failure.' })).toBeTruthy()
  })
})

describe('PersonaModule — adding to it', () => {
  it('will not submit an empty or whitespace-only note', async () => {
    render(<PersonaModule />)
    await screen.findByText('persona.add.open')
    openComposer()

    const submit = screen.getByText('persona.add.submit').closest('button')!
    expect(submit.disabled).toBe(true)

    typeNote('   ')
    expect(submit.disabled).toBe(true)

    typeNote('real content')
    expect(submit.disabled).toBe(false)
  })

  it('posts the note with its tags and lights it on the figure', async () => {
    render(<PersonaModule />)
    await screen.findByText('persona.add.open')
    openComposer()

    typeNote('Say no to features that need a manual.')
    fireEvent.change(screen.getByPlaceholderText('persona.add.tagsPlaceholder'), {
      target: { value: 'product, scope' },
    })
    fireEvent.click(screen.getByText('persona.add.submit'))

    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]).toEqual({
      text: 'Say no to features that need a manual.',
      tags: ['product', 'scope'],
    })
    // No `context` on a plain add — that field is the correction's pointer.
    expect(posts[0].context).toBeUndefined()

    // It is on the body now, not in a list somewhere.
    expect(
      await screen.findByRole('button', { name: 'Say no to features that need a manual.' }),
    ).toBeTruthy()
    // The composer closes and empties, so the next note starts clean.
    expect(screen.queryByPlaceholderText('persona.add.placeholder')).toBeNull()
    openComposer()
    expect((screen.getByPlaceholderText('persona.add.placeholder') as HTMLTextAreaElement).value).toBe('')
  })

  it('omits tags entirely when none were typed', async () => {
    render(<PersonaModule />)
    await screen.findByText('persona.add.open')
    openComposer()
    typeNote('No tags here.')
    fireEvent.click(screen.getByText('persona.add.submit'))

    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]).toEqual({ text: 'No tags here.' })
  })

  it('surfaces a write failure rather than pretending it saved', async () => {
    appendFails = true
    render(<PersonaModule />)
    await screen.findByText('persona.add.open')
    openComposer()

    typeNote('This will not land.')
    fireEvent.click(screen.getByText('persona.add.submit'))

    expect(await screen.findByText('persona.add.failed')).toBeTruthy()
    // The text is KEPT so the owner does not lose what they wrote.
    expect((screen.getByPlaceholderText('persona.add.placeholder') as HTMLTextAreaElement).value).toBe(
      'This will not land.',
    )
  })

  it('warns when the note landed but the corpus could not be rebuilt', async () => {
    appendSkipped = true
    render(<PersonaModule />)
    await screen.findByText('persona.add.open')
    openComposer()

    typeNote('Landed, but sources were unreadable.')
    fireEvent.click(screen.getByText('persona.add.submit'))

    expect(await screen.findByText('persona.meta.stale')).toBeTruthy()
  })

  // The IME contract: a bare Enter must reach the composition (it CONFIRMS a
  // Japanese conversion), so only the modified chord submits.
  it('submits on Cmd/Ctrl+Enter but never on a bare Enter', async () => {
    render(<PersonaModule />)
    await screen.findByText('persona.add.open')
    openComposer()
    const box = typeNote('IME safe?')

    fireEvent.keyDown(box, { key: 'Enter' })
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true })
    expect(posts).toHaveLength(0)

    fireEvent.keyDown(box, { key: 'Enter', metaKey: true })
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].text).toBe('IME safe?')
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
    judgmentsPayload = [judgment({ id: 'j-old', text: 'Old call.' })]
    render(<PersonaModule />)
    await screen.findByRole('button', { name: 'Old call.' })

    openComposer()
    typeNote('half-written thought I am not done with')
    openNode('Old call.')
    fireEvent.click(screen.getByText('persona.correct.start'))

    expect(
      (screen.getByPlaceholderText('persona.correct.placeholder') as HTMLTextAreaElement).value,
    ).toBe('half-written thought I am not done with')
  })

  it('does not overwrite tags the owner is already typing', async () => {
    judgmentsPayload = [judgment({ id: 'j-old', text: 'Old call.', tags: ['pricing'] })]
    render(<PersonaModule />)
    await screen.findByRole('button', { name: 'Old call.' })

    openComposer()
    fireEvent.change(screen.getByPlaceholderText('persona.add.tagsPlaceholder'), {
      target: { value: 'mine' },
    })
    openNode('Old call.')
    fireEvent.click(screen.getByText('persona.correct.start'))

    expect((screen.getByPlaceholderText('persona.add.tagsPlaceholder') as HTMLInputElement).value).toBe(
      'mine',
    )
  })

  it('cancelling drops the correction, not the words', async () => {
    judgmentsPayload = [judgment({ id: 'j-old', text: 'Old call.' })]
    render(<PersonaModule />)
    await screen.findByRole('button', { name: 'Old call.' })

    openNode('Old call.')
    fireEvent.click(screen.getByText('persona.correct.start'))
    fireEvent.change(screen.getByPlaceholderText('persona.correct.placeholder'), {
      target: { value: 'words worth keeping' },
    })
    fireEvent.click(screen.getByText('persona.correct.cancel'))

    openComposer()
    expect(screen.getByText('persona.add.heading')).toBeTruthy()
    expect((screen.getByPlaceholderText('persona.add.placeholder') as HTMLTextAreaElement).value).toBe(
      'words worth keeping',
    )
  })

  it('cancelling really drops the correction — the next note carries no pointer', async () => {
    judgmentsPayload = [judgment({ id: 'j-old', text: 'The note being corrected.' })]
    render(<PersonaModule />)
    await screen.findByRole('button', { name: 'The note being corrected.' })

    openNode('The note being corrected.')
    fireEvent.click(screen.getByText('persona.correct.start'))
    expect(screen.getByText('persona.correct.heading')).toBeTruthy()

    fireEvent.click(screen.getByText('persona.correct.cancel'))

    // The real contract: what gets written next is a PLAIN note, with no
    // `context` pointing at the note the owner decided not to correct.
    openComposer()
    typeNote('An unrelated new thought.')
    fireEvent.click(screen.getByText('persona.add.submit'))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]).toEqual({ text: 'An unrelated new thought.' })
  })
})

describe('PersonaModule — the courses', () => {
  it('renders every course the server offers, with what it costs and what it grows', async () => {
    render(<PersonaModule />)
    await screen.findByText('persona.course.railHeading')

    for (const c of COURSES) {
      expect(screen.getByRole('button', { name: new RegExp(c.name) })).toBeTruthy()
    }
    // A never-taken course states its length and the region it fills — the
    // owner decides whether to spend 25 questions BEFORE starting.
    expect(document.body.textContent).toContain(
      `persona.course.state.new:{"count":${COURSES[0].itemCount},"zone":"persona.zone.${COURSES[0].zone}"}`,
    )
  })

  it('names each course the way the SERVER named it, not from a local copy', async () => {
    // The rail is the catalogue the server sent (name / itemCount / zone), and
    // only the ITEMS come from the local instrument file. Printing COURSES here
    // would look identical on a matching build and drift silently on any other.
    courses = coursesPayload({ big5: { name: 'Renamed on the server' } })
    render(<PersonaModule />)
    await screen.findByText('persona.course.railHeading')
    expect(await screen.findByRole('button', { name: /Renamed on the server/ })).toBeTruthy()
  })

  it('shows the date instead of the price once a course has been taken', async () => {
    courses = coursesPayload({ big5: { lastTakenAt: '2026-08-01T09:00:00.000Z', headline: 'done' } })
    render(<PersonaModule />)
    await screen.findByText('persona.course.railHeading')
    await waitFor(() => expect(document.body.textContent).toContain('persona.course.state.done'))
  })

  it('says the courses could not be read rather than showing no courses at all', async () => {
    coursesFail = true
    render(<PersonaModule />)
    await screen.findByText('persona.course.railHeading')
    await waitFor(() => expect(screen.getByText('persona.loadFailed')).toBeTruthy())
    expect(screen.queryByRole('button', { name: new RegExp(COURSES[0].name) })).toBeNull()
  })

  it('starting a course asks item 1 of N, in the same card the question lives in', async () => {
    render(<PersonaModule />)
    await screen.findByText('persona.course.railHeading')

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
    await screen.findByText('persona.course.railHeading')

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
    await screen.findByText('persona.course.railHeading')

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
    await screen.findByText('persona.course.railHeading')

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
    await screen.findByText('persona.course.railHeading')

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
    await screen.findByText('persona.course.railHeading')

    const big5 = COURSES[0]
    fireEvent.click(rail(big5.name))
    for (let i = 0; i < big5.itemCount; i++) {
      fireEvent.click(screen.getByRole('button', { name: LIKERT_AGREE[0] }))
    }

    expect(await screen.findByText('persona.result.mintedPartial')).toBeTruthy()
  })

  it('a fully-minted result does NOT show the partial warning', async () => {
    render(<PersonaModule />)
    await screen.findByText('persona.course.railHeading')

    const big5 = COURSES[0]
    fireEvent.click(rail(big5.name))
    for (let i = 0; i < big5.itemCount; i++) {
      fireEvent.click(screen.getByRole('button', { name: LIKERT_AGREE[0] }))
    }

    await screen.findByText('persona.result.kicker')
    expect(screen.queryByText('persona.result.mintedPartial')).toBeNull()
  })

  it('quitting a course sends nothing and gives the day’s question back', async () => {
    questionPayload = question()
    render(<PersonaModule />)
    await screen.findByText('persona.course.railHeading')

    fireEvent.click(rail(COURSES[0].name))
    fireEvent.click(screen.getByRole('button', { name: LIKERT_AGREE[0] }))
    fireEvent.click(screen.getByText('persona.ask.quit'))

    expect(screen.getByText(question().textEn)).toBeTruthy()
    expect(posts.filter((p) => String(p.url ?? '').includes('/submit'))).toHaveLength(0)
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

  it('asZone refuses a region the figure does not have', () => {
    expect(asZone('craft')).toBe('craft')
    expect(asZone('elbow')).toBe('mind')
  })
})

describe('where a note lands on the figure (pure)', () => {
  it('puts a course finding in the region that course grows', () => {
    for (const c of COURSES) {
      const j = judgment({ id: `j-${c.id}`, tags: ['persona', c.id], context: `${c.name} ・ 1位` })
      expect(courseIdFromJudgment(j)).toBe(c.id)
      expect(zoneForJudgment(j)).toBe(c.zone)
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
      expect(zoneForJudgment(answer)).toBe(zoneForQuestion(question({ kind })))
    }
  })

  it('spreads a free-form note deterministically — the same note never moves', () => {
    const j = judgment({ id: 'j-free', tags: ['pricing'] })
    const first = zoneForJudgment(j)
    expect(zoneForJudgment(j)).toBe(first)
    expect(zoneForJudgment({ ...j })).toBe(first)
    // Different notes do not all pile into one region.
    const zones = new Set(
      Array.from({ length: 40 }, (_, i) => zoneForJudgment(judgment({ id: `j-${i}` }))),
    )
    expect(zones.size).toBeGreaterThan(1)
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
      expect(zoneForQuestion(question({ kind }))).toBeTruthy()
    }
    expect(zoneForQuestion(null)).toBeNull()
  })
})

describe('PersonaModule — the always-on question', () => {
  const answerBox = () => screen.getByPlaceholderText('persona.interview.placeholder')

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

  it('says plainly that there is nothing to ask today', async () => {
    questionPayload = null
    render(<PersonaModule />)
    await waitFor(() =>
      expect(screen.getByText('persona.interview.none.title')).toBeInTheDocument(),
    )
    expect(screen.getByText('persona.interview.none.body')).toBeInTheDocument()
  })

  it('does NOT claim there is no question when the read simply failed', async () => {
    questionFails = true
    render(<PersonaModule />)
    // The rest of the screen still loads, so this is a real assertion about the
    // question card rather than about an unmounted component.
    await waitFor(() => expect(screen.getByText('persona.course.railHeading')).toBeInTheDocument())
    expect(screen.queryByText('persona.interview.none.title')).not.toBeInTheDocument()
    expect(screen.queryByText('persona.interview.none.body')).not.toBeInTheDocument()
    // The card is still there — it is never a modal and never disappears — it
    // simply has nothing to claim.
    expect(screen.getByText('persona.ask.idle')).toBeInTheDocument()
  })

  it('sends the answer with the question’s id and shows it landed', async () => {
    questionPayload = question()
    render(<PersonaModule />)
    await waitFor(() => expect(answerBox()).toBeInTheDocument())
    fireEvent.change(answerBox(), { target: { value: '可逆だから即決した' } })
    fireEvent.click(screen.getByText('persona.interview.answer'))

    await waitFor(() =>
      expect(screen.getByText('persona.interview.answered')).toBeInTheDocument(),
    )
    expect(posts).toContainEqual({
      url: '/api/you-corpus/interview/answer',
      id: 'q-1',
      answer: '可逆だから即決した',
    })
    // Answered ⇒ the form is gone; the day's question is spent.
    expect(screen.queryByPlaceholderText('persona.interview.placeholder')).not.toBeInTheDocument()
  })

  it('will not send an empty answer', async () => {
    questionPayload = question()
    render(<PersonaModule />)
    await waitFor(() => expect(answerBox()).toBeInTheDocument())
    fireEvent.change(answerBox(), { target: { value: '   ' } })
    fireEvent.click(screen.getByText('persona.interview.answer'))
    expect(posts).toHaveLength(0)
  })

  it('KEEPS the words when the save fails, instead of pretending it saved', async () => {
    questionPayload = question()
    resolveFails = true
    render(<PersonaModule />)
    await waitFor(() => expect(answerBox()).toBeInTheDocument())
    fireEvent.change(answerBox(), { target: { value: '失われてはいけない答え' } })
    fireEvent.click(screen.getByText('persona.interview.answer'))

    await waitFor(() => expect(screen.getByText('persona.interview.failed')).toBeInTheDocument())
    // The one thing this surface must never do is cost the owner their words.
    expect((answerBox() as HTMLTextAreaElement).value).toBe('失われてはいけない答え')
    expect(screen.queryByText('persona.interview.answered')).not.toBeInTheDocument()
  })

  it('skipping records the pass and does not write to the corpus', async () => {
    questionPayload = question()
    render(<PersonaModule />)
    await waitFor(() => expect(answerBox()).toBeInTheDocument())
    fireEvent.click(screen.getByText('persona.interview.skip'))

    await waitFor(() => expect(screen.getByText('persona.interview.skipped')).toBeInTheDocument())
    expect(posts).toContainEqual({ url: '/api/you-corpus/interview/skip', id: 'q-1' })
    expect(posts.some((p) => p.url === '/api/you-corpus/append')).toBe(false)
  })

  it('an already-answered question comes back as answered, with no form', async () => {
    questionPayload = question({ status: 'answered', resolvedAt: '2026-07-19T05:00:00.000Z' })
    render(<PersonaModule />)
    await waitFor(() =>
      expect(screen.getByText('persona.interview.answered')).toBeInTheDocument(),
    )
    expect(screen.queryByPlaceholderText('persona.interview.placeholder')).not.toBeInTheDocument()
  })

  it('submits on Cmd/Ctrl+Enter but never on a bare Enter (IME-safe)', async () => {
    questionPayload = question()
    render(<PersonaModule />)
    await waitFor(() => expect(answerBox()).toBeInTheDocument())
    fireEvent.change(answerBox(), { target: { value: '答え' } })

    fireEvent.keyDown(answerBox(), { key: 'Enter' })
    expect(posts).toHaveLength(0)
    // The Enter that CONFIRMS a Japanese conversion must never be stolen.
    fireEvent.keyDown(answerBox(), { key: 'Enter', metaKey: true, isComposing: true })
    expect(posts).toHaveLength(0)

    fireEvent.keyDown(answerBox(), { key: 'Enter', metaKey: true })
    await waitFor(() => expect(posts).toHaveLength(1))
  })
})

describe('PersonaModule — the question, honest about what actually landed', () => {
  const answerBox = () => screen.getByPlaceholderText('persona.interview.placeholder')

  it('does NOT say the stand-in has the answer when the corpus was not rebuilt', async () => {
    // appendJudgment stores the judgment but does not throw when the file the
    // stand-in reads cannot be rebuilt. Claiming "your stand-in has this now"
    // over that is the exact false reassurance the note form already avoids.
    questionPayload = question()
    answerCorpusStale = true
    render(<PersonaModule />)
    await waitFor(() => expect(answerBox()).toBeInTheDocument())
    fireEvent.change(answerBox(), { target: { value: '答え' } })
    fireEvent.click(screen.getByText('persona.interview.answer'))

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
    await waitFor(() => expect(answerBox()).toBeInTheDocument())
    fireEvent.change(answerBox(), { target: { value: '答え' } })
    fireEvent.click(screen.getByText('persona.interview.answer'))

    await waitFor(() => expect(screen.getByText('persona.interview.answered')).toBeInTheDocument())
    expect(screen.queryByText('persona.interview.answeredStale')).not.toBeInTheDocument()
  })

  it('a stale NOTE does not make a healthy ANSWER deny itself', async () => {
    // The staleness banner is shared with the note form, so keying the answer's
    // wording off it would let an earlier failed note rewrite the confirmation
    // of an answer that landed perfectly.
    appendSkipped = true
    questionPayload = question()
    render(<PersonaModule />)
    await waitFor(() => expect(answerBox()).toBeInTheDocument())

    // A note first — it stores, but the corpus is not rebuilt.
    openComposer()
    typeNote('メモ')
    fireEvent.click(screen.getByText('persona.add.submit'))
    await waitFor(() => expect(screen.getByText('persona.meta.stale')).toBeInTheDocument())

    // Now the answer, which the server reports as fully landed.
    fireEvent.change(answerBox(), { target: { value: '答え' } })
    fireEvent.click(screen.getByText('persona.interview.answer'))

    await waitFor(() => expect(screen.getByText('persona.interview.answered')).toBeInTheDocument())
    expect(screen.queryByText('persona.interview.answeredStale')).not.toBeInTheDocument()
  })

  it('a failed SKIP does not tell the owner their answer is still here', async () => {
    // There is no answer on the skip path — the answer-path wording would be
    // nonsense.
    questionPayload = question()
    resolveFails = true
    render(<PersonaModule />)
    await waitFor(() => expect(answerBox()).toBeInTheDocument())
    fireEvent.click(screen.getByText('persona.interview.skip'))

    await waitFor(() => expect(screen.getByText('persona.interview.skipFailed')).toBeInTheDocument())
    expect(screen.queryByText('persona.interview.failed')).not.toBeInTheDocument()
  })
})

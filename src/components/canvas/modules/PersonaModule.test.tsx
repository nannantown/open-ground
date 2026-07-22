// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, waitFor, screen } from '@testing-library/react'
import { PersonaModule, parseTags, quoteForCorrection } from './PersonaModule'
import type { ManualJudgment, PersonaQuestion, YouCorpusStatus } from '@/lib/types'

// The Persona tab — UI-side contract only: it reads the corpus status + the
// hand-written notes, shows each note with its date/tags/basis, and writes new
// ones (including corrections) through POST /api/you-corpus/append. The server
// journey (assembly, the fail-safe, the loopback gate) is covered by
// youCorpus.test.ts + the route tests; here the fetch layer is stubbed.
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

beforeEach(() => {
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

const typeNote = (text: string) => {
  const box = screen.getByPlaceholderText('persona.add.placeholder')
  fireEvent.change(box, { target: { value: text } })
  return box
}

describe('PersonaModule — reading what the stand-in runs on', () => {
  it('shows the assembly meta: when it was last updated and how much fed it', async () => {
    render(<PersonaModule />)
    await screen.findByText('persona.meta.heading')

    // Every fact is a label → value row, so both counts read the same way.
    // The key carries the plural form: English says "1 note", not "1 notes".
    expect(screen.getByText('persona.meta.memory')).toBeTruthy()
    expect(screen.getByText('persona.meta.count.other:{"count":62}')).toBeTruthy()
    expect(screen.getByText('persona.meta.manual')).toBeTruthy()
    expect(screen.getByText('persona.meta.count.one:{"count":1}')).toBeTruthy()
    // Both mechanical sources resolved → both read as present.
    expect(screen.getAllByText('persona.meta.present')).toHaveLength(2)
  })

  it('says so plainly when the corpus has never been assembled', async () => {
    statusPayload = status({ exists: false, assembledAt: null })
    render(<PersonaModule />)
    expect(await screen.findByText('persona.meta.never')).toBeTruthy()
  })

  it('reports a missing source instead of implying it is there', async () => {
    statusPayload = status({ conceptExists: false, businessVisionExists: false })
    render(<PersonaModule />)
    await screen.findByText('persona.meta.heading')
    expect(screen.getAllByText('persona.meta.absent')).toHaveLength(2)
  })

  it('lists each hand-written note with its date, tags and basis', async () => {
    judgmentsPayload = [
      judgment({ id: 'j-9', text: 'Ship before it is pretty.', tags: ['shipping'], context: 'Learned the hard way.' }),
    ]
    render(<PersonaModule />)

    expect(await screen.findByText('Ship before it is pretty.')).toBeTruthy()
    expect(screen.getByText('shipping')).toBeTruthy()
    expect(screen.getByText('Learned the hard way.')).toBeTruthy()
    expect(screen.getByText('persona.notes.basis')).toBeTruthy()
    // The raw ISO string is never shown to the owner.
    expect(screen.queryByText('2026-07-18T04:00:00.000Z')).toBeNull()
  })

  it('invites the first note when there is nothing yet', async () => {
    judgmentsPayload = []
    render(<PersonaModule />)
    expect(await screen.findByText('persona.notes.empty.title')).toBeTruthy()
    expect(screen.getByText('persona.notes.empty.body')).toBeTruthy()
  })

  it('offers a retry when the read fails instead of an endless spinner', async () => {
    statusFails = true
    render(<PersonaModule />)
    expect(await screen.findByText('persona.loadFailed')).toBeTruthy()

    statusFails = false
    fireEvent.click(screen.getByText('persona.retry'))
    await waitFor(() => expect(screen.queryByText('persona.loadFailed')).toBeNull())
    expect(screen.getByText('persona.meta.heading')).toBeTruthy()
  })

  // "Nothing here yet" is a CLAIM about the corpus, and a failed read is not in
  // a position to make it. Rendered next to the error banner it says two
  // contradictory things at once, and the friendlier one is the one the owner
  // believes: that their corpus is empty. It is the wrong lie to tell on the
  // one surface whose entire job is to be an honest mirror.
  it('does NOT claim the corpus is empty when it simply could not be read', async () => {
    statusFails = true
    judgmentsPayload = []
    render(<PersonaModule />)

    expect(await screen.findByText('persona.loadFailed')).toBeTruthy()
    expect(screen.queryByText('persona.notes.empty.title')).toBeNull()
    expect(screen.queryByText('persona.notes.empty.body')).toBeNull()
    // Nor the heading it would sit under — an empty section reads as an answer
    // too.
    expect(screen.queryByText('persona.notes.heading')).toBeNull()

    // And once the read succeeds, the invitation is correct and comes back.
    statusFails = false
    fireEvent.click(screen.getByText('persona.retry'))
    expect(await screen.findByText('persona.notes.empty.title')).toBeTruthy()
  })

  // A failed REFRESH is different from a failed first read: notes already on
  // screen were read successfully once, so they stay. Only the "it is empty"
  // claim is withheld — withholding the notes too would lose the owner the
  // context they were reading.
  it('keeps already-loaded notes on screen when a later refresh fails', async () => {
    judgmentsPayload = [judgment({ text: 'Loaded before the failure.' })]
    render(<PersonaModule />)
    await screen.findByText('Loaded before the failure.')

    // The append lands; the re-read that follows it does not.
    statusFails = true
    typeNote('A new note.')
    fireEvent.click(screen.getByText('persona.add.submit'))

    expect(await screen.findByText('persona.loadFailed')).toBeTruthy()
    expect(screen.getByText('Loaded before the failure.')).toBeTruthy()
  })
})

describe('PersonaModule — the synapse map (graph view)', () => {
  it('defaults to the list — the map is an opt-in toggle, not a replacement', async () => {
    judgmentsPayload = [judgment({ text: 'Ship before it is pretty.' })]
    render(<PersonaModule />)
    await screen.findByText('Ship before it is pretty.')
    expect(screen.queryByRole('group', { name: 'persona.graph.heading' })).toBeNull()
  })

  it('switches to the graph and back without losing the notes', async () => {
    judgmentsPayload = [judgment({ id: 'j-9', text: 'Ship before it is pretty.' })]
    render(<PersonaModule />)
    await screen.findByText('Ship before it is pretty.')

    fireEvent.click(screen.getByText('persona.notes.viewGraph'))
    expect(screen.getByRole('group', { name: 'persona.graph.heading' })).toBeTruthy()
    // The list article is gone while the graph is showing…
    expect(screen.queryByText('persona.correct.start')).toBeNull()

    fireEvent.click(screen.getByText('persona.notes.viewList'))
    // …and comes back untouched on switching back.
    expect(await screen.findByText('Ship before it is pretty.')).toBeTruthy()
  })

  it('shows a plain empty-state instead of a blank graph when there is nothing to draw', async () => {
    judgmentsPayload = []
    render(<PersonaModule />)
    await screen.findByText('persona.notes.empty.title')

    fireEvent.click(screen.getByText('persona.notes.viewGraph'))
    expect(screen.getByText('persona.graph.empty.title')).toBeTruthy()
    expect(screen.getByText('persona.graph.empty.body')).toBeTruthy()
  })

  it('reading a note in the graph does not require touching the corpus (read-only)', async () => {
    judgmentsPayload = [
      judgment({ id: 'j-1', text: 'Price on value.', tags: ['pricing'] }),
      judgment({ id: 'j-2', text: 'Never ship on Friday.', tags: ['pricing'] }),
    ]
    render(<PersonaModule />)
    await screen.findByText('Price on value.')
    posts.length = 0

    fireEvent.click(screen.getByText('persona.notes.viewGraph'))
    // Clicking a node opens its detail panel…
    fireEvent.click(screen.getByText(/Price on value/))
    expect(await screen.findByText('persona.graph.close')).toBeTruthy()
    // …and never issues a write.
    expect(posts).toEqual([])
  })

  // A keyboard-only owner must be able to reach and read a node: it needs a
  // role, a tab stop, and an activation key — a bare SVG <g onClick> gives
  // none of those.
  it('is reachable and selectable from the keyboard, not only the mouse', async () => {
    judgmentsPayload = [judgment({ id: 'j-1', text: 'Price on value.' })]
    render(<PersonaModule />)
    await screen.findByText('Price on value.')
    fireEvent.click(screen.getByText('persona.notes.viewGraph'))

    const node = screen.getByRole('button', { name: 'Price on value.' })
    expect(node).toHaveAttribute('tabindex', '0')

    fireEvent.keyDown(node, { key: 'Enter' })
    expect(await screen.findByText('persona.graph.close')).toBeTruthy()

    fireEvent.click(screen.getByText('persona.graph.close'))
    expect(screen.queryByText('persona.graph.close')).toBeNull()

    // The space key activates it too (the other conventional "press this
    // button" key for a role="button" element).
    fireEvent.keyDown(node, { key: ' ' })
    expect(await screen.findByText('persona.graph.close')).toBeTruthy()
  })
})

describe('PersonaModule — adding to it', () => {
  it('will not submit an empty or whitespace-only note', async () => {
    render(<PersonaModule />)
    await screen.findByText('persona.add.heading')

    const submit = screen.getByText('persona.add.submit').closest('button')!
    expect(submit.disabled).toBe(true)

    typeNote('   ')
    expect(submit.disabled).toBe(true)

    typeNote('real content')
    expect(submit.disabled).toBe(false)
  })

  it('posts the note with its tags and shows it in the list', async () => {
    render(<PersonaModule />)
    await screen.findByText('persona.add.heading')

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

    expect(await screen.findByText('Say no to features that need a manual.')).toBeTruthy()
    // The form is emptied so the next note starts clean.
    expect((screen.getByPlaceholderText('persona.add.placeholder') as HTMLTextAreaElement).value).toBe('')
  })

  it('omits tags entirely when none were typed', async () => {
    render(<PersonaModule />)
    await screen.findByText('persona.add.heading')
    typeNote('No tags here.')
    fireEvent.click(screen.getByText('persona.add.submit'))

    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]).toEqual({ text: 'No tags here.' })
  })

  it('surfaces a write failure rather than pretending it saved', async () => {
    appendFails = true
    render(<PersonaModule />)
    await screen.findByText('persona.add.heading')

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
    await screen.findByText('persona.add.heading')

    typeNote('Landed, but sources were unreadable.')
    fireEvent.click(screen.getByText('persona.add.submit'))

    expect(await screen.findByText('persona.meta.stale')).toBeTruthy()
  })

  // The IME contract: a bare Enter must reach the composition (it CONFIRMS a
  // Japanese conversion), so only the modified chord submits.
  it('submits on Cmd/Ctrl+Enter but never on a bare Enter', async () => {
    render(<PersonaModule />)
    await screen.findByText('persona.add.heading')
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
    await screen.findByText('Always ship on Friday.')

    fireEvent.click(screen.getByText('persona.correct.start'))
    // The form switches to correction mode and quotes what is being corrected.
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

    // …and the original is still listed. Nothing is destroyed — the request was
    // an append, never a delete or an edit.
    expect(await screen.findByText('Never ship on Friday.')).toBeTruthy()
    expect(screen.getByText('Always ship on Friday.')).toBeTruthy()
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
    const methods = calls.map((c) => (c[1] as RequestInit | undefined)?.method ?? 'GET')
    expect(methods).not.toContain('DELETE')
    expect(methods).not.toContain('PUT')
    expect(methods).not.toContain('PATCH')
  })

  // One slot under a note holds two different things, and the label has to say
  // which: a correction carries the note it REPLACES, a plain note carries
  // where it came from. Calling a superseded note "where this came from" reads
  // as if the owner had cited it approvingly — the opposite of what happened.
  it('labels a correction’s pointer as a replacement, not as a source', async () => {
    judgmentsPayload = [
      judgment({ id: 'j-fix', text: 'The corrected version.', context: 'the old wording', correctsId: 'j-old' }),
      judgment({ id: 'j-cited', text: 'A note that cites its origin.', context: 'from a call last week' }),
    ]
    render(<PersonaModule />)
    await screen.findByText('The corrected version.')

    expect(screen.getByText('persona.notes.corrects')).toBeTruthy()
    expect(screen.getByText('persona.notes.basis')).toBeTruthy()
  })

  it('carries the corrected note’s tags forward as the starting point', async () => {
    judgmentsPayload = [judgment({ id: 'j-old', text: 'Old call.', tags: ['pricing', 'risk'] })]
    render(<PersonaModule />)
    await screen.findByText('Old call.')

    fireEvent.click(screen.getByText('persona.correct.start'))
    expect((screen.getByPlaceholderText('persona.add.tagsPlaceholder') as HTMLInputElement).value).toBe(
      'pricing, risk',
    )
  })

  // Losing typed words is the one thing this surface must never do. A React
  // value reset is not undoable, so a draft cleared by an unrelated click is
  // gone for good.
  it('KEEPS an in-progress note when the owner clicks correct on something else', async () => {
    render(<PersonaModule />)
    await screen.findByText('persona.correct.start')

    typeNote('half-written thought I am not done with')
    fireEvent.click(screen.getByText('persona.correct.start'))

    expect(
      (screen.getByPlaceholderText('persona.correct.placeholder') as HTMLTextAreaElement).value,
    ).toBe('half-written thought I am not done with')
  })

  it('does not overwrite tags the owner is already typing', async () => {
    judgmentsPayload = [judgment({ id: 'j-old', text: 'Old call.', tags: ['pricing'] })]
    render(<PersonaModule />)
    await screen.findByText('Old call.')

    fireEvent.change(screen.getByPlaceholderText('persona.add.tagsPlaceholder'), {
      target: { value: 'mine' },
    })
    fireEvent.click(screen.getByText('persona.correct.start'))

    expect((screen.getByPlaceholderText('persona.add.tagsPlaceholder') as HTMLInputElement).value).toBe(
      'mine',
    )
  })

  it('cancelling drops the correction, not the words', async () => {
    render(<PersonaModule />)
    await screen.findByText('persona.correct.start')

    fireEvent.click(screen.getByText('persona.correct.start'))
    fireEvent.change(screen.getByPlaceholderText('persona.correct.placeholder'), {
      target: { value: 'words worth keeping' },
    })
    fireEvent.click(screen.getByText('persona.correct.cancel'))

    expect(screen.getByText('persona.add.heading')).toBeTruthy()
    expect((screen.getByPlaceholderText('persona.add.placeholder') as HTMLTextAreaElement).value).toBe(
      'words worth keeping',
    )
  })

  it('cancelling really drops the correction — the next note carries no pointer', async () => {
    judgmentsPayload = [judgment({ id: 'j-old', text: 'The note being corrected.' })]
    render(<PersonaModule />)
    await screen.findByText('The note being corrected.')

    fireEvent.click(screen.getByText('persona.correct.start'))
    expect(screen.getByText('persona.correct.heading')).toBeTruthy()

    fireEvent.click(screen.getByText('persona.correct.cancel'))
    expect(screen.getByText('persona.add.heading')).toBeTruthy()

    // The real contract: what gets written next is a PLAIN note, with no
    // `context` pointing at the note the owner decided not to correct.
    typeNote('An unrelated new thought.')
    fireEvent.click(screen.getByText('persona.add.submit'))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]).toEqual({ text: 'An unrelated new thought.' })
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
})

describe('PersonaModule — today’s question', () => {
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
    // The rest of the tab still loads, so this is a real assertion about the
    // question section rather than about an unmounted component.
    await waitFor(() => expect(screen.getByText('persona.meta.heading')).toBeInTheDocument())
    expect(screen.queryByText('persona.interview.none.title')).not.toBeInTheDocument()
    expect(screen.queryByText('persona.interview.heading')).not.toBeInTheDocument()
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

describe('PersonaModule — today’s question, honest about what actually landed', () => {
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
    fireEvent.change(screen.getByPlaceholderText('persona.add.placeholder'), {
      target: { value: 'メモ' },
    })
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

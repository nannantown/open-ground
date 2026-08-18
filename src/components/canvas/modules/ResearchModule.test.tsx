// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

// Key-echo i18n (the GlobalSkillsPanel idiom): assertions target message KEYS,
// so they don't break when copy is reworded in either locale.
vi.mock('@/i18n/I18nContext', () => ({
  useT: () => ({ t: (k: string) => k, lang: 'en' as const }),
}))

import { ResearchModule, renderMarkdown } from './ResearchModule'
import type { ProjectMeta } from '@/lib/types'

// The report reader's markdown. The owner's actual complaint (2026-08-17,
// screenshot of an MCP research report): the tab showed the report, but
// 「| 観測項目 | 値 |」「|---|---|」 printed as literal paragraphs, and **bold** /
// `code` kept their asterisks and backticks. Every test here asserts on the
// RENDERED result — what elements exist and what raw markup does NOT survive as
// text — because "renderMarkdown was called" says nothing about the screen.

const draw = (md: string) => render(<article>{renderMarkdown(md)}</article>)

describe('renderMarkdown — tables', () => {
  // The exact shape from the owner's report.
  const table = [
    '| 観測項目 | 値 |',
    '|---|---|',
    '| リポジトリ | `modelcontextprotocol/servers` |',
    '| star 数 | **89,606**(2026-08-16 取得) |',
  ].join('\n')

  it('a pipe table becomes a real <table> — and the raw pipes are GONE', () => {
    const { container } = draw(table)
    expect(container.querySelector('table')).toBeTruthy()
    const ths = Array.from(container.querySelectorAll('th')).map((e) => e.textContent)
    expect(ths).toEqual(['観測項目', '値'])
    expect(container.querySelectorAll('tbody tr').length).toBe(2)
    // ⚠ THE COMPLAINT ITSELF: no separator row, no pipes, anywhere as text.
    expect(container.textContent).not.toContain('---')
    expect(container.textContent).not.toContain('|')
  })

  it('inline markup works INSIDE cells — bold is bold, code is code, no sigils', () => {
    const { container } = draw(table)
    const strongs = Array.from(container.querySelectorAll('strong')).map((e) => e.textContent)
    expect(strongs).toContain('89,606')
    const codes = Array.from(container.querySelectorAll('code')).map((e) => e.textContent)
    expect(codes).toContain('modelcontextprotocol/servers')
    expect(container.textContent).not.toContain('**')
    expect(container.textContent).not.toContain('`')
  })

  it('column alignment follows the separator colons', () => {
    const { container } = draw('| a | b |\n|:---|---:|\n| 1 | 2 |')
    const ths = container.querySelectorAll('th')
    expect(ths[0].className).toContain('text-left')
    expect(ths[1].className).toContain('text-right')
  })

  it('a ragged row is padded to the header width, never shifting the grid', () => {
    const { container } = draw('| a | b |\n|---|---|\n| only |')
    expect(container.querySelectorAll('tbody td').length).toBe(2)
  })

  it('a bare --- is a rule, not a one-column table separator', () => {
    const { container } = draw('前段\n\n---\n\n後段')
    expect(container.querySelector('hr')).toBeTruthy()
    expect(container.querySelector('table')).toBeNull()
    expect(container.textContent).not.toContain('---')
  })
})

describe('renderMarkdown — inline', () => {
  it('**bold**, *italic*, `code`, and links render as themselves', () => {
    const { container } = draw(
      '`servers` と **太字** と *斜体* と [公式](https://example.com/x) を見る',
    )
    expect(container.querySelector('strong')?.textContent).toBe('太字')
    expect(container.querySelector('em')?.textContent).toBe('斜体')
    expect(container.querySelector('code')?.textContent).toBe('servers')
    const a = container.querySelector('a')
    expect(a?.getAttribute('href')).toBe('https://example.com/x')
    expect(a?.textContent).toBe('公式')
    for (const sigil of ['**', '`', '[', '](']) {
      expect(container.textContent).not.toContain(sigil)
    }
  })

  it('⚠ a `code` span is armour: nothing inside it becomes bold or a link', () => {
    const { container } = draw('この行の `**not bold**` はそのまま')
    expect(container.querySelector('strong')).toBeNull()
    expect(container.querySelector('code')?.textContent).toBe('**not bold**')
  })

  it('a bare URL still autolinks', () => {
    const { container } = draw('see https://example.com/y for detail')
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com/y')
  })

  it('⚠ SAFETY UNCHANGED: javascript: stays text, HTML stays text', () => {
    const { container } = draw('[x](javascript:alert(1)) and <img src=x onerror=alert(1)>')
    expect(container.querySelector('a')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('javascript:alert(1)')
  })
})

describe('renderMarkdown — blocks', () => {
  it('numbered lists are an <ol>', () => {
    const { container } = draw('1. 一つ目\n2. 二つ目')
    expect(container.querySelectorAll('ol > li').length).toBe(2)
    // The numbers come from the list, not the text — no doubled 「1. 1.」.
    expect(container.querySelector('li')?.textContent).toBe('一つ目')
  })

  it('> quotes are a <blockquote>', () => {
    const { container } = draw('> 引用の一行目\n> 二行目')
    const q = container.querySelector('blockquote')
    expect(q?.textContent).toContain('引用の一行目')
    expect(q?.textContent).toContain('二行目')
    expect(container.textContent).not.toContain('>')
  })

  it('#### is a heading too, not a paragraph starting with hashes', () => {
    const { container } = draw('#### 小見出し')
    expect(container.querySelector('h4')?.textContent).toBe('小見出し')
    expect(container.textContent).not.toContain('#')
  })

  it('a bullet run after a quote closes the quote first — order is preserved', () => {
    const { container } = draw('> 引用\n- 箇条書き')
    const kids = Array.from(container.querySelector('article')!.children).map((e) => e.tagName)
    expect(kids).toEqual(['BLOCKQUOTE', 'UL'])
  })
})

// ─── The knowledge layer (digest + Q&A + read-aloud) ────────────────────────
// Component-level, against a scripted fetch. What these pin, per the pitch:
//   • opening a report READS knowledge but NEVER starts a claude run,
//   • the digest card sits ABOVE the full text (the whole point),
//   • 「質問はまだありません」 is claimed only on a SUCCESSFUL empty read,
//   • the question survives a failure (retry without retyping), clears on done,
//   • read-aloud speaks tldr+points in the digest's language and stop cancels.

type FetchInput = string | URL | Request
const urlOf = (input: FetchInput): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
const methodOf = (input: FetchInput, init?: RequestInit): string =>
  init?.method ?? (input instanceof Request ? input.method : 'GET')
const bodyOf = async (input: FetchInput, init?: RequestInit): Promise<string> =>
  input instanceof Request ? await input.clone().text() : String(init?.body ?? '')

const reply = (status: number, body: unknown) =>
  ({ ok: status < 400, status, json: async () => body }) as unknown as Response

interface Scripted {
  /** live knowledge body — the handler serves whatever this holds NOW */
  knowledge: () => { status: number; body: unknown }
  digestPost?: () => { status: number; body: unknown }
  askPost?: () => { status: number; body: unknown }
  job?: () => Promise<{ status: number; body: unknown }> | { status: number; body: unknown }
}

const REPORT_MD = '# Report R\n\nUNIQUE-BODY-LINE alpha beta\n'
const PROJECT = { path: '/proj/x' } as unknown as ProjectMeta

const jobDone = (kind: 'digest' | 'ask') => ({
  status: 200,
  body: { id: 'j1', kind, file: 'r.md', status: 'done', startedAt: 'x' },
})

const DIGEST = {
  tldr: 'TLDR-SENTENCE about the field.',
  points: ['POINT-ONE fact.', 'POINT-TWO fact.', 'POINT-THREE fact.'],
  lang: 'ja',
  contentSha: 'abc',
  generatedAt: '2026-08-18T00:00:00.000Z',
}

let calls: string[] // "METHOD /path" (query stripped)
let postBodies: string[]

const makeFetch = (h: Scripted) =>
  vi.fn(async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input)
    const method = methodOf(input, init)
    calls.push(`${method} ${url.split('?')[0]}`)
    // NOTE: check '/reports' BEFORE '/report' — the latter is a prefix of it.
    if (url.startsWith('/api/research/reports')) {
      return reply(200, { reports: [{ file: 'r.md', title: 'Report R', mtime: 1755400000000, size: 42 }] })
    }
    if (url.startsWith('/api/research/report')) return reply(200, { file: 'r.md', content: REPORT_MD })
    if (url.startsWith('/api/research/knowledge')) return reply(...objToPair(h.knowledge()))
    if (url.startsWith('/api/research/digest')) {
      postBodies.push(await bodyOf(input, init))
      return reply(...objToPair((h.digestPost ?? (() => ({ status: 500, body: {} })))()))
    }
    if (url.startsWith('/api/research/ask')) {
      postBodies.push(await bodyOf(input, init))
      return reply(...objToPair((h.askPost ?? (() => ({ status: 500, body: {} })))()))
    }
    if (url.startsWith('/api/research/job/')) {
      const r = await (h.job ?? (() => jobDone('digest')))()
      return reply(r.status, r.body)
    }
    throw new Error(`unexpected fetch: ${method} ${url}`)
  })
const objToPair = (r: { status: number; body: unknown }): [number, unknown] => [r.status, r.body]

/** Render the module and open the one listed report. */
const openReport = async () => {
  render(<ResearchModule project={PROJECT} />)
  fireEvent.click(await screen.findByText('Report R'))
  await screen.findByText('UNIQUE-BODY-LINE alpha beta')
}

describe('ResearchModule — knowledge card', () => {
  beforeEach(() => {
    calls = []
    postBodies = []
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('renders the digest ABOVE the full text, with the AI-extraction note', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch({ knowledge: () => ({ status: 200, body: { file: 'r.md', digest: DIGEST, qa: [], digestStale: false } }) }),
    )
    await openReport()
    await screen.findByText('TLDR-SENTENCE about the field.')
    for (const p of DIGEST.points) expect(screen.getByText(p)).toBeTruthy()
    expect(screen.getByText('research.digest.note')).toBeTruthy()
    expect(screen.getByText('research.fulltext')).toBeTruthy()
    expect(screen.queryByText('research.digest.stale')).toBeNull()
    // ⚠ THE POINT: essence first, wall of text after.
    const text = document.body.textContent ?? ''
    expect(text.indexOf('TLDR-SENTENCE')).toBeGreaterThanOrEqual(0)
    expect(text.indexOf('TLDR-SENTENCE')).toBeLessThan(text.indexOf('UNIQUE-BODY-LINE'))
  })

  it('⚠ opening a report NEVER starts a claude run — knowledge is read, digest/ask are not posted', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch({ knowledge: () => ({ status: 200, body: { file: 'r.md', qa: [] } }) }),
    )
    await openReport()
    expect(calls).toContain('GET /api/research/knowledge')
    expect(calls.some((c) => c.startsWith('POST'))).toBe(false)
  })

  it('要点を作る: posts the job, shows the working line, then swaps in the persisted digest', async () => {
    let knowledgeNow: Record<string, unknown> = { file: 'r.md', qa: [] }
    let releaseJob!: (r: { status: number; body: unknown }) => void
    const jobGate = new Promise<{ status: number; body: unknown }>((r) => {
      releaseJob = r
    })
    vi.stubGlobal(
      'fetch',
      makeFetch({
        knowledge: () => ({ status: 200, body: knowledgeNow }),
        digestPost: () => ({ status: 202, body: { jobId: 'j1' } }),
        job: () => jobGate,
      }),
    )
    await openReport()
    fireEvent.click(screen.getByRole('button', { name: 'research.digest.make' }))
    await screen.findByText('research.digest.working')
    // The result lands server-side; the poll's 'done' triggers the re-read.
    knowledgeNow = { file: 'r.md', digest: DIGEST, qa: [], digestStale: false }
    releaseJob(jobDone('digest'))
    await screen.findByText('TLDR-SENTENCE about the field.')
    expect(screen.queryByText('research.digest.working')).toBeNull()
    expect(postBodies.some((b) => b.includes('"file":"r.md"'))).toBe(true)
  })

  it('a stale digest says so (report edited since) and offers 作り直す', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch({ knowledge: () => ({ status: 200, body: { file: 'r.md', digest: DIGEST, qa: [], digestStale: true } }) }),
    )
    await openReport()
    await screen.findByText('research.digest.stale')
    expect(screen.getByRole('button', { name: 'research.digest.remake' })).toBeTruthy()
  })

  it('503 claudeMissing on distill surfaces the install copy, not a generic failure', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch({
        knowledge: () => ({ status: 200, body: { file: 'r.md', qa: [] } }),
        digestPost: () => ({ status: 503, body: { error: 'no cli', claudeMissing: true } }),
      }),
    )
    await openReport()
    fireEvent.click(screen.getByRole('button', { name: 'research.digest.make' }))
    await screen.findByText('research.knowledge.claudeMissing')
    expect(screen.queryByText('research.digest.working')).toBeNull()
  })
})

describe('ResearchModule — Q&A', () => {
  beforeEach(() => {
    calls = []
    postBodies = []
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('ask → working → answer persists into the notebook and the input clears', async () => {
    let knowledgeNow: Record<string, unknown> = { file: 'r.md', qa: [] }
    let releaseJob!: (r: { status: number; body: unknown }) => void
    const jobGate = new Promise<{ status: number; body: unknown }>((r) => {
      releaseJob = r
    })
    vi.stubGlobal(
      'fetch',
      makeFetch({
        knowledge: () => ({ status: 200, body: knowledgeNow }),
        askPost: () => ({ status: 202, body: { jobId: 'a1' } }),
        job: () => jobGate,
      }),
    )
    await openReport()
    const input = screen.getByPlaceholderText('research.qa.placeholder') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'my question' } })
    fireEvent.click(screen.getByRole('button', { name: 'research.qa.placeholder' }))
    await screen.findByText('research.qa.working')
    knowledgeNow = {
      file: 'r.md',
      qa: [{ q: 'my question', a: 'ANSWER-LINE-1\nANSWER-LINE-2', at: '2026-08-18T01:00:00.000Z' }],
    }
    releaseJob(jobDone('ask'))
    await screen.findByText('my question')
    // Multi-line answer arrives whole (the pitch's riskiest bit, end to end).
    expect(screen.getByText(/ANSWER-LINE-1/).textContent).toContain('ANSWER-LINE-2')
    expect(input.value).toBe('')
    expect(postBodies.some((b) => b.includes('"question":"my question"'))).toBe(true)
    expect(screen.queryByText('research.qa.empty')).toBeNull()
  })

  it('a failed ask keeps the question in the input for retry, with the failure line', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch({
        knowledge: () => ({ status: 200, body: { file: 'r.md', qa: [] } }),
        askPost: () => ({ status: 202, body: { jobId: 'a1' } }),
        job: () => ({ status: 200, body: { id: 'a1', kind: 'ask', file: 'r.md', status: 'error', startedAt: 'x', error: 'boom' } }),
      }),
    )
    await openReport()
    const input = screen.getByPlaceholderText('research.qa.placeholder') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'keep me' } })
    fireEvent.click(screen.getByRole('button', { name: 'research.qa.placeholder' }))
    await screen.findByText('research.qa.failed')
    expect(input.value).toBe('keep me')
    expect(screen.getByRole('button', { name: 'research.qa.retry' })).toBeTruthy()
  })

  it('503 claudeLoggedOut on ask shows the sign-in copy', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch({
        knowledge: () => ({ status: 200, body: { file: 'r.md', qa: [] } }),
        askPost: () => ({ status: 503, body: { error: 'signed out', claudeLoggedOut: true } }),
      }),
    )
    await openReport()
    const input = screen.getByPlaceholderText('research.qa.placeholder') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'q' } })
    fireEvent.click(screen.getByRole('button', { name: 'research.qa.placeholder' }))
    await screen.findByText('research.knowledge.claudeLoggedOut')
    expect(input.value).toBe('q')
  })

  it('⚠ 「質問はまだありません」 is a CLAIM — made on a successful empty read…', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch({ knowledge: () => ({ status: 200, body: { file: 'r.md', qa: [] } }) }),
    )
    await openReport()
    await screen.findByText('research.qa.empty')
  })

  it('…and NOT made when the knowledge read failed (unreadable ≠ empty)', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetch({ knowledge: () => ({ status: 500, body: { error: 'boom' } }) }),
    )
    await openReport()
    // The full text is on screen; the Q&A section stays silent about emptiness.
    expect(screen.queryByText('research.qa.empty')).toBeNull()
  })
})

describe('ResearchModule — read-aloud', () => {
  beforeEach(() => {
    calls = []
    postBodies = []
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  class FakeUtterance {
    text: string
    lang = ''
    onend: (() => void) | null = null
    onerror: (() => void) | null = null
    constructor(text: string) {
      this.text = text
    }
  }

  it("speaks tldr+points in the digest's language; stop CANCELS; unmount cancels too", async () => {
    const speak = vi.fn()
    const cancel = vi.fn()
    vi.stubGlobal('speechSynthesis', { speak, cancel })
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance)
    vi.stubGlobal(
      'fetch',
      makeFetch({ knowledge: () => ({ status: 200, body: { file: 'r.md', digest: DIGEST, qa: [] } }) }),
    )
    const view = render(<ResearchModule project={PROJECT} />)
    fireEvent.click(await screen.findByText('Report R'))
    await screen.findByText('TLDR-SENTENCE about the field.')

    fireEvent.click(screen.getByRole('button', { name: 'research.digest.speak' }))
    expect(speak).toHaveBeenCalledTimes(1)
    const u = speak.mock.calls[0][0] as FakeUtterance
    expect(u.text).toContain('TLDR-SENTENCE')
    for (const p of DIGEST.points) expect(u.text).toContain(p)
    expect(u.lang).toBe('ja-JP') // DIGEST.lang is 'ja' — voice follows the digest
    const cancelsAfterSpeak = cancel.mock.calls.length

    // Toggle: the same control now stops, and stopping really cancels.
    const stopBtn = screen.getByRole('button', { name: 'research.digest.speakStop' })
    fireEvent.click(stopBtn)
    expect(cancel.mock.calls.length).toBeGreaterThan(cancelsAfterSpeak)
    expect(screen.getByRole('button', { name: 'research.digest.speak' })).toBeTruthy()

    // Never keep talking after the tab is gone.
    const cancelsBeforeUnmount = cancel.mock.calls.length
    view.unmount()
    expect(cancel.mock.calls.length).toBeGreaterThan(cancelsBeforeUnmount)
  })
})

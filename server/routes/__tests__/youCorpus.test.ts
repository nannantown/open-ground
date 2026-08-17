import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, readFile, realpath, chmod } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from '../../app'
import { _resetPersonaInterviewForTest } from '@/lib/server/personaInterview'
import { registerTestProject } from '@/test/registerProject'
import { mutateProjectData } from '@/lib/server/projectData'
import type {
  PersonaInterviewResponse,
  YouCorpusAppendResponse,
  YouCorpusJudgmentsResponse,
  YouCorpusStatus,
  YouCorpusMeta,
} from '@/lib/types'

// The you-corpus routes against the real Hono app, with OPENGROUND_HOME on a
// throwaway dir and the SOURCE locations pointed at tmp fixtures via env, so
// nothing reads the real ~/.openground or ~/.claude. app.request() sends no
// Origin header (a local non-browser client), so the CSRF guard passes.

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

let home: string

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-youcorpus-route-home-')))
  process.env.OPENGROUND_HOME = home

  const fixtures = await realpath(await mkdtemp(join(tmpdir(), 'og-youcorpus-route-src-')))
  const memDir = join(fixtures, 'memory')
  await mkdir(memDir, { recursive: true })
  const conceptPath = join(fixtures, 'CONCEPT.md')
  await writeFile(conceptPath, '# Concept\nROUTE_CONCEPT_MARKER\n')
  await writeFile(
    join(memDir, 'project_business_model_vision.md'),
    '---\nname: project_business_model_vision\ndescription: soul\nmetadata: \n  type: project\n---\n\nROUTE_BUSINESS_MARKER\n',
  )
  process.env.OPENGROUND_MEMORY_DIR = memDir
  process.env.OPENGROUND_CONCEPT_PATH = conceptPath
  // The once-a-day memo lives on globalThis (reload safety) and so outlives a
  // test — without this, one test's "already asked today" silences the next.
  _resetPersonaInterviewForTest()
})

afterEach(async () => {
  delete process.env.OPENGROUND_MEMORY_DIR
  delete process.env.OPENGROUND_CONCEPT_PATH
  _resetPersonaInterviewForTest()
  await rm(home, { recursive: true, force: true }).catch(() => {})
})

describe('GET /api/you-corpus', () => {
  it('reports status + available sources (before any rebuild)', async () => {
    const res = await app.request('/api/you-corpus')
    expect(res.status).toBe(200)
    const body = (await res.json()) as YouCorpusStatus
    expect(body.exists).toBe(false)
    expect(body.memoryCount).toBe(1)
    expect(body.businessVisionExists).toBe(true)
    expect(body.conceptExists).toBe(true)
  })
})

describe('DNS-rebinding / loopback guard on the sensitive GETs', () => {
  it('rejects a non-loopback Host on GET /raw (corpus exfil defense)', async () => {
    const res = await app.request('/api/you-corpus/raw', { headers: { host: 'evil.example.com' } })
    expect(res.status).toBe(403)
  })

  it('rejects a non-loopback Host on GET /api/you-corpus (status leak defense)', async () => {
    const res = await app.request('/api/you-corpus', { headers: { host: 'evil.example.com' } })
    expect(res.status).toBe(403)
  })

  it('allows an explicit loopback Host', async () => {
    const res = await app.request('/api/you-corpus/raw', { headers: { host: '127.0.0.1:47776' } })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('proxy')
  })

  it('rejects a foreign Origin even when Host is absent', async () => {
    const res = await app.request('/api/you-corpus/raw', {
      headers: { origin: 'https://evil.example.com' },
    })
    expect(res.status).toBe(403)
  })

  // /judgments returns the same personal material as /raw, just structured —
  // so it needs the same exfil defense, not a weaker one.
  it('rejects a non-loopback Host on GET /judgments', async () => {
    const res = await app.request('/api/you-corpus/judgments', {
      headers: { host: 'evil.example.com' },
    })
    expect(res.status).toBe(403)
  })

  it('rejects a foreign Origin on GET /judgments', async () => {
    const res = await app.request('/api/you-corpus/judgments', {
      headers: { origin: 'https://evil.example.com' },
    })
    expect(res.status).toBe(403)
  })
})

// The read the Persona tab lists its cards from. Structured records, so the UI
// never has to parse the rendered markdown back apart.
describe('POST /api/you-corpus/retire ・ restore', () => {
  const idOf = async (text: string): Promise<string> => {
    const body = (await (
      await app.request('/api/you-corpus/judgments')
    ).json()) as YouCorpusJudgmentsResponse
    const found = body.judgments.find((j) => j.text === text)
    if (!found) throw new Error(`no judgment ${text}`)
    return found.id
  }

  it('moves a line out of the live list and into `retired`, with a date', async () => {
    await app.request('/api/you-corpus/append', json({ text: 'TAKE_THIS_BACK' }))
    await app.request('/api/you-corpus/append', json({ text: 'LEAVE_THIS' }))
    const id = await idOf('TAKE_THIS_BACK')

    const res = await app.request('/api/you-corpus/retire', json({ id }))
    expect(res.status).toBe(200)

    const after = (await (
      await app.request('/api/you-corpus/judgments')
    ).json()) as YouCorpusJudgmentsResponse
    // ⚠ THE MARKER MUST NOT SHOW UP AS A BELIEF. It carries the retired line's
    // own words, so a reader that dropped only the target would leave an
    // identical sentence standing here.
    expect(after.judgments.map((j) => j.text)).toEqual(['LEAVE_THIS'])
    expect(after.retired.map((r) => r.judgment.text)).toEqual(['TAKE_THIS_BACK'])
    expect(Number.isNaN(Date.parse(after.retired[0].retiredAt))).toBe(false)
  })

  it('「戻す」 brings it back', async () => {
    await app.request('/api/you-corpus/append', json({ text: 'ON_SECOND_THOUGHTS' }))
    const id = await idOf('ON_SECOND_THOUGHTS')
    await app.request('/api/you-corpus/retire', json({ id }))
    expect(
      ((await (await app.request('/api/you-corpus/judgments')).json()) as YouCorpusJudgmentsResponse)
        .judgments,
    ).toEqual([])

    expect((await app.request('/api/you-corpus/restore', json({ id }))).status).toBe(200)
    const back = (await (
      await app.request('/api/you-corpus/judgments')
    ).json()) as YouCorpusJudgmentsResponse
    expect(back.judgments.map((j) => j.text)).toEqual(['ON_SECOND_THOUGHTS'])
    expect(back.retired).toEqual([])
  })

  it('400s without an id, and 404s for one that is not there', async () => {
    expect((await app.request('/api/you-corpus/retire', json({}))).status).toBe(400)
    expect((await app.request('/api/you-corpus/retire', json({ id: 'nope' }))).status).toBe(404)
    expect((await app.request('/api/you-corpus/restore', json({ id: 'nope' }))).status).toBe(404)
  })

  // ⚠ THE POWER STAYS ON ITS OWN ENDPOINT. Adding a note and withdrawing one
  // are different acts; if /append accepted the marker, every path able to write
  // a note could also make lines disappear.
  it('/append cannot retire anything, whatever it is handed', async () => {
    await app.request('/api/you-corpus/append', json({ text: 'STILL_TRUE' }))
    const id = await idOf('STILL_TRUE')
    await app.request('/api/you-corpus/append', json({ text: 'SNEAKY', retiredId: id }))

    const after = (await (
      await app.request('/api/you-corpus/judgments')
    ).json()) as YouCorpusJudgmentsResponse
    expect(after.judgments.map((j) => j.text).sort()).toEqual(['SNEAKY', 'STILL_TRUE'])
    expect(after.retired).toEqual([])
  })
})

describe('GET /api/you-corpus/judgments', () => {
  it('is empty before anything is appended', async () => {
    const res = await app.request('/api/you-corpus/judgments')
    expect(res.status).toBe(200)
    const body = (await res.json()) as YouCorpusJudgmentsResponse
    expect(body.judgments).toEqual([])
    // ⚠ AN EMPTY ARRAY, NOT AN ABSENT FIELD. The file was read and held no
    // tombstones — that is a measurement, and the client may rely on it.
    expect(body.retired).toEqual([])
  })

  it('returns judgments NEWEST FIRST with their tags, context and date', async () => {
    await app.request('/api/you-corpus/append', json({ text: 'OLDER', tags: ['a'] }))
    await app.request(
      '/api/you-corpus/append',
      json({ text: 'NEWER', tags: ['b'], context: 'why it changed' }),
    )

    const res = await app.request('/api/you-corpus/judgments')
    const body = (await res.json()) as YouCorpusJudgmentsResponse
    // Newest first — the same order the assembled corpus renders them in, so
    // the tab and the stand-in agree on which call is freshest.
    expect(body.judgments.map((j) => j.text)).toEqual(['NEWER', 'OLDER'])
    expect(body.judgments[0].tags).toEqual(['b'])
    expect(body.judgments[0].context).toBe('why it changed')
    expect(body.judgments[0].id).toBeTruthy()
    expect(Number.isNaN(Date.parse(body.judgments[0].addedAt))).toBe(false)
  })

  it('carries a correction’s pointer at the note it replaces', async () => {
    await app.request('/api/you-corpus/append', json({ text: 'ORIGINAL' }))
    const before = (await (
      await app.request('/api/you-corpus/judgments')
    ).json()) as YouCorpusJudgmentsResponse
    const originalId = before.judgments[0].id

    await app.request(
      '/api/you-corpus/append',
      json({ text: 'CORRECTED', context: 'Corrects an earlier note: ORIGINAL', correctsId: originalId }),
    )

    const after = (await (
      await app.request('/api/you-corpus/judgments')
    ).json()) as YouCorpusJudgmentsResponse
    // The id survives the route → store → read round-trip, so the tab can tell
    // a correction from a note that merely cites its source.
    expect(after.judgments[0].text).toBe('CORRECTED')
    expect(after.judgments[0].correctsId).toBe(originalId)

    // ⚠ THIS TEST USED TO ASSERT THE ORIGINAL WAS STILL LISTED HERE, as its way
    // of pinning "correcting never edits". That property is real and still
    // holds — but the LISTING was the wrong place to read it, because this is
    // what draws the figure and feeds 「わかっていること N」. A superseded line
    // shown there is a lit dot the stand-in ignores, and a count of things it
    // does not know (owner, 2026-08-16: 最新だけ読む). The never-edited half is
    // pinned below against the file itself, which is where it actually lives.
    expect(after.judgments).toHaveLength(1)
    expect(after.judgments.map((j) => j.text)).not.toContain('ORIGINAL')
  })

  it('…and the corrected note is still on disk, unedited and unmarked', async () => {
    await app.request('/api/you-corpus/append', json({ text: 'ORIGINAL' }))
    const before = (await (
      await app.request('/api/you-corpus/judgments')
    ).json()) as YouCorpusJudgmentsResponse
    const originalId = before.judgments[0].id
    await app.request(
      '/api/you-corpus/append',
      json({ text: 'CORRECTED', correctsId: originalId }),
    )

    // Append-only is the SAFETY property and it is untouched: nothing the owner
    // wrote is ever rewritten or removed, only stopped from speaking.
    const onDisk = JSON.parse(
      await readFile(join(home, 'you-corpus-additions.json'), 'utf8'),
    ) as { id: string; text: string; correctsId?: string }[]
    const kept = onDisk.find((j) => j.id === originalId)
    expect(kept?.text).toBe('ORIGINAL')
    expect(kept?.correctsId).toBeUndefined()
  })
})

// chmod is the only way to make a real read fail, and it does not bite as root
// or on Windows.
const chmodBites = process.platform !== 'win32' && process.getuid?.() !== 0

// The fail-open the Persona tab actually renders. A reader that answers "[]" to
// "I could not open the file" makes the tab show its first-run invitation —
// "nothing here yet, write your first note" — to an owner whose corpus is full,
// with no error anywhere on screen. The write path already refuses on exactly
// this condition, so a tolerant read also left the two halves of one file
// disagreeing about whether it exists.
describe.skipIf(!chmodBites)('an unreadable corpus is an ERROR, never an empty one', () => {
  const withUnreadableAdditions = async (fn: () => Promise<void>) => {
    const file = join(home, 'you-corpus-additions.json')
    await chmod(file, 0o000)
    try {
      await fn()
    } finally {
      await chmod(file, 0o600)
    }
  }

  it('GET /judgments fails loudly instead of returning an empty list', async () => {
    await app.request('/api/you-corpus/append', json({ text: 'REAL_JUDGMENT_ONE' }))
    await app.request('/api/you-corpus/append', json({ text: 'REAL_JUDGMENT_TWO' }))

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await withUnreadableAdditions(async () => {
        const res = await app.request('/api/you-corpus/judgments')
        expect(res.status).toBeGreaterThanOrEqual(500)
      })
    } finally {
      errSpy.mockRestore()
    }

    // Readable again → the judgments were there the whole time. Nothing was
    // lost; the only question was whether the route would admit it could not
    // see them.
    const res = await app.request('/api/you-corpus/judgments')
    expect(res.status).toBe(200)
    const body = (await res.json()) as YouCorpusJudgmentsResponse
    expect(body.judgments.map((j) => j.text)).toEqual(['REAL_JUDGMENT_TWO', 'REAL_JUDGMENT_ONE'])
  })

  it('GET /api/you-corpus fails loudly instead of reporting manualCount 0', async () => {
    await app.request('/api/you-corpus/append', json({ text: 'REAL_JUDGMENT' }))

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await withUnreadableAdditions(async () => {
        const res = await app.request('/api/you-corpus')
        expect(res.status).toBeGreaterThanOrEqual(500)
      })
    } finally {
      errSpy.mockRestore()
    }

    const body = (await (await app.request('/api/you-corpus')).json()) as YouCorpusStatus
    expect(body.manualCount).toBe(1)
  })

  // The other half of the rule: absent is NOT unreadable. A fresh home has no
  // additions file at all and must still answer 200 with an empty list — the
  // tab's first-run invitation is correct THERE.
  it('still answers 200 + [] when the file genuinely does not exist', async () => {
    const res = await app.request('/api/you-corpus/judgments')
    expect(res.status).toBe(200)
    expect(((await res.json()) as YouCorpusJudgmentsResponse).judgments).toEqual([])
  })
})

// The 2026-07-17 incident at the seam the Persona tab actually writes through.
// In the packaged app the server's cwd is not the OPEN GROUND repo, so source
// resolution can come up empty; an append from the tab must still land, and
// must never overwrite the corpus with an empty assembly.
describe('POST /api/you-corpus/append — packaged-app shape (no resolvable sources)', () => {
  it('keeps the corpus byte-identical AND persists the judgment', async () => {
    await app.request('/api/you-corpus/rebuild', json({}))
    const before = await (await app.request('/api/you-corpus/raw')).text()
    expect(before).toContain('ROUTE_CONCEPT_MARKER')

    // Sources stop resolving (packaged cwd / unmounted disk shape).
    process.env.OPENGROUND_MEMORY_DIR = join(tmpdir(), 'og-route-packaged-no-mem')
    process.env.OPENGROUND_CONCEPT_PATH = join(tmpdir(), 'og-route-packaged-no-concept.md')

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let body: YouCorpusAppendResponse
    try {
      const res = await app.request('/api/you-corpus/append', json({ text: 'PACKAGED_MARKER' }))
      expect(res.status).toBe(200)
      body = (await res.json()) as YouCorpusAppendResponse
    } finally {
      warnSpy.mockRestore()
    }

    // The write reports honestly that the corpus was NOT rebuilt…
    expect(body.meta.skipped).toBe(true)
    // …the existing corpus is untouched…
    expect(await (await app.request('/api/you-corpus/raw')).text()).toBe(before)
    // …and the judgment is safely stored, so the tab can still show it and the
    // next healthy rebuild folds it in.
    const judgments = (await (
      await app.request('/api/you-corpus/judgments')
    ).json()) as YouCorpusJudgmentsResponse
    expect(judgments.judgments.map((j) => j.text)).toEqual(['PACKAGED_MARKER'])
  })
})

describe('POST /api/you-corpus/rebuild', () => {
  it('assembles from the mechanical sources', async () => {
    const res = await app.request('/api/you-corpus/rebuild', json({}))
    expect(res.status).toBe(200)
    const meta = (await res.json()) as YouCorpusMeta
    expect(meta.conceptIncluded).toBe(true)
    expect(meta.businessVisionIncluded).toBe(true)
    expect(meta.sizeBytes).toBeGreaterThan(0)

    // GET raw returns the injectable markdown.
    const raw = await app.request('/api/you-corpus/raw')
    expect(raw.status).toBe(200)
    expect(raw.headers.get('content-type')).toContain('text/markdown')
    const text = await raw.text()
    expect(text).toContain('ROUTE_CONCEPT_MARKER')
    expect(text).toContain('ROUTE_BUSINESS_MARKER')
    expect(text).toContain('proxy')
  })

  // The 2026-07-17 incident, at the HTTP seam: a rebuild that resolves NO
  // mechanical source (the packaged app's cwd-outside-the-repo shape) must NOT
  // overwrite a populated corpus — it reports skipped + warning instead.
  it('refuses to overwrite a populated corpus when no mechanical sources resolve', async () => {
    const first = await app.request('/api/you-corpus/rebuild', json({}))
    expect(first.status).toBe(200)
    const before = await (await app.request('/api/you-corpus/raw')).text()
    expect(before).toContain('ROUTE_CONCEPT_MARKER')

    // Sources vanish from resolution (paths that don't exist).
    process.env.OPENGROUND_MEMORY_DIR = join(tmpdir(), 'og-route-no-mem-xyz')
    process.env.OPENGROUND_CONCEPT_PATH = join(tmpdir(), 'og-route-no-concept-xyz.md')

    const res = await app.request('/api/you-corpus/rebuild', json({}))
    expect(res.status).toBe(200)
    const meta = (await res.json()) as YouCorpusMeta
    expect(meta.skipped).toBe(true)
    expect(meta.warning).toMatch(/no mechanical sources/)

    const after = await (await app.request('/api/you-corpus/raw')).text()
    expect(after).toBe(before)
  })
})

describe('POST /api/you-corpus/append', () => {
  it('rejects empty text with 400', async () => {
    const res = await app.request('/api/you-corpus/append', json({ text: '   ' }))
    expect(res.status).toBe(400)
  })

  it('adds a judgment and renders it into the corpus', async () => {
    const res = await app.request(
      '/api/you-corpus/append',
      json({ text: 'ROUTE_JUDGE_MARKER', tags: ['x'] }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as YouCorpusAppendResponse
    expect(body.judgment.text).toBe('ROUTE_JUDGE_MARKER')
    expect(body.judgment.tags).toEqual(['x'])
    expect(body.meta.manualCount).toBe(1)

    const raw = await app.request('/api/you-corpus/raw')
    const text = await raw.text()
    expect(text).toContain('ROUTE_JUDGE_MARKER')
  })
})

// ─── The interview loop ("今日の1問") ────────────────────────────────────────

/** Give the loop something real to notice: a registered project holding one
 *  card the owner sent back. Generation is deterministic, so this is enough to
 *  pin the whole journey without mocking anything. */
const seedReworkedCard = async (title: string): Promise<void> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'og-interview-proj-')))
  await mkdir(join(dir, '.git'), { recursive: true })
  await registerTestProject(dir)
  await mutateProjectData(dir, (data) => {
    data.tasks.push({
      id: `card-${title}`,
      title,
      done: false,
      boardColumn: 'doing',
      createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      reworkCount: 2,
    })
  })
}

describe('POST /api/you-corpus/interview', () => {
  it('says there is nothing to ask rather than inventing a question', async () => {
    const res = await app.request('/api/you-corpus/interview', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as PersonaInterviewResponse
    expect(body.question).toBeNull()
    expect(body.reason).toBe('no-material')
  })

  it('asks about something the owner actually did, quoting it back', async () => {
    await seedReworkedCard('ROUTE_INTERVIEW_CARD')
    const res = await app.request('/api/you-corpus/interview', { method: 'POST' })
    const body = (await res.json()) as PersonaInterviewResponse
    expect(body.question).not.toBeNull()
    expect(body.question?.textJa).toContain('ROUTE_INTERVIEW_CARD')
    expect(body.question?.kind).toBe('card-rework')
    expect(body.question?.status).toBe('open')
  })

  it('is idempotent for the day — mounting the tab twice asks once', async () => {
    await seedReworkedCard('ROUTE_ONCE_CARD')
    const a = (await (await app.request('/api/you-corpus/interview', { method: 'POST' })).json()) as PersonaInterviewResponse
    const b = (await (await app.request('/api/you-corpus/interview', { method: 'POST' })).json()) as PersonaInterviewResponse
    expect(b.question?.id).toBe(a.question?.id)
  })
})

describe('GET /api/you-corpus/interview', () => {
  it('is a READ — it never generates the day’s question', async () => {
    await seedReworkedCard('ROUTE_GET_CARD')
    const before = (await (await app.request('/api/you-corpus/interview')).json()) as PersonaInterviewResponse
    expect(before.question).toBeNull()

    await app.request('/api/you-corpus/interview', { method: 'POST' })
    const after = (await (await app.request('/api/you-corpus/interview')).json()) as PersonaInterviewResponse
    expect(after.question?.textJa).toContain('ROUTE_GET_CARD')
  })

  it('rejects a non-loopback Host — the question quotes the owner’s own cards', async () => {
    const res = await app.request('/api/you-corpus/interview', {
      headers: { host: 'evil.example.com' },
    })
    expect(res.status).toBe(403)
  })

  it('does NOT claim “nothing to ask” for a day it has not swept yet', async () => {
    // Material demonstrably exists — the POST below proves it — so reporting
    // 'no-material' here would be a claim about records nobody read.
    await seedReworkedCard('ROUTE_REASON_CARD')
    const before = (await (await app.request('/api/you-corpus/interview')).json()) as PersonaInterviewResponse
    expect(before.question).toBeNull()
    expect(before.reason).toBe('not-generated')

    const posted = (await (await app.request('/api/you-corpus/interview', { method: 'POST' })).json()) as PersonaInterviewResponse
    expect(posted.question).not.toBeNull()
  })

  it('reports no-material only for a day that really was swept and came up empty', async () => {
    await app.request('/api/you-corpus/interview', { method: 'POST' })
    const after = (await (await app.request('/api/you-corpus/interview')).json()) as PersonaInterviewResponse
    expect(after.question).toBeNull()
    expect(after.reason).toBe('no-material')
  })
})

describe('POST /api/you-corpus/interview/answer', () => {
  const askToday = async (title: string) => {
    await seedReworkedCard(title)
    const body = (await (await app.request('/api/you-corpus/interview', { method: 'POST' })).json()) as PersonaInterviewResponse
    return body.question!
  }

  it('writes the answer into the corpus as Q + the owner’s words', async () => {
    const q = await askToday('ROUTE_ANSWER_CARD')
    const res = await app.request(
      '/api/you-corpus/interview/answer',
      json({ id: q.id, answer: 'ROUTE_ANSWER_MARKER' }),
    )
    expect(res.status).toBe(200)
    expect(((await res.json()) as PersonaInterviewResponse).question?.status).toBe('answered')

    // It really landed where the stand-in reads — not just in the loop's state.
    const judgments = (await (
      await app.request('/api/you-corpus/judgments')
    ).json()) as YouCorpusJudgmentsResponse
    expect(judgments.judgments[0].text).toContain('ROUTE_ANSWER_MARKER')
    expect(judgments.judgments[0].text).toContain('ROUTE_ANSWER_CARD')
    expect(judgments.judgments[0].tags).toContain('interview')

    const raw = await (await app.request('/api/you-corpus/raw')).text()
    expect(raw).toContain('ROUTE_ANSWER_MARKER')
  })

  it('refuses an empty answer and an unknown id', async () => {
    const q = await askToday('ROUTE_REJECT_CARD')
    expect((await app.request('/api/you-corpus/interview/answer', json({ id: q.id, answer: '  ' }))).status).toBe(400)
    expect((await app.request('/api/you-corpus/interview/answer', json({ answer: 'x' }))).status).toBe(400)
    expect(
      (await app.request('/api/you-corpus/interview/answer', json({ id: 'nope', answer: 'x' }))).status,
    ).toBe(404)
  })
})

describe('POST /api/you-corpus/interview/skip', () => {
  it('records the pass without teaching the corpus anything', async () => {
    await seedReworkedCard('ROUTE_SKIP_CARD')
    const asked = (await (await app.request('/api/you-corpus/interview', { method: 'POST' })).json()) as PersonaInterviewResponse
    const res = await app.request('/api/you-corpus/interview/skip', json({ id: asked.question!.id }))
    expect(res.status).toBe(200)
    expect(((await res.json()) as PersonaInterviewResponse).question?.status).toBe('skipped')

    const judgments = (await (
      await app.request('/api/you-corpus/judgments')
    ).json()) as YouCorpusJudgmentsResponse
    expect(judgments.judgments).toHaveLength(0)
  })

  it('refuses an unknown id rather than skipping whatever is current', async () => {
    await seedReworkedCard('ROUTE_SKIP_UNKNOWN')
    await app.request('/api/you-corpus/interview', { method: 'POST' })
    expect((await app.request('/api/you-corpus/interview/skip', json({ id: 'nope' }))).status).toBe(404)
  })
})

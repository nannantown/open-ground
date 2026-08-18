// researchKnowledge — the knowledge layer over one research report (digest +
// Q&A + the jobs that produce both). Pins the four things the pitch calls
// load-bearing:
//   1. EXTRACTION over a hostile PTY buffer — numbered spans survive gaps,
//      ANSI, and repaints (the pitch's 「いちばん危ういところ」).
//   2. COMPLETION — a short answer finishes early (settle) but a print in
//      progress is never truncated at `min` (the bare ≥min cutoff bug).
//   3. PERSISTENCE — the sidecar lands in the CENTRAL data dir and the
//      project repo stays byte-for-byte untouched (hard non-goal).
//   4. HONESTY — a corrupt sidecar reads as empty (derived data), a vanished
//      report errors BEFORE any claude spawn, and the Q&A history is capped.
// All claude runs are replaced by deps.run canned buffers — no PTY spawns.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  MAX_DIGEST_POINTS,
  MAX_QA_ENTRIES,
  MAX_QUESTION_LEN,
  RSCH_END,
  RSCH_TLDR_MARKER,
  __resetResearchJobsForTests,
  contentShaOf,
  extractNumbered,
  getResearchJobState,
  makeSettledCompletion,
  readResearchKnowledge,
  rschAnswerMarker,
  rschPointMarker,
  startResearchAskJob,
  startResearchDigestJob,
} from './researchKnowledge'
import { projectDataDir } from './projectDataPath'
import { researchRoutes } from '../../../server/routes/research'
import { registerTestProject } from '../../test/registerProject'
import type { ResearchJobStateResponse, ResearchKnowledgeFile } from '../types'

const REPORT = '# MCP servers\n\nThe official repo passed 89,606 stars.\n'

const digestBuffer = [
  `${RSCH_TLDR_MARKER} MCP servers are consolidating fast. ${RSCH_END}`,
  `${rschPointMarker(1)} The official repo passed 89,606 stars. ${RSCH_END}`,
  `${rschPointMarker(2)} Three registries compete for discovery. ${RSCH_END}`,
  `${rschPointMarker(3)} Security reviews lag behind adoption. ${RSCH_END}`,
].join('\n')

const askBuffer = [
  `${rschAnswerMarker(1)} The report names three registries. ${RSCH_END}`,
  `${rschAnswerMarker(2)} None of them verifies publishers yet. ${RSCH_END}`,
].join('\n')

/** Jobs are fire-and-forget async — poll the registry until terminal. */
const waitJob = async (id: string): Promise<ResearchJobStateResponse> => {
  for (let i = 0; i < 500; i++) {
    const st = getResearchJobState(id)
    if (st && st.status !== 'running') return st
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`job ${id} never settled`)
}

// ─── extractNumbered ────────────────────────────────────────────────────────

describe('extractNumbered', () => {
  it('collects numbered lines in number order', () => {
    expect(extractNumbered(digestBuffer, rschPointMarker, MAX_DIGEST_POINTS, 240)).toEqual([
      'The official repo passed 89,606 stars.',
      'Three registries compete for discovery.',
      'Security reviews lag behind adoption.',
    ])
  })

  it('⚠ a GAP does not end the scan — a wrapped line can lose one number while the rest survive', () => {
    const raw = [
      `${rschPointMarker(1)} first ${RSCH_END}`,
      // point 2 mangled by a PTY wrap — marker never lands intact
      `${rschPointMarker(3)} third ${RSCH_END}`,
    ].join('\n')
    expect(extractNumbered(raw, rschPointMarker, MAX_DIGEST_POINTS, 240)).toEqual([
      'first',
      'third',
    ])
  })

  it('survives ANSI noise and takes the LAST paint of a repainted number', () => {
    // The WINNING paint carries real ESC sequences inside the span — a TUI
    // repaint colours and clears mid-line, and the content must come out clean.
    const raw = [
      `${rschPointMarker(1)} stale paint ${RSCH_END}`,
      'scroll noise',
      `\u001b[2K\u001b[1m${rschPointMarker(1)} \u001b[31mfinal\u001b[0m paint ${RSCH_END}`,
    ].join('\n')
    expect(extractNumbered(raw, rschPointMarker, MAX_DIGEST_POINTS, 240)).toEqual(['final paint'])
  })

  it('returns [] on a buffer with no markers at all', () => {
    expect(extractNumbered('plain terminal output', rschPointMarker, MAX_DIGEST_POINTS, 240)).toEqual(
      [],
    )
  })
})

// ─── makeSettledCompletion ──────────────────────────────────────────────────

describe('makeSettledCompletion', () => {
  it('completes IMMEDIATELY when the count hits max — nothing more can come', () => {
    let count = 0
    let t = 0
    const done = makeSettledCompletion(() => count, { min: 3, max: 6, settleMs: 2500, now: () => t })
    count = 6
    t = 100
    expect(done('')).toBe(true)
  })

  it('⚠ NEVER completes the instant `min` appears — that cutoff truncated a print in progress', () => {
    let count = 0
    let t = 0
    const done = makeSettledCompletion(() => count, { min: 3, max: 6, settleMs: 2500, now: () => t })
    count = 3 // the 3rd line just landed; the 4th may be mid-print
    t = 100
    expect(done('')).toBe(false)
  })

  it('completes once ≥min has been UNCHANGED for settleMs', () => {
    const count = 3
    let t = 0
    const done = makeSettledCompletion(() => count, { min: 3, max: 6, settleMs: 2500, now: () => t })
    expect(done('')).toBe(false) // first sighting arms the clock
    t = 2000
    expect(done('')).toBe(false) // not settled yet
    t = 2600
    expect(done('')).toBe(true) // 2600ms unchanged ≥ 2500ms
  })

  it('a count CHANGE resets the settle clock', () => {
    let count = 3
    let t = 0
    const done = makeSettledCompletion(() => count, { min: 3, max: 6, settleMs: 2500, now: () => t })
    expect(done('')).toBe(false)
    t = 2000
    count = 4 // line 4 arrived at 2000 — clock restarts
    expect(done('')).toBe(false)
    t = 4000
    expect(done('')).toBe(false) // only 2000ms since the change
    t = 4600
    expect(done('')).toBe(true)
  })

  it('below min it never settles, no matter how long', () => {
    let t = 0
    const done = makeSettledCompletion(() => 2, { min: 3, max: 6, settleMs: 2500, now: () => t })
    expect(done('')).toBe(false)
    t = 60_000
    expect(done('')).toBe(false)
  })
})

// ─── Sidecar store + jobs (canned claude) ───────────────────────────────────

describe('research knowledge jobs', () => {
  let proj: string
  let sidecarPath: string

  const seedSidecar = async (payload: unknown) => {
    await mkdir(join(await projectDataDir(proj), 'research-knowledge'), { recursive: true })
    await writeFile(sidecarPath, JSON.stringify(payload), 'utf8')
  }

  beforeEach(async () => {
    __resetResearchJobsForTests()
    proj = await realpath(await mkdtemp(join(tmpdir(), 'og-rk-')))
    await registerTestProject(proj)
    await mkdir(join(proj, 'docs', 'research'), { recursive: true })
    await writeFile(join(proj, 'docs', 'research', 'report.md'), REPORT)
    sidecarPath = join(
      await projectDataDir(proj),
      'research-knowledge',
      `${encodeURIComponent('report.md')}.json`,
    )
  })
  afterEach(async () => {
    await rm(proj, { recursive: true, force: true })
  })

  it('digest job: extracts, persists to the CENTRAL sidecar, and leaves the repo untouched', async () => {
    const before = (await readdir(proj, { recursive: true })).sort()
    const id = startResearchDigestJob(
      { projectPath: proj, file: 'report.md' },
      { run: async () => digestBuffer, lang: async () => 'ja' },
    )
    const st = await waitJob(id)
    expect(st.status).toBe('done')
    expect(st.kind).toBe('digest')

    // Persisted through the production reader…
    const k = await readResearchKnowledge(proj, 'report.md')
    expect(k.digest?.tldr).toBe('MCP servers are consolidating fast.')
    expect(k.digest?.points).toHaveLength(3)
    expect(k.digest?.lang).toBe('ja')
    // …with the sha of exactly the text it distilled (staleness anchor).
    expect(k.digest?.contentSha).toBe(contentShaOf(REPORT))

    // ⚠ CENTRAL-ONLY: the sidecar file exists under ~/.openground/projects/…
    const raw = JSON.parse(await readFile(sidecarPath, 'utf8')) as ResearchKnowledgeFile
    expect(raw.digest?.tldr).toBe('MCP servers are consolidating fast.')
    // ⚠ …and the project repo is byte-for-byte the same file list as before.
    const after = (await readdir(proj, { recursive: true })).sort()
    expect(after).toEqual(before)
  })

  it('ask job: answer lines reassemble with \\n and append to the Q&A history', async () => {
    const id = startResearchAskJob(
      { projectPath: proj, file: 'report.md', question: 'レジストリはいくつ？' },
      { run: async () => askBuffer },
    )
    expect((await waitJob(id)).status).toBe('done')
    const k = await readResearchKnowledge(proj, 'report.md')
    expect(k.qa).toHaveLength(1)
    expect(k.qa[0].q).toBe('レジストリはいくつ？')
    expect(k.qa[0].a).toBe('The report names three registries.\nNone of them verifies publishers yet.')
    expect(typeof k.qa[0].at).toBe('string')
  })

  it('Q&A history is capped at MAX_QA_ENTRIES — oldest dropped, newest kept', async () => {
    await seedSidecar({
      file: 'report.md',
      qa: Array.from({ length: MAX_QA_ENTRIES }, (_, i) => ({
        q: `q${i}`,
        a: `a${i}`,
        at: '2026-01-01T00:00:00.000Z',
      })),
    })
    const id = startResearchAskJob(
      { projectPath: proj, file: 'report.md', question: 'newest' },
      { run: async () => askBuffer },
    )
    expect((await waitJob(id)).status).toBe('done')
    const k = await readResearchKnowledge(proj, 'report.md')
    expect(k.qa).toHaveLength(MAX_QA_ENTRIES)
    expect(k.qa[0].q).toBe('q1') // q0 fell off
    expect(k.qa[k.qa.length - 1].q).toBe('newest')
  })

  it('a corrupt sidecar reads as EMPTY knowledge (derived data), never a crash', async () => {
    await mkdir(join(await projectDataDir(proj), 'research-knowledge'), { recursive: true })
    await writeFile(sidecarPath, '{ not json', 'utf8')
    expect(await readResearchKnowledge(proj, 'report.md')).toEqual({
      file: 'report.md',
      digest: undefined,
      qa: [],
    })
  })

  it('malformed Q&A entries are filtered on read, valid ones survive', async () => {
    await seedSidecar({
      file: 'report.md',
      qa: [
        { q: 'good', a: 'answer', at: '2026-01-01T00:00:00.000Z' },
        { q: 42, a: 'bad q' },
        null,
        'nonsense',
      ],
    })
    const k = await readResearchKnowledge(proj, 'report.md')
    expect(k.qa.map((e) => e.q)).toEqual(['good'])
  })

  it('single-flight: a second start of the SAME (report, kind) re-attaches; another kind runs freely', async () => {
    let release!: (b: string) => void
    const gate = new Promise<string>((r) => {
      release = r
    })
    const id1 = startResearchDigestJob(
      { projectPath: proj, file: 'report.md' },
      { run: () => gate, lang: async () => 'en' },
    )
    const id2 = startResearchDigestJob(
      { projectPath: proj, file: 'report.md' },
      { run: () => gate, lang: async () => 'en' },
    )
    expect(id2).toBe(id1)
    const idAsk = startResearchAskJob(
      { projectPath: proj, file: 'report.md', question: 'q' },
      { run: async () => askBuffer },
    )
    expect(idAsk).not.toBe(id1)
    release(digestBuffer)
    expect((await waitJob(id1)).status).toBe('done')
    expect((await waitJob(idAsk)).status).toBe('done')
  })

  it('a buffer with NO extractable digest fails the job and writes nothing', async () => {
    const id = startResearchDigestJob(
      { projectPath: proj, file: 'report.md' },
      { run: async () => 'plain output, no markers', lang: async () => 'en' },
    )
    const st = await waitJob(id)
    expect(st.status).toBe('error')
    expect(st.error).toMatch(/could not extract/)
    expect((await readResearchKnowledge(proj, 'report.md')).digest).toBeUndefined()
  })

  it('a vanished report errors BEFORE any claude run', async () => {
    let ran = false
    const id = startResearchDigestJob(
      { projectPath: proj, file: 'missing.md' },
      {
        run: async () => {
          ran = true
          return digestBuffer
        },
        lang: async () => 'en',
      },
    )
    const st = await waitJob(id)
    expect(st.status).toBe('error')
    expect(ran).toBe(false)
  })

  it('getResearchJobState is null for an unknown id', () => {
    expect(getResearchJobState('nope')).toBeNull()
  })
})

// ─── Routes (no spawns: only paths that return BEFORE the claude preflight) ──

describe('research knowledge routes', () => {
  let proj: string

  const knowledgeGet = (file: string) =>
    researchRoutes.request(
      `/api/research/knowledge?path=${encodeURIComponent(proj)}&file=${encodeURIComponent(file)}`,
    )
  const post = (path: string, body: unknown) =>
    researchRoutes.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

  beforeEach(async () => {
    __resetResearchJobsForTests()
    proj = await realpath(await mkdtemp(join(tmpdir(), 'og-rk-routes-')))
    await registerTestProject(proj)
    await mkdir(join(proj, 'docs', 'research'), { recursive: true })
    await writeFile(join(proj, 'docs', 'research', 'r.md'), REPORT)
  })
  afterEach(async () => {
    await rm(proj, { recursive: true, force: true })
  })

  it('GET knowledge: a missing REPORT is 404 (nothing to be knowledgeable about)', async () => {
    expect((await knowledgeGet('nope.md')).status).toBe(404)
  })

  it('GET knowledge: a fresh report is a valid EMPTY knowledge — no digest key, qa []', async () => {
    const res = await knowledgeGet('r.md')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toEqual({ file: 'r.md', qa: [] })
    expect('digest' in body).toBe(false)
    expect('digestStale' in body).toBe(false)
  })

  it('GET knowledge: digestStale flips when the live report text no longer matches the digest sha', async () => {
    const dir = join(await projectDataDir(proj), 'research-knowledge')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, `${encodeURIComponent('r.md')}.json`),
      JSON.stringify({
        file: 'r.md',
        digest: {
          tldr: 't',
          points: ['p'],
          lang: 'en',
          contentSha: contentShaOf(REPORT),
          generatedAt: '2026-08-18T00:00:00.000Z',
        },
        qa: [],
      }),
    )
    const fresh = (await (await knowledgeGet('r.md')).json()) as { digestStale?: boolean }
    expect(fresh.digestStale).toBe(false)

    await writeFile(join(proj, 'docs', 'research', 'r.md'), REPORT + '\nedited\n')
    const stale = (await (await knowledgeGet('r.md')).json()) as { digestStale?: boolean }
    expect(stale.digestStale).toBe(true)
  })

  it('POST digest: a missing report is 404 BEFORE the preflight (never a spawn)', async () => {
    expect((await post('/api/research/digest', { path: proj, file: 'nope.md' })).status).toBe(404)
  })

  it('POST ask: an empty or missing question is 400', async () => {
    expect((await post('/api/research/ask', { path: proj, file: 'r.md' })).status).toBe(400)
    expect(
      (await post('/api/research/ask', { path: proj, file: 'r.md', question: '   ' })).status,
    ).toBe(400)
  })

  it('POST ask: a question over MAX_QUESTION_LEN is 400; a missing report is 404', async () => {
    expect(
      (
        await post('/api/research/ask', {
          path: proj,
          file: 'r.md',
          question: 'x'.repeat(MAX_QUESTION_LEN + 1),
        })
      ).status,
    ).toBe(400)
    expect(
      (await post('/api/research/ask', { path: proj, file: 'nope.md', question: 'q' })).status,
    ).toBe(404)
  })

  it('GET job/:id: unknown or swept is 404', async () => {
    expect((await researchRoutes.request('/api/research/job/unknown-id')).status).toBe(404)
  })

  it('the new POST routes sit behind validateProjectPath like every other path route', async () => {
    expect((await post('/api/research/digest', { path: '/etc', file: 'x.md' })).status).toBe(403)
    expect((await post('/api/research/ask', { path: '/etc', file: 'x.md', question: 'q' })).status).toBe(
      403,
    )
    expect(
      (
        await researchRoutes.request(
          `/api/research/knowledge?path=${encodeURIComponent('/etc')}&file=x.md`,
        )
      ).status,
    ).toBe(403)
  })
})

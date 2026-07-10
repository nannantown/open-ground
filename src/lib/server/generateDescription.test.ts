import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  extractDescMarker,
  extractMarkerPair,
  buildDescribePrompt,
  DESC_MARKER_EN,
  DESC_MARKER_JA,
  DESC_END,
  MAX_DESC_LEN,
  startDescribeJob,
  getDescribeJobState,
  listActiveDescribeJobs,
  cancelDescribeJob,
  _resetDescribeJobsForTest,
  type GeneratedDescriptions,
} from './generateDescription'

const pairOutput = [
  'some TUI noise',
  `${DESC_MARKER_EN} A local cockpit for Claude Code. ${DESC_END}`,
  `${DESC_MARKER_JA} Claude Code のローカルコックピット。 ${DESC_END}`,
].join('\n')

describe('extractDescMarker (PTY stream)', () => {
  it('pulls the text between marker and end token', () => {
    expect(extractDescMarker(pairOutput, DESC_MARKER_EN)).toBe(
      'A local cockpit for Claude Code.',
    )
    expect(extractDescMarker(pairOutput, DESC_MARKER_JA)).toBe(
      'Claude Code のローカルコックピット。',
    )
  })

  it('requires the end token — a bare marker line is mid-stream, not an answer', () => {
    expect(extractDescMarker(`${DESC_MARKER_EN} partial text`, DESC_MARKER_EN)).toBeNull()
  })

  it("skips the prompt's own echoed placeholder (contains '<')", () => {
    const echoed = [
      `${DESC_MARKER_EN} <ONE short sentence in English — what the project is> ${DESC_END}`,
      `${DESC_MARKER_EN} The real answer. ${DESC_END}`,
    ].join('\n')
    expect(extractDescMarker(echoed, DESC_MARKER_EN)).toBe('The real answer.')
    // Echo only — nothing usable.
    expect(
      extractDescMarker(`${DESC_MARKER_EN} <placeholder> ${DESC_END}`, DESC_MARKER_EN),
    ).toBeNull()
  })

  it('takes the LAST pair when the TUI repaints the line several times', () => {
    const repainted = [
      `${DESC_MARKER_EN} stale paint ${DESC_END}`,
      `${DESC_MARKER_EN} final paint ${DESC_END}`,
    ].join('\n')
    expect(extractDescMarker(repainted, DESC_MARKER_EN)).toBe('final paint')
  })

  it('strips ANSI sequences and collapses a PTY line-wrap to one space', () => {
    const wrapped = `${DESC_MARKER_EN} \x1b[1mBold\x1b[0m start\n   wrapped tail ${DESC_END}`
    expect(extractDescMarker(wrapped, DESC_MARKER_EN)).toBe('Bold start wrapped tail')
  })

  it('treats TUI cursor moves (CSI n C / CUP) as word gaps', () => {
    // Real-world failure: the TUI positioned words with cursor moves instead
    // of spaces and the answer came back as "ClaudeCodemissioncontrol".
    const fwd = `${DESC_MARKER_EN} Claude\x1b[2CCode\x1b[1Cmission ${DESC_END}`
    expect(extractDescMarker(fwd, DESC_MARKER_EN)).toBe('Claude Code mission')
    const cup = `${DESC_MARKER_EN} Local\x1b[3;42Hmission\x1b[3;50Hcontrol ${DESC_END}`
    expect(extractDescMarker(cup, DESC_MARKER_EN)).toBe('Local mission control')
  })

  it('SGR (style) sequences delete WITHOUT injecting a word gap', () => {
    const midWord = `${DESC_MARKER_EN} re\x1b[1md\x1b[0m apple ${DESC_END}`
    expect(extractDescMarker(midWord, DESC_MARKER_EN)).toBe('red apple')
  })

  it('caps runaway text at MAX_DESC_LEN', () => {
    const long = 'x'.repeat(MAX_DESC_LEN + 100)
    expect(extractDescMarker(`${DESC_MARKER_EN} ${long} ${DESC_END}`, DESC_MARKER_EN)).toHaveLength(
      MAX_DESC_LEN,
    )
  })
})

describe('extractMarkerPair', () => {
  it('returns both languages when both landed', () => {
    expect(extractMarkerPair(pairOutput)).toEqual({
      en: 'A local cockpit for Claude Code.',
      ja: 'Claude Code のローカルコックピット。',
    })
  })

  it('returns null for the missing side', () => {
    const enOnly = `${DESC_MARKER_EN} English only. ${DESC_END}`
    expect(extractMarkerPair(enOnly)).toEqual({ en: 'English only.', ja: null })
    expect(extractMarkerPair('no markers at all')).toEqual({ en: null, ja: null })
  })

  it('the language-tagged markers never cross-match each other', () => {
    const jaOnly = `${DESC_MARKER_JA} 日本語のみ。 ${DESC_END}`
    expect(extractMarkerPair(jaOnly).en).toBeNull()
  })
})

describe('buildDescribePrompt', () => {
  it('contains both marker lines with the end token and the read-only rules', () => {
    const p = buildDescribePrompt()
    expect(p).toContain(DESC_MARKER_EN)
    expect(p).toContain(DESC_MARKER_JA)
    expect(p).toContain(DESC_END)
    expect(p).toContain('.openground/')
    expect(p).toMatch(/read-only/i)
  })

  // The extractor rejects EVERY candidate containing '<' (placeholder guard), so
  // the prompt owns the other half of that contract: it must tell the model not
  // to write angle brackets — exactly as buildTitlePrompt does. Without this
  // line, describing an HTML/JSX project yielded answers like
  // "A <canvas> rendering library", which the extractor dropped on the floor.
  it('forbids angle brackets in the answer — the other half of the extractor guard', () => {
    expect(buildDescribePrompt()).toMatch(/no angle brackets/i)
  })

  it('tells the model to substitute the `<…>` placeholders, brackets and all', () => {
    const p = buildDescribePrompt()
    // The placeholders it echoes are precisely what the extractor guard catches…
    expect(extractDescMarker(p, DESC_MARKER_EN)).toBeNull()
    expect(extractDescMarker(p, DESC_MARKER_JA)).toBeNull()
    // …so the prompt must say to replace them rather than echo them back.
    expect(p).toMatch(/replace each/i)
  })
})

// Regression — audit 856daefb: a natural description containing '<' is rejected
// by design (it is indistinguishable from an elided echo of the prompt's own
// placeholder). When that hit only ONE language, `pair.en && pair.ja` never went
// true, so generateProjectDescription sat until its 120s deadline and then
// persisted a half-empty pair. The guard stays; the prompt (asserted above) is
// what keeps a real answer from ever tripping it.
describe('angle brackets: extractor guard ↔ prompt rule', () => {
  const withAngles = [
    `${DESC_MARKER_EN} A <canvas> rendering library. ${DESC_END}`,
    `${DESC_MARKER_JA} <canvas> 描画ライブラリ。 ${DESC_END}`,
  ].join('\n')

  it('drops a candidate whose text contains an angle bracket', () => {
    expect(extractMarkerPair(withAngles)).toEqual({ en: null, ja: null })
  })

  it('a one-sided angle bracket leaves the pair incomplete (the timeout bug)', () => {
    const oneSided = [
      `${DESC_MARKER_EN} A <canvas> rendering library. ${DESC_END}`,
      `${DESC_MARKER_JA} 描画ライブラリ。 ${DESC_END}`,
    ].join('\n')
    const pair = extractMarkerPair(oneSided)
    expect(pair.en).toBeNull()
    expect(pair.ja).toBe('描画ライブラリ。')
  })

  it('the bracket-free wording the prompt asks for is accepted on both sides', () => {
    const clean = [
      `${DESC_MARKER_EN} A canvas rendering library. ${DESC_END}`,
      `${DESC_MARKER_JA} canvas 描画ライブラリ。 ${DESC_END}`,
    ].join('\n')
    expect(extractMarkerPair(clean)).toEqual({
      en: 'A canvas rendering library.',
      ja: 'canvas 描画ライブラリ。',
    })
  })
})

// ── describe job registry ─────────────────────────────────────────────────────
// Deps are ALWAYS injected (generate / persist / lang) so a job never spawns a
// claude PTY nor touches ~/.openground — the registry's bookkeeping is what's
// under test, not the engine (covered by the extract* tests above).

// Let the fire-and-forget job body settle (a couple of awaited microtasks).
const settle = async () => {
  await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

type Gen = (
  projectPath: string,
  opts?: { timeoutMs?: number; signal?: AbortSignal },
) => Promise<GeneratedDescriptions>

describe('describe job registry', () => {
  beforeEach(() => _resetDescribeJobsForTest())
  afterEach(() => _resetDescribeJobsForTest())

  it('single-flight: a second start for the same project reuses the running job', async () => {
    let resolve!: (v: GeneratedDescriptions) => void
    const generate: Gen = vi.fn(
      () => new Promise<GeneratedDescriptions>((r) => (resolve = r)),
    )
    const persist = vi.fn(async () => {})
    const id1 = startDescribeJob({ projectPath: '/p/a' }, { generate, persist, lang: async () => 'en' })
    const id2 = startDescribeJob({ projectPath: '/p/a' }, { generate, persist, lang: async () => 'en' })
    expect(id2).toBe(id1)
    expect(generate).toHaveBeenCalledTimes(1)
    // A DIFFERENT project starts its own job — single-flight is per project.
    const otherGen: Gen = vi.fn(() => new Promise<GeneratedDescriptions>(() => {}))
    const id3 = startDescribeJob({ projectPath: '/p/b' }, { generate: otherGen, persist, lang: async () => 'en' })
    expect(id3).not.toBe(id1)
    resolve({ en: 'done', ja: null })
    await settle()
  })

  it('done: persists the generated pair and reports the result', async () => {
    const generate: Gen = vi.fn(async () => ({ en: 'A cockpit.', ja: 'コックピット。' }))
    const persist = vi.fn(async () => {})
    const id = startDescribeJob({ projectPath: '/p/a' }, { generate, persist, lang: async () => 'ja' })
    await settle()
    expect(persist).toHaveBeenCalledWith('/p/a', {
      description: 'コックピット。', // ja requested → active-language copy is ja
      descriptionJa: 'コックピット。',
      descriptionEn: 'A cockpit.',
    })
    const st = getDescribeJobState(id)
    expect(st?.status).toBe('done')
    expect(st?.projectPath).toBe('/p/a')
    expect(st?.description).toBe('コックピット。')
    expect(st?.descriptionEn).toBe('A cockpit.')
    expect(listActiveDescribeJobs().some((j) => j.id === id)).toBe(false)
  })

  it('active-language fallback: uses the other language when the active one is absent', async () => {
    const generate: Gen = vi.fn(async () => ({ en: 'English only.', ja: null }))
    const persist = vi.fn(async () => {})
    const id = startDescribeJob({ projectPath: '/p/a' }, { generate, persist, lang: async () => 'ja' })
    await settle()
    // ja requested but absent → description falls back to en; no stale descriptionJa written.
    expect(persist).toHaveBeenCalledWith('/p/a', {
      description: 'English only.',
      descriptionEn: 'English only.',
    })
    expect(getDescribeJobState(id)?.status).toBe('done')
  })

  it('error: a failed generation reports status error and never persists', async () => {
    const generate: Gen = vi.fn(async () => {
      throw new Error('boom')
    })
    const persist = vi.fn(async () => {})
    const id = startDescribeJob({ projectPath: '/p/a' }, { generate, persist, lang: async () => 'en' })
    await settle()
    expect(persist).not.toHaveBeenCalled()
    const st = getDescribeJobState(id)
    expect(st?.status).toBe('error')
    expect(st?.error).toBe('boom')
  })

  it('cancel: aborts the run, marks it cancelled, drops it from active, and never persists', async () => {
    let abortSeen = false
    const generate: Gen = vi.fn(
      (_p, opts) =>
        new Promise<GeneratedDescriptions>((_res, rej) => {
          opts?.signal?.addEventListener(
            'abort',
            () => {
              abortSeen = true
              rej(new Error('aborted'))
            },
            { once: true },
          )
        }),
    )
    const persist = vi.fn(async () => {})
    const id = startDescribeJob({ projectPath: '/p/a' }, { generate, persist, lang: async () => 'en' })
    expect(listActiveDescribeJobs().some((j) => j.id === id)).toBe(true)
    expect(cancelDescribeJob(id)).toBe(true)
    await settle()
    expect(abortSeen).toBe(true)
    expect(persist).not.toHaveBeenCalled()
    expect(getDescribeJobState(id)?.status).toBe('error')
    expect(getDescribeJobState(id)?.error).toBe('cancelled')
    expect(listActiveDescribeJobs().some((j) => j.id === id)).toBe(false)
  })

  it('a cancel that lands AFTER generation finished still wins — the late result is not persisted', async () => {
    let resolveGen!: (v: GeneratedDescriptions) => void
    const generate: Gen = vi.fn(
      () => new Promise<GeneratedDescriptions>((res) => (resolveGen = res)),
    )
    const persist = vi.fn(async () => {})
    const id = startDescribeJob({ projectPath: '/p/a' }, { generate, persist, lang: async () => 'en' })
    cancelDescribeJob(id) // abort fires now…
    resolveGen({ en: 'late', ja: null }) // …then generate resolves successfully
    await settle()
    expect(persist).not.toHaveBeenCalled()
    expect(getDescribeJobState(id)?.error).toBe('cancelled')
  })

  it('getDescribeJobState → null for an unknown id; cancel → false for an unknown id', () => {
    expect(getDescribeJobState('nope-123')).toBeNull()
    expect(cancelDescribeJob('nope-123')).toBe(false)
  })

  it('elapsedMs is derived from startedAt (true age survives a re-attach)', async () => {
    const generate: Gen = vi.fn(() => new Promise<GeneratedDescriptions>(() => {}))
    const id = startDescribeJob({ projectPath: '/p/a' }, { generate, persist: vi.fn(async () => {}), lang: async () => 'en' })
    const st = getDescribeJobState(id, Date.now() + 5_000)
    expect(st?.elapsedMs).toBeGreaterThanOrEqual(5_000)
    cancelDescribeJob(id)
    await settle()
  })
})

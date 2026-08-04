import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { buildGenerateElementsPrompt } from './canvasAi'

// ─── 「時間制限は意味ある？」(owner, 2026-08-04) ────────────────────────────
//
// Mostly it wasn't. Two real runs that morning, measured from their session
// transcripts:
//   · the one that SUCCEEDED took 412s against a 480s wall — 86% of the budget,
//     i.e. it was within a minute of being killed for being slow;
//   · the one that FAILED spent its entire seven minutes on 44 Bash calls
//     (ls / find / grep, one bare `find ~` alone hitting claude's own 120s
//     ceiling) and wrote nothing at all.
// A total-time ceiling was nearly fatal to the good run and far too patient with
// the lost one. It was answering the wrong question.
//
// The right question is whether the session is DOING anything. So the everyday
// limit is now silence, and total time survives only as a runaway backstop set
// far above any real job — the same split swarm has used all along (silence 10
// min, runaway 90 min). The surface a human sits watching had the weaker guard.
//
// And the deeper fix is upstream of any deadline: the brief is self-contained,
// so the model had no reason to go looking — and nothing had ever told it not
// to. The rule it did have forbade WRITING elsewhere and said nothing about
// reading.

describe('the generate prompt forbids the wandering that burned the budget', () => {
  const prompt = buildGenerateElementsPrompt('/tmp/out.json', 'a login screen')

  it('tells the model not to explore the machine', () => {
    // Not a style preference: this is the difference between the failing run and
    // a working one. Named commands rather than a vague "stay focused", because
    // the transcript shows exactly which ones it reached for.
    expect(prompt).toMatch(/do not run ls, find, grep, cat/i)
    expect(prompt).toMatch(/do not read files/i)
  })

  it('still forbids writing anywhere else — the older rule is not replaced', () => {
    expect(prompt).toMatch(/Do not create, edit, or delete ANY other file/)
  })

  it('gives it somewhere to go when the brief names something it cannot see', () => {
    // A prohibition with no alternative gets ignored under pressure.
    expect(prompt).toMatch(/design a sensible version of it rather than searching/i)
  })
})

// The runner itself needs a live terminal pool, so the deadline behaviour is
// pinned through the module's own constants rather than by booting a PTY: the
// two numbers must stay ORDERED and far apart, which is the property that makes
// silence the everyday limit and total time a backstop.
describe('the two deadlines stay in their roles', () => {
  const src = () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require('node:fs') as typeof import('node:fs')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { resolve } = require('node:path') as typeof import('node:path')
    return readFileSync(resolve(__dirname, 'canvasAi.ts'), 'utf8')
  }

  const num = (name: string): number => {
    const m = src().match(new RegExp(`const ${name} = ([\\d_]+)`))
    expect(m, `${name} is declared`).not.toBeNull()
    return Number(m![1].replace(/_/g, ''))
  }

  it('silence is the tighter limit, by a wide margin', () => {
    const noProgress = num('NO_PROGRESS_MS')
    const ceiling = num('HARD_CEILING_MS')
    expect(noProgress).toBeLessThan(ceiling)
    // If the backstop ever creeps down near the silence budget it stops being a
    // backstop and starts deciding normal outcomes again — which is the state
    // this change exists to leave.
    expect(ceiling / noProgress).toBeGreaterThanOrEqual(5)
  })

  it('the backstop clears the slowest real run with room to spare', () => {
    // The successful generate took 412s. A ceiling that a real job can reach is
    // a ceiling that will kill one.
    expect(num('HARD_CEILING_MS')).toBeGreaterThanOrEqual(412_000 * 3)
  })

  it('names silence apart from running out of time', () => {
    // The client shows one sentence for both, but the server must not conflate
    // them: "no progress" is a hang, "timed out" is a runaway. Collapsing them
    // loses the only signal that says which one happened.
    expect(src()).toMatch(/canvas AI session made no progress/)
    expect(src()).toMatch(/canvas AI session timed out/)
  })
})

// ─── The copy ───────────────────────────────────────────────────────────────

describe('the failure message does not blame the brief', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => vi.resetModules())

  it('no longer tells the user to shorten their prompt', async () => {
    const mod = await import('@/i18n/messages/canvas')
    const all = JSON.stringify(mod)
    // The measured cause was never a long brief. Suggesting it sends the user to
    // fix something that was not broken, and hides a real hang.
    expect(all).not.toMatch(/指示を短くする/)
    expect(all).not.toMatch(/shorter brief/i)
  })
})

// ─── THE PROGRESS SIGNAL ITSELF ─────────────────────────────────────────────

describe('progress is counted, not read off a capped buffer', () => {
  const src = () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require('node:fs') as typeof import('node:fs')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { resolve } = require('node:path') as typeof import('node:path')
    return readFileSync(resolve(__dirname, 'canvasAi.ts'), 'utf8')
  }

  it('the tail buffer really does saturate — this is why the counter exists', () => {
    // Reproduces the runner's own cap. Once this pins, `buffer.length` is a
    // constant, and anything reading it sees a working session as silent.
    const MAX = 64_000
    let buffer = ''
    const paint = (n: number) => {
      buffer = (buffer + 'x'.repeat(n)).slice(-MAX)
    }
    for (let i = 0; i < 80; i++) paint(1000)
    const saturated = buffer.length
    paint(1000)
    expect(saturated).toBe(MAX)
    expect(buffer.length, 'more output, identical length').toBe(saturated)
  })

  it('the runner compares a monotonic counter, never buffer.length', () => {
    // The first version of the no-progress check compared `buffer.length`, and
    // would therefore have killed EVERY generation 120s after the buffer filled
    // — including the 412s run this whole change exists to protect. Caught in
    // review before it shipped. Pin the shape so it cannot come back.
    const text = src()
    expect(text, 'a monotonic byte counter exists').toMatch(/paintedBytes \+= chunk\.length/)
    expect(text.match(/if \(paintedBytes !== seenBytes\)/), 'the check reads the counter').not.toBeNull()
    expect(
      text.match(/buffer\.length !== seenBytes/),
      'the check must NOT read the capped tail',
    ).toBeNull()
  })
})

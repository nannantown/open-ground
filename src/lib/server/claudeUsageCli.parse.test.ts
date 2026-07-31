import { describe, it, expect, vi } from 'vitest'

// parseUsageOutput is the gauge's authoritative source: it scrapes the
// `claude /usage` TUI. The TUI loses spaces on ANSI strip ("26%used",
// "Jul 6 at 3pm") and renders each row on its own line, so the parser leans on
// a deliberately loose regex. This pins it against a fixture built from REAL
// captured output (claude 2.1.196) so a future TUI tweak that breaks the scrape
// fails here instead of silently blanking the HUD.
//
// ⚠ THE PER-MODEL ROW HAS MOVED TWICE. Three shapes have shipped:
//   • 2.1.196 — `Current week (Sonnet only)`      (the RAW fixture below)
//   • 2.1.207 — no row; a "Per-model breakdown unavailable" placeholder
//   • 2.1.220 — `Current week (Fable)`, suffix GONE (live capture 2026-07-30)
// The parser accepts BOTH suffix shapes: OG drives whatever `claude` the user
// has, so reading only the newest would move the blindness to older CLIs.
//
// ⚠ AND THE STALE VERSION OF THIS COMMENT CAUSED A REAL BUG. It said "today's CLI
// prints none, `weekModels` is [] on every real scrape" — true when written. The
// row came back in 2.1.220 in the new shape, the pattern still required "only",
// and `weekModels` stayed [] from a render that HAD the row. swarmLaunch's
// per-model exhaustion arm was dead the whole time. **A passing fixture is not
// evidence about live output — capture a real render.**
//
// node-pty / fs / claudeConnection are mocked at import time only so importing
// the module (which references node-pty) doesn't touch the real CLI; we call the
// pure parser directly and never spawn anything.
vi.mock('node-pty', () => ({ spawn: vi.fn() }))
vi.mock('./claudeConnection', () => ({
  claudeConnection: vi.fn(),
  resolvedClaudeBin: () => null,
  absoluteClaudeOnPath: () => null,
}))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, existsSync: () => true, watch: () => ({ unref: () => {}, close: () => {} }) }
})

import { parseUsageOutput } from './claudeUsageCli'

// Faithful to a captured /usage render: ANSI clear + SGR colour around the
// bars + an OSC title sequence (all must survive stripAnsi), the "NN%used"
// space-loss, and one row per line. The "Sonnet only" row is a PER-MODEL weekly
// cap — a weekly budget that belongs to one model instead of the account-wide
// pool — and the parser now extracts it (see the weekModels block below).
const ESC = '\x1b'
const RAW = [
  `${ESC}[2J${ESC}[H`, // clear screen (CSI) — stripped
  `${ESC}]0;claude${ESC}\x07`, // OSC window title — stripped
  'Current session',
  `${ESC}[38;5;28m█████████████${ESC}[39m                                     26%used`,
  'Resets 12:30am (Asia/Tokyo)',
  'Current week (all models)',
  `${ESC}[38;5;28m███████████████████████████▌${ESC}[39m                      55%used`,
  'Resets Jul 6 at 3pm (Asia/Tokyo)',
  'Current week (Sonnet only)',
  '                                                  0%used',
  'Resets Jul 6 at 3pm (Asia/Tokyo)',
  "What's contributing to your limits usage?",
].join('\n')

describe('parseUsageOutput — real /usage scrape', () => {
  it('parses session + weekAll percentages and reset times (status ok)', () => {
    const u = parseUsageOutput(RAW)

    expect(u.session).toEqual({ pct: 26, resetsAt: '12:30 am (Asia/Tokyo)' })
    expect(u.weekAll).toEqual({ pct: 55, resetsAt: 'Jul 6 at 3 pm (Asia/Tokyo)' })
    // A parsed session row means the scrape succeeded.
    expect(u.status).toBe('ok')
    expect(typeof u.capturedAt).toBe('string')
    expect(Number.isFinite(Date.parse(u.capturedAt))).toBe(true)
  })

  it('still ok with a session but a missing weekAll (null slot, status ok)', () => {
    const partial = [
      'Current session',
      '████ 12%used',
      'Resets 1:00am (Asia/Tokyo)',
      "What's contributing to your limits usage?",
    ].join('\n')
    const u = parseUsageOutput(partial)
    expect(u.session).toEqual({ pct: 12, resetsAt: '1:00 am (Asia/Tokyo)' })
    expect(u.weekAll).toBeNull()
    // The headline session % is present, so the gauge is live even without the
    // weekly row.
    expect(u.status).toBe('ok')
  })

  it('reports scrape-failed (never throws) when nothing parses', () => {
    // No session % — e.g. a future TUI format change or a truncated render. The
    // status flips to scrape-failed so the HUD shows a reason, not a silent "—".
    const u = parseUsageOutput('nothing useful here\nno percentages at all')
    expect(u.session).toBeNull()
    expect(u.weekAll).toBeNull()
    expect(u.status).toBe('scrape-failed')
  })
})

// ─── Per-model weekly rows — the 2.1.196 "only" shape ────────────────────────
// The OLD shape, still accepted for users on an older CLI. Fixtures marked
// SYNTHETIC are hand-written on the 2.1.196 model; the 2.1.220 shape has its own
// describe block below with a REAL capture.
//
// These rows are worth parsing because only they can express a SINGLE model's
// exhaustion: on 2026-07-13 03:04Z `claude` refused every launch with "You've
// reached your Fable 5 limit" while the scrape read session 3% / weekAll 63% —
// the account-wide slots cannot say it.
// Which model owns a row is a property of the account's plan, so no model name
// may be hard-coded — the parser captures whatever the TUI printed.
describe('parseUsageOutput — per-model weekly rows (weekModels)', () => {
  it('extracts the per-model row from the 2.1.196 capture, model name verbatim', () => {
    expect(parseUsageOutput(RAW).weekModels).toEqual([
      { model: 'Sonnet', pct: 0, resetsAt: 'Jul 6 at 3 pm (Asia/Tokyo)' },
    ])
  })

  it('SYNTHETIC: a FABLE-only row at 100% is read even while session/weekAll look healthy', () => {
    const fableDry = [
      `${ESC}[2J${ESC}[H`,
      'Current session',
      `${ESC}[38;5;28m█${ESC}[39m                                              3%used`,
      'Resets 12:30pm (Asia/Tokyo)',
      'Current week (all models)',
      `${ESC}[38;5;28m███████████████████████████████▌${ESC}[39m             63%used`,
      'Resets Jul 20 at 3pm (Asia/Tokyo)',
      'Current week (Fable only)',
      `${ESC}[38;5;196m██████████████████████████████████████████████████${ESC}[39m 100%used`,
      'Resets Jul 20 at 3pm (Asia/Tokyo)',
      "What's contributing to your limits usage?",
    ].join('\n')

    const u = parseUsageOutput(fableDry)
    // The account-wide slots are the ones the swarm steers on — both far from
    // spent, which is why a fable-only wall is invisible to them.
    expect(u.session).toEqual({ pct: 3, resetsAt: '12:30 pm (Asia/Tokyo)' })
    expect(u.weekAll).toEqual({ pct: 63, resetsAt: 'Jul 20 at 3 pm (Asia/Tokyo)' })
    // …and this is the row that WOULD say the flagship is done for the week — if
    // the CLI still printed one. It does not (⚠ above): this input is invented.
    expect(u.weekModels).toEqual([
      { model: 'Fable', pct: 100, resetsAt: 'Jul 20 at 3 pm (Asia/Tokyo)' },
    ])
    expect(u.status).toBe('ok')
  })

  it('SYNTHETIC: keeps EVERY per-model row (a plan could show more than one) and tolerates the version suffix', () => {
    // First-match-wins would latch onto the healthy Opus row and miss the dry
    // flagship below it, so every row is scanned.
    const twoRows = [
      'Current session',
      '█ 3%used',
      'Resets 12:30pm (Asia/Tokyo)',
      'Current week (all models)',
      '███ 63%used',
      'Resets Jul 20 at 3pm (Asia/Tokyo)',
      'Current week (Opus only)',
      '██ 30%used',
      'Resets Jul 20 at 3pm (Asia/Tokyo)',
      'Current week (Fable 5 only)',
      '█████ 100%used',
      'Resets Jul 20 at 3pm (Asia/Tokyo)',
    ].join('\n')

    expect(parseUsageOutput(twoRows).weekModels).toEqual([
      { model: 'Opus', pct: 30, resetsAt: 'Jul 20 at 3 pm (Asia/Tokyo)' },
      // "Fable 5", not "Fable" — the label is passed through verbatim; matching
      // it to a swarm tier is swarmLaunch's job, not the parser's.
      { model: 'Fable 5', pct: 100, resetsAt: 'Jul 20 at 3 pm (Asia/Tokyo)' },
    ])
  })

  it('SYNTHETIC: survives the TUI space loss in the header itself ("Currentweek(Fable5only)")', () => {
    // stripAnsi routinely welds a row's words together (that is why "100%used"
    // has no space either). The header regex is \s*-tolerant at every seam, so a
    // fully-concatenated row still parses.
    const welded = [
      'Currentsession',
      '█ 3%used',
      'Resets12:30pm(Asia/Tokyo)',
      'Currentweek(allmodels)',
      '███ 63%used',
      'ResetsJul20at3pm(Asia/Tokyo)',
      'Currentweek(Fable5only)',
      '█████ 100%used',
      'ResetsJul20at3pm(Asia/Tokyo)',
    ].join('\n')

    const u = parseUsageOutput(welded)
    expect(u.session?.pct).toBe(3)
    expect(u.weekAll?.pct).toBe(63)
    expect(u.weekModels).toEqual([
      { model: 'Fable5', pct: 100, resetsAt: 'Jul 20 at 3 pm (Asia/Tokyo)' },
    ])
  })

  it('2.1.207 SHAPE: two rows + the "unavailable" placeholder ⇒ weekModels [] IS the correct result', () => {
    // Reconstructed from the live render the commander captured 2026-07-13 04:5xZ
    // — two rows, and where 2.1.196 printed `Current week (Sonnet only)` there was
    // a placeholder. (Byte-exactness is not claimed; what this pins is that the
    // placeholder yields NO per-model row and does not corrupt the two rows that
    // do exist.) A user on that build still gets a correct, empty reading.
    const live = [
      'Current session',
      '████ 3%used',
      'Resets 12:30pm (Asia/Tokyo)',
      'Current week (all models)',
      '███ 63%used',
      'Resets Jul 20 at 3pm (Asia/Tokyo)',
      'Per-model breakdown unavailable (rate limited — try again in a moment)',
      'r to retry',
      "What's contributing to your limits usage?",
    ].join('\n')

    const u = parseUsageOutput(live)
    expect(u.session).toEqual({ pct: 3, resetsAt: '12:30 pm (Asia/Tokyo)' })
    expect(u.weekAll).toEqual({ pct: 63, resetsAt: 'Jul 20 at 3 pm (Asia/Tokyo)' })
    // No row to read ⇒ empty. An operator seeing `[]` from /api/usage is looking
    // at a HEALTHY scrape of today's CLI, not a stale bundle or a broken parser.
    expect(u.weekModels).toEqual([])
    expect(u.status).toBe('ok')
  })

  it('the account-wide "(all models)" row is never mistaken for a per-model one', () => {
    const twoSectionsOnly = [
      'Current session',
      '████ 12%used',
      'Resets 1:00am (Asia/Tokyo)',
      'Current week (all models)',
      '███ 40%used',
      'Resets Jul 6 at 3pm (Asia/Tokyo)',
    ].join('\n')

    const u = parseUsageOutput(twoSectionsOnly)
    expect(u.session).toEqual({ pct: 12, resetsAt: '1:00 am (Asia/Tokyo)' })
    expect(u.weekAll).toEqual({ pct: 40, resetsAt: 'Jul 6 at 3 pm (Asia/Tokyo)' })
    // ⚠ This USED to be free: the pattern required a trailing "only", which the
    // account-wide parenthetical never has. 2.1.220 dropped the suffix, so the
    // pattern no longer discriminates and the label is excluded EXPLICITLY.
    // If that exclusion regresses, this row parses as a model named "all models"
    // and isTopTierExhaustedByUsage starts steering on the account-wide number.
    expect(u.weekModels).toEqual([])
    expect(u.status).toBe('ok')
  })

  it('excludes the account-wide row even WELDED by the TUI space loss ("(allmodels)")', () => {
    // The exclusion has to survive the same space loss the header regex does —
    // a substring compare against "all models" would miss "allmodels".
    const welded = [
      'Currentsession',
      '████ 12%used',
      'Resets1:00am(Asia/Tokyo)',
      'Currentweek(allmodels)',
      '███ 40%used',
      'ResetsJul6at3pm(Asia/Tokyo)',
    ].join('\n')

    const u = parseUsageOutput(welded)
    expect(u.weekAll?.pct).toBe(40)
    expect(u.weekModels).toEqual([])
  })
})

// ─── The 2.1.220 shape: the per-model row came back, WITHOUT "only" ──────────
// The row that 2.1.196 printed as `Current week (Sonnet only)` and 2.1.207 did
// not print at all is BACK in 2.1.220 — as `Current week (Fable)`. The "only"
// suffix is gone: the CLI builds the label from the API's `weekly_scoped` field
// and there is no `only)` format string left in the 2.1.220 binary.
//
// This mattered: the parser required the suffix, so it read [] from a render
// that HAD the row, and isTopTierExhaustedByUsage's per-model arm was dead.
describe('parseUsageOutput — 2.1.220 per-model rows (no "only" suffix)', () => {
  it('LIVE CAPTURE (claude 2.1.220): reads the per-model row from real /usage output', () => {
    // REAL, not synthetic — captured 2026-07-30 from `claude -p "/usage"`.
    // One row per line, a ":" after the header, "·" before a LOWERCASE "resets".
    const live = [
      'You are currently using your subscription to power your Claude Code usage',
      '',
      'Current session: 1% used · resets Jul 30 at 5am (Asia/Tokyo)',
      'Current week (all models): 56% used · resets Aug 3 at 3pm (Asia/Tokyo)',
      'Current week (Fable): 30% used · resets Aug 3 at 3pm (Asia/Tokyo)',
      '',
      "What's contributing to your limits usage?",
    ].join('\n')

    const u = parseUsageOutput(live)
    expect(u.session).toEqual({ pct: 1, resetsAt: 'Jul 30 at 5 am (Asia/Tokyo)' })
    expect(u.weekAll).toEqual({ pct: 56, resetsAt: 'Aug 3 at 3 pm (Asia/Tokyo)' })
    expect(u.weekModels).toEqual([
      { model: 'Fable', pct: 30, resetsAt: 'Aug 3 at 3 pm (Asia/Tokyo)' },
    ])
    expect(u.status).toBe('ok')
  })

  it('reads a suffix-less row in the TUI shape too (own line + space loss)', () => {
    const tui = [
      'Currentsession',
      '█ 3%used',
      'Resets12:30pm(Asia/Tokyo)',
      'Currentweek(allmodels)',
      '███ 63%used',
      'ResetsJul20at3pm(Asia/Tokyo)',
      'Currentweek(Fable5)',
      '█████ 100%used',
      'ResetsJul20at3pm(Asia/Tokyo)',
    ].join('\n')

    const u = parseUsageOutput(tui)
    expect(u.weekAll?.pct).toBe(63)
    expect(u.weekModels).toEqual([
      { model: 'Fable5', pct: 100, resetsAt: 'Jul 20 at 3 pm (Asia/Tokyo)' },
    ])
  })

  it('accepts BOTH shapes in one render — the CLI a user runs is not ours to choose', () => {
    // OG drives whatever `claude` is on the machine, so dropping the 2.1.196
    // shape to add the 2.1.220 one would just move the blindness to older CLIs.
    const mixed = [
      'Current session',
      '█ 3%used',
      'Resets 12:30pm (Asia/Tokyo)',
      'Current week (all models)',
      '███ 63%used',
      'Resets Jul 20 at 3pm (Asia/Tokyo)',
      'Current week (Opus only)',
      '██ 30%used',
      'Resets Jul 20 at 3pm (Asia/Tokyo)',
      'Current week (Fable 5)',
      '█████ 100%used',
      'Resets Jul 20 at 3pm (Asia/Tokyo)',
    ].join('\n')

    expect(parseUsageOutput(mixed).weekModels).toEqual([
      { model: 'Opus', pct: 30, resetsAt: 'Jul 20 at 3 pm (Asia/Tokyo)' },
      { model: 'Fable 5', pct: 100, resetsAt: 'Jul 20 at 3 pm (Asia/Tokyo)' },
    ])
  })

  it('BACK-COMPAT: a failed scrape still yields an empty list, never undefined', () => {
    expect(parseUsageOutput('nothing useful here').weekModels).toEqual([])
  })
})

import { describe, it, expect, vi } from 'vitest'

// parseUsageOutput is the gauge's authoritative source: it scrapes the
// `claude /usage` TUI. The TUI loses spaces on ANSI strip ("26%used",
// "Jul 6 at 3pm") and renders each row on its own line, so the parser leans on
// a deliberately loose regex. This pins it against a fixture built from REAL
// captured output (claude 2.1.196) so a future TUI tweak that breaks the scrape
// fails here instead of silently blanking the HUD.
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
// space-loss, and one row per line. The "Sonnet only" row is realistic extra
// output the parser must tolerate but no longer extracts (the HUD only uses
// session + weekAll).
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

import { describe, it, expect } from 'vitest'
import {
  CTRL_U,
  MAX_SLASH_ARG,
  isClaudeSlashCommand,
  sanitizeSlashArg,
  sendClaudeSlash,
  type ClaudeSlashDeps,
} from './claudeSlash'

/** Recording seams — no PTY pool, no real screen. `writes` is the evidence: a
 *  refused send must leave it EMPTY (nothing typed into the user's session). */
const harness = (screen: string | null = null, live = true) => {
  const writes: string[] = []
  const deps: ClaudeSlashDeps = {
    getScreen: () => screen,
    write: (_id, data) => {
      if (!live) return false
      writes.push(data)
      return true
    },
  }
  return { writes, deps }
}

// A pane mid-turn: claude's footer under the input box's closing rule.
const BUSY_SCREEN = ['⏺ thinking…', '─────────────────────', '  esc to interrupt'].join('\n')
const IDLE_SCREEN = ['⏺ done', '─────────────────────', '  ? for shortcuts'].join('\n')

describe('isClaudeSlashCommand — the allowlist', () => {
  it('accepts exactly the two escape-hatch commands', () => {
    expect(isClaudeSlashCommand('compact')).toBe(true)
    expect(isClaudeSlashCommand('clear')).toBe(true)
  })

  it('rejects everything else, including near-misses and non-strings', () => {
    for (const v of ['exit', 'compact ', '/compact', 'COMPACT', '', null, undefined, 42, {}]) {
      expect(isClaudeSlashCommand(v)).toBe(false)
    }
  })
})

describe('sendClaudeSlash — typing the command into a live pane', () => {
  it('kills the line first, then submits the command', () => {
    const { writes, deps } = harness(IDLE_SCREEN)
    expect(sendClaudeSlash('t1', 'compact', undefined, deps)).toEqual({ ok: true })
    // Ctrl-U as its own keystroke, so the TUI clears a half-typed line BEFORE
    // the command text arrives (spike §3-B1: otherwise it becomes a prefix).
    expect(writes).toEqual([CTRL_U, '/compact\r'])
  })

  it('sends /clear the same way', () => {
    const { writes, deps } = harness(IDLE_SCREEN)
    expect(sendClaudeSlash('t1', 'clear', undefined, deps)).toEqual({ ok: true })
    expect(writes).toEqual([CTRL_U, '/clear\r'])
  })

  it('appends a focus hint to /compact', () => {
    const { writes, deps } = harness()
    expect(sendClaudeSlash('t1', 'compact', 'keep the API redesign', deps)).toEqual({ ok: true })
    expect(writes[1]).toBe('/compact keep the API redesign\r')
  })

  it('ignores a focus hint on /clear — it takes no argument', () => {
    const { writes, deps } = harness()
    sendClaudeSlash('t1', 'clear', 'keep this', deps)
    expect(writes[1]).toBe('/clear\r')
  })

  it('refuses an unknown command WITHOUT typing anything', () => {
    const { writes, deps } = harness()
    expect(sendClaudeSlash('t1', 'exit', undefined, deps)).toEqual({
      ok: false,
      reason: 'unknown-command',
    })
    // The teeth: a raw pty write is arbitrary typing, so a rejected command
    // must not reach the pane at all — not even the Ctrl-U.
    expect(writes).toEqual([])
  })

  it('refuses while claude is generating, WITHOUT typing anything', () => {
    const { writes, deps } = harness(BUSY_SCREEN)
    expect(sendClaudeSlash('t1', 'compact', undefined, deps)).toEqual({ ok: false, reason: 'busy' })
    expect(writes).toEqual([])
  })

  it('still sends when the screen is unreadable — the hatch must not lock itself', () => {
    const { writes, deps } = harness(null)
    expect(sendClaudeSlash('t1', 'compact', undefined, deps)).toEqual({ ok: true })
    expect(writes).toHaveLength(2)
  })

  it('reports not-found when the pane is gone', () => {
    const { deps } = harness(null, false)
    expect(sendClaudeSlash('dead', 'clear', undefined, deps)).toEqual({
      ok: false,
      reason: 'not-found',
    })
  })
})

describe('sanitizeSlashArg — the focus text can only ever be one typed line', () => {
  it('turns every control character into a space', () => {
    // A bare CR would SUBMIT mid-string and run the rest as its own command —
    // the injection this scrub exists to stop.
    expect(sanitizeSlashArg('keep API\rrm -rf /')).toBe('keep API rm -rf /')
    expect(sanitizeSlashArg('a\nb')).toBe('a b')
    expect(sanitizeSlashArg('a\u001b[31mb')).toBe('a [31mb')
    expect(sanitizeSlashArg('a\u0000b')).toBe('a b')
  })

  it('has no control characters left in the composed line', () => {
    const { writes, deps } = harness()
    sendClaudeSlash('t1', 'compact', 'one\rtwo\nthree', deps)
    // Only the trailing CR we add ourselves — nothing from the user's text.
    expect(writes[1]).toBe('/compact one two three\r')
    expect(writes[1].slice(0, -1)).not.toMatch(/[\u0000-\u001f]/)
  })

  it('collapses whitespace, trims, and caps the length', () => {
    expect(sanitizeSlashArg('  a   b  ')).toBe('a b')
    expect(sanitizeSlashArg('x'.repeat(MAX_SLASH_ARG + 50))).toHaveLength(MAX_SLASH_ARG)
  })

  it('yields empty for anything unusable', () => {
    expect(sanitizeSlashArg(undefined)).toBe('')
    expect(sanitizeSlashArg(null)).toBe('')
    expect(sanitizeSlashArg(123)).toBe('')
    expect(sanitizeSlashArg('   ')).toBe('')
  })

  it('drops the space when the hint sanitizes to nothing', () => {
    const { writes, deps } = harness()
    sendClaudeSlash('t1', 'compact', '\r\n', deps)
    expect(writes[1]).toBe('/compact\r')
  })
})

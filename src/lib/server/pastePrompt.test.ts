import { describe, it, expect } from 'vitest'
import {
  bracketedPaste,
  buildCustomModulePrompt,
  BRACKETED_PASTE_START,
  BRACKETED_PASTE_END,
} from './pastePrompt'
import { buildTaskPrompt } from './taskPrompt'

// Byte contract for the paste-task injection string. The route writes this
// VERBATIM to the PTY, so the assertions here are the real product behaviour:
// bracketed-paste framing (the TUI treats it as one literal paste — embedded
// newlines do NOT submit) and, load-bearing, NO trailing newline — insertion
// must never auto-send the prompt.

describe('bracketedPaste', () => {
  it('wraps the text in ESC[200~ … ESC[201~', () => {
    const out = bracketedPaste('hello')
    expect(out).toBe('\x1b[200~hello\x1b[201~')
    expect(out.startsWith(BRACKETED_PASTE_START)).toBe(true)
    expect(out.endsWith(BRACKETED_PASTE_END)).toBe(true)
  })

  it('never appends a trailing newline or carriage return (insert, do not send)', () => {
    const out = bracketedPaste('line one\nline two')
    expect(out.endsWith('\x1b[201~')).toBe(true)
    expect(out.endsWith('\n')).toBe(false)
    expect(out.endsWith('\r')).toBe(false)
    // The inner newline survives untouched — it's part of the pasted body.
    expect(out).toContain('line one\nline two')
  })

  it('strips embedded paste markers so the span cannot be closed early (injection guard)', () => {
    // A payload that smuggles a paste-END marker followed by a CR. Pre-fix this
    // would close bracketed paste early and the `\r悪意` would submit as raw
    // keys. After the fix the only END marker is the one we append, and there
    // is no bare ESC left in the body.
    const out = bracketedPaste('safe\x1b[201~\rinjected')
    // Exactly one START and one END, both ours, at the extremes.
    expect(out.startsWith('\x1b[200~')).toBe(true)
    expect(out.endsWith('\x1b[201~')).toBe(true)
    expect(out.indexOf('\x1b[201~')).toBe(out.length - BRACKETED_PASTE_END.length)
    // No bare ESC survives inside the body.
    const body = out.slice(BRACKETED_PASTE_START.length, out.length - BRACKETED_PASTE_END.length)
    expect(body.includes('\x1b')).toBe(false)
    // The `[201~\rinjected` text remains as inert characters (ESC gone).
    expect(body).toBe('safe[201~\rinjected')
  })

  it('strips a smuggled START marker too', () => {
    const out = bracketedPaste('a\x1b[200~b')
    const body = out.slice(BRACKETED_PASTE_START.length, out.length - BRACKETED_PASTE_END.length)
    expect(body).toBe('a[200~b')
    expect(body.includes('\x1b')).toBe(false)
  })

  it('frames a full buildTaskPrompt output: starts with ESC[200~, ends with ESC[201~, no trailing \\n', () => {
    const prompt = buildTaskPrompt({
      cwd: '/tmp/proj',
      task: { id: 't1', title: 'Ship the thing', notes: 'multi\nline\nnotes' },
      port: 47776,
      worktreesDir: '/tmp/central/worktrees',
    })
    const out = bracketedPaste(prompt)
    expect(out.startsWith('\x1b[200~')).toBe(true)
    expect(out.endsWith('\x1b[201~')).toBe(true)
    expect(out.endsWith('\n')).toBe(false)
    expect(out).toBe('\x1b[200~' + prompt + '\x1b[201~')
  })
})

describe('buildCustomModulePrompt', () => {
  it('carries the label, description and react editing instructions', () => {
    const out = buildCustomModulePrompt({
      label: 'My Tab',
      description: 'shows a chart',
      framework: 'react',
    })
    expect(out).toContain('My Tab')
    expect(out).toContain('shows a chart')
    expect(out).toContain('source.tsx')
    expect(out).toContain('lucide-react')
    expect(out).toContain('hot-reloads')
  })

  it('points at source.html for the html framework', () => {
    const out = buildCustomModulePrompt({ label: 'H', description: '', framework: 'html' })
    expect(out).toContain('source.html')
    expect(out).not.toContain('source.tsx')
    // Empty description is rendered as an explicit placeholder, not blank.
    expect(out).toContain('(none)')
  })
})

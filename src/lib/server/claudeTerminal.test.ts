import { describe, it, expect } from 'vitest'
import { shellQuoteArg } from './claudeTerminal'

describe('shellQuoteArg (PowerShell / POSIX prompt quoting)', () => {
  describe('win32 (PowerShell single-quoted string)', () => {
    it('wraps a plain string in single quotes', () => {
      expect(shellQuoteArg('hello', 'win32')).toBe("'hello'")
    })

    it("doubles embedded single quotes ('→'')", () => {
      // PowerShell escapes a literal ' inside a single-quoted string by
      // doubling it. `it's` → 'it''s'.
      expect(shellQuoteArg("it's a test", 'win32')).toBe("'it''s a test'")
    })

    it('preserves embedded newlines (multi-line prompt)', () => {
      const prompt = 'line one\nline two\nline three'
      expect(shellQuoteArg(prompt, 'win32')).toBe(
        "'line one\nline two\nline three'",
      )
    })

    it('does not mangle backslashes (literal in single-quoted PS string)', () => {
      expect(shellQuoteArg('C:\\path\\file', 'win32')).toBe("'C:\\path\\file'")
    })
  })

  describe('posix (zsh/bash single-quoted string)', () => {
    it('wraps a plain string in single quotes', () => {
      expect(shellQuoteArg('hello', 'darwin')).toBe("'hello'")
    })

    it("escapes embedded single quotes via the '\\'' idiom", () => {
      expect(shellQuoteArg("it's", 'darwin')).toBe("'it'\\''s'")
    })

    it('preserves embedded newlines', () => {
      expect(shellQuoteArg('a\nb', 'darwin')).toBe("'a\nb'")
    })
  })
})

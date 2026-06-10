import { describe, it, expect } from 'vitest'
import { shellQuotePath } from './terminalFileDrop'

// Quoting contract for paths pasted into the PTY on file drop: boring paths
// stay bare, anything shell-hostile gets single-quoted with embedded quotes
// escaped the POSIX way ('\'' splice).

describe('shellQuotePath', () => {
  it('leaves boring absolute paths bare', () => {
    expect(shellQuotePath('/Users/me/projects/app/src/main.ts')).toBe(
      '/Users/me/projects/app/src/main.ts',
    )
    expect(shellQuotePath('~/notes/todo.md')).toBe('~/notes/todo.md')
  })

  it('quotes spaces', () => {
    expect(shellQuotePath('/Users/me/My Documents/file.txt')).toBe(
      "'/Users/me/My Documents/file.txt'",
    )
  })

  it('quotes Japanese filenames', () => {
    expect(shellQuotePath('/tmp/設計メモ.md')).toBe("'/tmp/設計メモ.md'")
  })

  it('escapes single quotes POSIX-style', () => {
    expect(shellQuotePath("/tmp/it's here.txt")).toBe("'/tmp/it'\\''s here.txt'")
  })

  it('quotes shell metacharacters', () => {
    expect(shellQuotePath('/tmp/a;rm -rf$(x)&.txt')).toBe("'/tmp/a;rm -rf$(x)&.txt'")
  })
})

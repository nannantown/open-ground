import { describe, it, expect } from 'vitest'
import { claudeDirName } from './claudeProjectDir'

// These tests use paths that do NOT exist on the test host, so realpathSync
// throws and claudeDirName falls back to the literal input — which is exactly
// the pure string transform we want to assert (independent of host OS).
describe('claudeDirName', () => {
  it('hyphenates a POSIX path (/, ., space → -)', () => {
    // Matches Claude Code's ~/.claude/projects/<dir> scheme on macOS/Linux.
    expect(claudeDirName('/Users/me/projects/OPEN GROUND')).toBe(
      '-Users-me-projects-OPEN-GROUND',
    )
  })

  it('hyphenates dotted POSIX segments', () => {
    expect(claudeDirName('/Users/me/.config/app v2')).toBe(
      '-Users-me--config-app-v2',
    )
  })

  it('hyphenates a Windows path (\\, : also → -)', () => {
    // C:\Users\foo\My Proj → C--Users-foo-My-Proj (drive colon + backslash +
    // space all collapse to -). Without the \\ and : handling the observer
    // could never locate Claude's session JSONL dir on Windows.
    expect(claudeDirName('C:\\Users\\foo\\My Proj')).toBe('C--Users-foo-My-Proj')
  })

  it('handles a Windows path with a dotted folder', () => {
    expect(claudeDirName('D:\\work\\app.v2\\src')).toBe('D--work-app-v2-src')
  })
})

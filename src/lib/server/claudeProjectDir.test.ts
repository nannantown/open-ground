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

  // ── the 2026-07-30 correction ────────────────────────────────────────────
  // The transform was a character LIST (/ . \ : space) and `_` was not on it,
  // so any project path containing an underscore resolved to a directory that
  // does not exist — and every transcript-backed reading fails OPEN, so the
  // bug presented as "no evidence" rather than as an error.
  //
  // ⚠ These expectations are MEASURED against the real CLI (2.1.220), not
  // inferred. Re-measure with a live run before changing them — a directory
  // listing under ~/.claude/projects is history (it still holds pre-tightening
  // names), not the current rule.
  it('hyphenates UNDERSCORES — the char the old list missed', () => {
    expect(claudeDirName('/Users/me/my_project/src')).toBe('-Users-me-my-project-src')
  })

  it('hyphenates every non-alphanumeric char, one dash each, runs not collapsed', () => {
    // Live capture 2026-07-30:
    //   /private/tmp/ogprobechars_vtkh/x.y_z+w@v e-f~g
    //     → -private-tmp-ogprobechars-vtkh-x-y-z-w-v-e-f-g
    expect(claudeDirName('/private/tmp/ogprobechars_vtkh/x.y_z+w@v e-f~g')).toBe(
      '-private-tmp-ogprobechars-vtkh-x-y-z-w-v-e-f-g',
    )
  })

  it('keeps a run of separators as a run of dashes (no collapsing)', () => {
    expect(claudeDirName('/a//b__c')).toBe('-a--b--c')
  })

  it('hyphenates non-ASCII path segments — ONE dash per character', () => {
    // Live capture 2026-07-30 (this one matters: the owner's own projects can
    // sit under Japanese paths):
    //   /private/tmp/ogprobeja_B2Z7/プロジェクト/src
    //     → -private-tmp-ogprobeja-B2Z7--------src
    // i.e. the 6 kana/kanji became 6 dashes, not one. Eight dashes here = the
    // separator before, six characters, the separator after.
    expect(claudeDirName('/Users/me/プロジェクト/src')).toBe('-Users-me--------src')
    //
    // ⚠ UNMEASURED: an astral-plane character (emoji, some CJK extensions) is
    // TWO UTF-16 code units, so this transform emits two dashes for it. Whether
    // the CLI counts code points or code units there was not tested — measure
    // before relying on a path that contains one.
  })
})

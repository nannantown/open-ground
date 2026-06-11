import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  cleanWhisperOutput,
  resolveWhisperBinary,
  stripNoiseAnnotations,
  voiceModelPath,
} from './voice'

// HOME isolation: src/test/setup-home.ts points OPENGROUND_HOME at a throwaway
// tmp dir before any test module loads, so voiceModelPath below never resolves
// into the real ~/.openground.

describe('cleanWhisperOutput', () => {
  it('trims the leading space whisper-cli -nt puts on every line', () => {
    expect(cleanWhisperOutput(' Hello world.\n And a second line.\n')).toBe(
      'Hello world.\nAnd a second line.',
    )
  })

  it('drops blank lines (including whitespace-only ones)', () => {
    expect(cleanWhisperOutput('\n one \n\n   \n two \n\n')).toBe('one\ntwo')
  })

  it('returns the empty string for whitespace-only input', () => {
    expect(cleanWhisperOutput('  \n \n')).toBe('')
  })
})

describe('stripNoiseAnnotations', () => {
  it('drops lines that are only a bracketed annotation', () => {
    expect(stripNoiseAnnotations('[BLANK_AUDIO]')).toBe('')
    expect(stripNoiseAnnotations('Hello.\n[Music]\nWorld.')).toBe('Hello.\nWorld.')
  })

  it('drops lines that are only a parenthesized annotation', () => {
    expect(stripNoiseAnnotations('(wind blowing)\nReal speech.')).toBe('Real speech.')
    expect(stripNoiseAnnotations('（拍手）\n(拍手)\nこんにちは')).toBe('こんにちは')
  })

  it('keeps brackets that appear inside real speech', () => {
    expect(stripNoiseAnnotations('use the [id] param here')).toBe('use the [id] param here')
    expect(stripNoiseAnnotations('call foo(bar) next')).toBe('call foo(bar) next')
  })

  it('leaves already-clean single-line text untouched', () => {
    expect(cleanWhisperOutput('こんにちは。')).toBe('こんにちは。')
  })
})

describe('voiceModelPath', () => {
  it('builds ~/.openground/models/ggml-<model>.bin for every model size', () => {
    const home = process.env.OPENGROUND_HOME!
    for (const model of ['base', 'small', 'medium'] as const) {
      expect(voiceModelPath(model)).toBe(join(home, 'models', `ggml-${model}.bin`))
    }
  })

  it('stays under the (isolated) OPEN GROUND home', () => {
    expect(voiceModelPath('small').startsWith(process.env.OPENGROUND_HOME!)).toBe(true)
  })
})

describe('resolveWhisperBinary', () => {
  it('resolves an executable override to itself', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openground-voice-test-'))
    const bin = join(dir, 'whisper-cli')
    writeFileSync(bin, '#!/bin/sh\nexit 0\n')
    chmodSync(bin, 0o755)
    expect(resolveWhisperBinary(bin)).toBe(bin)
  })

  it('ignores a non-executable override', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openground-voice-test-'))
    const notExec = join(dir, 'whisper-cli')
    writeFileSync(notExec, 'not a binary')
    chmodSync(notExec, 0o644)
    expect(resolveWhisperBinary(notExec)).not.toBe(notExec)
  })

  it('falls through a nonexistent override to system detection (null when absent)', () => {
    // The dev machine may genuinely have whisper-cli installed (PATH or
    // Homebrew) — assert the override falls through to exactly whatever the
    // no-override resolution yields, which is null on a machine without it.
    const system = resolveWhisperBinary(null)
    expect(resolveWhisperBinary('/no/such/dir/whisper-cli-xyz')).toBe(system)
    if (system !== null) {
      // When present it must at least be an absolute path ending in the binary name.
      expect(system).toMatch(/^\/.*whisper-cli$/)
    }
  })
})

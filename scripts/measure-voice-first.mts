// How long the call's first sentence takes to become sound, per voice: the
// system voice (until its first buffer) vs VOICEVOX Nemo / 冥鳴ひまり (the
// whole sentence — it comes in one piece). Nothing goes to the speaker:
// og-listen --tts writes files (native/og-listen/main.swift), and each file is
// read back by the Mac's recognizer as a check that it really is the sentence.
//
//   OPENGROUND_HOME=/tmp/og-voice npx tsx scripts/measure-voice-first.mts <og-listen binary> [runs=3]
//
// Fetches the VOICEVOX files into $OPENGROUND_HOME/voicevox first (voicevox.ts,
// the app's own download and SHA-256 check; ~250 MB once). Point
// OPENGROUND_HOME at a scratch folder, not your real one.
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchVoice, voicevoxDir } from '../src/lib/server/voicevox'

const [bin, runsArg] = process.argv.slice(2)
if (!bin || !process.env.OPENGROUND_HOME) throw new Error('usage: OPENGROUND_HOME=<scratch> npx tsx scripts/measure-voice-first.mts <og-listen> [runs]')
const runs = Number(runsArg ?? 3)
const lines = ['了解しました。', 'すぐに確認しますね。', '今日の作業は三つ終わりました。', '残っているのは、通話画面のボタンの見直しと、読み上げの声の調査です。']
// After a barge-in: the first sentence of the next answer, behind what the stop left being made
// (a render cannot be cancelled) — a short line, a long one, and a long one made whole (before the pieces).
const NEXT = 'すぐに確認しますね。'
const BEFORE: [string, string[]][] = [
  ['short line before', ['--after', '了解しました。']],
  ['long line before', ['--after', '残っているのは、通話画面のボタンの見直しと、読み上げの声の調査と、設定画面の文言の確認です。']],
  ['long line before, made whole', ['--after', '残っているのは、通話画面のボタンの見直しと、読み上げの声の調査と、設定画面の文言の確認です。', '--whole']],
]
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]
/** og-listen --file keeps listening to stdin (its parent): open until it answers. */
const hear = (file: string) =>
  new Promise<string>((resolve) => {
    const child = spawn(bin, ['ja-JP', '--file', file], { stdio: ['pipe', 'pipe', 'ignore'] })
    let buf = ''
    child.stdout.setEncoding('utf8').on('data', (c: string) => (buf += c))
    child.on('close', () => resolve((JSON.parse(buf.trim().split('\n').pop() || '{}') as { text?: string }).text ?? '(nothing)'))
  })
const out = mkdtempSync(join(tmpdir(), 'og-voice-first-'))

for (const v of ['nemo', 'himari'] as const) if (!(await fetchVoice(v))) throw new Error(`fetch ${v} failed`)
const voices: [string, string[]][] = [
  ['system', []],
  ['nemo', ['--voicevox', voicevoxDir(), '--vv', 'n0.vvm', '10005']],
  ['himari', ['--voicevox', voicevoxDir(), '--vv', '1.vvm', '14']],
]
try {
  for (const [name, extra] of voices) {
    const firsts: number[] = []
    let load = 0
    for (const [n, line] of lines.entries()) {
      for (let r = 0; r < runs; r++) {
        const file = join(out, `${name}-${n}.caf`)
        const e = JSON.parse(execFileSync(bin, ['ja-JP', '--tts', line, file, ...extra], { encoding: 'utf8' }).trim().split('\n').pop()!)
        firsts.push(e.first)
        load = Math.max(load, e.load ?? 0)
      }
      console.log(`${name}\t「${line}」 heard as 「${await hear(join(out, `${name}-${n}.caf`))}」`)
    }
    firsts.sort((a, b) => a - b)
    console.log(`${name}\tfirst sound: median ${firsts[firsts.length >> 1]} ms, max ${firsts.at(-1)} ms${load ? `, one-time load ${load} ms` : ''}`)
    if (name === 'system') continue
    for (const [label, more] of BEFORE) {
      const xs: number[] = []
      for (let r = 0; r < runs; r++) {
        const e = JSON.parse(execFileSync(bin, ['ja-JP', '--tts', NEXT, join(out, 'barge.caf'), ...extra, ...more], { encoding: 'utf8' }).trim().split('\n').pop()!)
        xs.push(e.first)
      }
      console.log(`${name}\tafter a barge-in (${label}): next answer's first sound median ${median(xs)} ms, max ${Math.max(...xs)} ms`)
    }
  }
} finally {
  rmSync(out, { recursive: true, force: true })
}

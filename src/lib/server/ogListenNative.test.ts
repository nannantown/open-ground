// The real og-listen (native/og-listen), on a Mac where it is built: a voice on
// the THIRD of twelve channels — how an audio interface (the owner's RME
// Babyface reports 12 inputs) hands it over — must still be heard. Before
// 2026-10-06 the helper passed interface buffers to the recognizer as they came
// and the owner's spoken words never reached the input.
//
// Built here from native/og-listen/main.swift (never a stale bin/), so it needs
// macOS with swiftc, the Kyoko voice, and speech recognition allowed for the
// app this runs under; skipped otherwise (CI has no speech).
import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync, spawn } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const dir = mkdtempSync(join(tmpdir(), 'og-listen-native-'))
const bin = join(dir, 'og-listen')
const has = (cmd: string, args: string[]) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}
const canBuild = process.platform === 'darwin' && has('xcrun', ['--find', 'swiftc']) !== null
const canRun = canBuild && /^Kyoko\b/m.test(has('say', ['-v', '?']) ?? '')
let built = false
const build = () => {
  if (!built) execFileSync('swiftc', ['-O', '-swift-version', '5', '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', 'native/og-listen/Info.plist', 'native/og-listen/main.swift', '-o', bin], { stdio: 'ignore' })
  built = true
}
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** A 16-bit mono WAV's samples, re-laid as `channels` channels with the voice on `on` only. */
const spread = (wav: Buffer, channels: number, on: number): Buffer => {
  let at = 12
  while (wav.toString('ascii', at, at + 4) !== 'data') at += 8 + wav.readUInt32LE(at + 4)
  const pcm = wav.subarray(at + 8, at + 8 + wav.readUInt32LE(at + 4))
  const frames = pcm.length / 2
  const rate = 16000
  const out = Buffer.alloc(44 + frames * channels * 2)
  out.write('RIFF', 0, 'ascii')
  out.writeUInt32LE(36 + frames * channels * 2, 4)
  out.write('WAVEfmt ', 8, 'ascii')
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20) // PCM
  out.writeUInt16LE(channels, 22)
  out.writeUInt32LE(rate, 24)
  out.writeUInt32LE(rate * channels * 2, 28)
  out.writeUInt16LE(channels * 2, 32)
  out.writeUInt16LE(16, 34)
  out.write('data', 36, 'ascii')
  out.writeUInt32LE(frames * channels * 2, 40)
  for (let i = 0; i < frames; i++) out.writeInt16LE(pcm.readInt16LE(i * 2), 44 + (i * channels + on) * 2)
  return out
}

const hear = (file: string) =>
  new Promise<{ lines: { type: string; text?: string; reason?: string }[]; signal: NodeJS.Signals | null }>((resolve) => {
    // stdin stays open: og-listen stops when it closes (the parent died).
    const child = spawn(bin, ['ja-JP', '--file', file], { stdio: ['pipe', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.setEncoding('utf8').on('data', (c: string) => (out += c))
    const timer = setTimeout(() => child.kill(), 30_000)
    child.on('close', (_code, signal) => {
      clearTimeout(timer)
      resolve({ lines: out.split('\n').filter(Boolean).map((l) => JSON.parse(l)), signal })
    })
  })

describe('og-listen (native)', () => {
  // Which mic (no speech needed). A shut MacBook lid lists its built-in mic but
  // it hears nothing: choosing it would say "ready" and stay silent for good —
  // the owner's original symptom by another road (commander review 2026-10-06).
  it.runIf(canBuild)('takes the built-in mic only for a multi-channel default, and never with the lid shut', () => {
    build()
    const choose = (channels: number, builtIn: boolean, lidShut: boolean, defaultIsBuiltIn = false) =>
      JSON.parse(execFileSync(bin, ['--choose', String(channels), builtIn ? '1' : '0', lidShut ? '1' : '0', defaultIsBuiltIn ? '1' : '0'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).device
    expect(choose(12, true, false)).toBe('builtin') // the Babyface case
    expect(choose(12, true, true)).toBe('default') // lid shut: the built-in mic is dead
    expect(choose(12, false, false)).toBe('default') // a Mac mini: no built-in mic
    expect(choose(2, true, false)).toBe('default') // a headset / USB mic chosen as default wins
    expect(choose(1, true, false)).toBe('default')
    // The default IS the built-in mic (no interface plugged in): with the lid
    // shut, another mic or none at all — never the dead one (review 2026-10-06).
    expect(choose(1, true, true, true)).toBe('elsewhere')
    expect(choose(1, true, false, true)).toBe('default')
  }, 120_000)

  it.runIf(canBuild)('reads this Mac\'s lid state and current input', () => {
    build()
    const which = JSON.parse(execFileSync(bin, ['--which'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
    expect(which.type).toBe('which')
    expect(['true', 'false']).toContain(which.lidClosed)
  }, 120_000)

  it.runIf(canRun)('hears a voice that sits on channel 3 of 12', async (ctx) => {
    build()
    expect(existsSync(bin)).toBe(true)
    const mono = join(dir, 'voice.wav')
    execFileSync('say', ['-v', 'Kyoko', '-o', mono, '--file-format=WAVE', '--data-format=LEI16@16000', '今日は良い天気ですね'])
    const multi = join(dir, 'twelve.wav')
    writeFileSync(multi, spread(readFileSync(mono), 12, 2))

    const { lines, signal } = await hear(multi)
    const refused = lines.find((l) => l.type === 'error' && (l.reason === 'denied' || l.reason === 'unavailable'))
    if (refused || signal === 'SIGABRT') return ctx.skip() // speech recognition not allowed here
    expect(lines.find((l) => l.type === 'final')?.text ?? lines).toMatch(/天気/)
  }, 120_000)

  // When the owner has finished (owner 2026-10-07: answer as soon as a person
  // would): a finished sentence is answered after a short pause, a dangling
  // particle waits longer — they may be mid-thought.
  it.runIf(canBuild)('how long a pause ends the words depends on how they end', () => {
    build()
    const pause = (words: string) => Number(JSON.parse(execFileSync(bin, ['--pause', words], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).seconds)
    for (const done of ['今日の予定を教えてください', '資料ってどこにある？', '元気です', 'それでいいよ', 'What is the plan?']) expect(pause(done), done).toBeLessThanOrEqual(0.5)
    for (const more of ['明日の会議ですが', '資料を', 'それで、', '雨だけど', 'I think that and']) expect(pause(more), more).toBeGreaterThanOrEqual(1.4)
    expect(pause('今日の予定を教えて')).toBeLessThan(1.2) // anything else: still sooner than the old fixed 1.2 s
    for (const start of ['あのね', 'なにか', 'どこか']) expect(pause(start), start).toBeGreaterThan(0.5) // how a thought starts, not ends
  }, 120_000)

  // Measured 2026-10-07 on the owner's Mac (scripts/measure-voice-latency.mjs,
  // trailing silence cut): 1.60–1.83 s before (a fixed 1.2 s pause, then up to
  // 3 s waiting for the recognizer's own final), 0.84–0.94 s after. Here with
  // say's own ~0.2 s of trailing silence left in: about 1.4 s before, 0.65 after.
  it.runIf(canRun)('a finished sentence is handed on within about a second of the voice ending', async (ctx) => {
    build()
    const file = join(dir, 'done.wav')
    execFileSync('say', ['-v', 'Kyoko', '-o', file, '--file-format=WAVE', '--data-format=LEI16@16000', '今日の予定を教えてください'])
    const got = await new Promise<{ s?: number; text?: string; refused?: boolean }>((resolve) => {
      const child = spawn(bin, ['ja-JP', '--feed', file], { stdio: ['pipe', 'pipe', 'ignore'] })
      let fed = 0
      let buf = ''
      const done = (r: { s?: number; text?: string; refused?: boolean }) => (child.kill(), resolve(r))
      child.stdout.setEncoding('utf8').on('data', (c: string) => {
        buf += c
        for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
          const e = JSON.parse(buf.slice(0, i)) as { type: string; text?: string; reason?: string }
          buf = buf.slice(i + 1)
          if (e.type === 'fed') fed = performance.now()
          if (e.type === 'final' && fed) done({ s: (performance.now() - fed) / 1000, text: e.text })
          if (e.type === 'error') done({ refused: e.reason === 'denied' || e.reason === 'unavailable' })
        }
      })
      child.on('close', (_c, signal) => signal === 'SIGABRT' && done({ refused: true }))
      setTimeout(() => done({}), 20_000)
    })
    if (got.refused) return ctx.skip() // speech recognition not allowed here
    expect(got.text).toMatch(/予定/)
    expect(got.s).toBeLessThan(1.1)
  }, 120_000)
})

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
  if (!built) execFileSync('swiftc', ['-O', '-swift-version', '5', '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', 'native/og-listen/Info.plist', '-import-objc-header', 'native/og-listen/voicevox.h', 'native/og-listen/main.swift', '-o', bin], { stdio: 'ignore' })
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

  // The call's voices without the speaker (--tts writes what a call would play).
  // The system voice always; VOICEVOX when OG_VOICEVOX_DIR points at its files
  // (src/lib/server/voicevox.ts puts them in ~/.openground/voicevox; tests never
  // download ~250 MB): read back by the recognizer, it is the sentence.
  it.runIf(canRun)('the system voice makes the sentence', async (ctx) => {
    build()
    const file = join(dir, 'tts-system.caf')
    expect(JSON.parse(execFileSync(bin, ['ja-JP', '--tts', '今日は良い天気ですね', file], { encoding: 'utf8' }).trim())).toMatchObject({ type: 'tts', voice: 'system' })
    const { lines, signal } = await hear(file)
    if (signal === 'SIGABRT' || lines.some((l) => l.reason === 'denied' || l.reason === 'unavailable')) return ctx.skip()
    expect(lines.find((l) => l.type === 'final')?.text ?? lines).toMatch(/天気/)
  }, 120_000)

  it.runIf(canBuild)('VOICEVOX that cannot start (no library) fails the line — the call then reads it with the system voice', () => {
    build()
    const r = (() => {
      try {
        return execFileSync(bin, ['ja-JP', '--tts', 'あ', join(dir, 'x.wav'), '--voicevox', join(dir, 'nowhere'), '--vv', 'n0.vvm', '10005'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      } catch (e) {
        return String((e as { stdout?: string }).stdout)
      }
    })()
    expect(JSON.parse(r.trim())).toEqual({ type: 'error', reason: 'failed' })
  }, 120_000)

  // A render cannot be cancelled: a stop leaves the piece being made, and the next answer waits
  // behind it. Short pieces keep that wait short (measured: scripts/measure-voice-first.mts).
  it.runIf(canBuild)('VOICEVOX gets a line in short pieces, cut after punctuation; a long stretch with no break goes to the system voice', () => {
    build()
    const parts = (text: string) => JSON.parse(execFileSync(bin, ['--parts', text], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).parts as string[] | null
    expect(parts('了解しました。')).toEqual(['了解しました。'])
    expect(parts('今日の作業は三つ終わりました。残っているのは、通話画面のボタンの見直しと、読み上げの声の調査です。')).toEqual([
      '今日の作業は三つ終わりました。',
      '残っているのは、',
      '通話画面のボタンの見直しと、',
      '読み上げの声の調査です。',
    ])
    expect(parts('一、二、三、四、五、六、七、八、九、十、十一、十二、十三、十四、十五。')).toEqual(['一、二、三、四、五、六、', '七、八、九、十、十一、', '十二、十三、十四、十五。'])
    // Half-width marks inside a number or a time are not breaks (they would be read apart).
    expect(parts('合計は1,234,567円になりました。')).toEqual(['合計は1,234,567円になりました。'])
    expect(parts('会議は明日の10:30からです。')).toEqual(['会議は明日の10:30からです。'])
    expect(parts('円周率は3.14です。')).toEqual(['円周率は3.14です。'])
    // A closing bracket stays with what it closes: never alone, never at the start of a piece.
    const quoted = parts('「了解しました。」と言いました。')!
    expect(quoted).toEqual(['「了解しました。」', 'と言いました。'])
    for (const q of quoted) expect(q.startsWith('」')).toBe(false)
    expect(parts('あ'.repeat(49))).toBeNull()
    expect(parts('あ'.repeat(48))).toEqual(['あ'.repeat(48)])
    // Half-width ! ? are never inside a number: a break even with Japanese right after.
    expect(parts('本当?それは困る。')).toEqual(['本当?', 'それは困る。'])
    expect(parts('本当!それは困る。')).toEqual(['本当!', 'それは困る。'])
    expect(parts('本当?' + 'あ'.repeat(46))).toEqual(['本当?', 'あ'.repeat(46)])
  }, 120_000)

  // A switch mid-line: the line's next piece asks while the new voice loads (1–4 s on the one
  // queue). It must not wait behind that load: nil at once, the system voice reads the rest.
  it.runIf(canBuild && !!process.env.OG_VOICEVOX_DIR)('a piece asked while another voice is loading gets nothing at once (never waits for the load)', () => {
    build()
    const out = execFileSync(bin, ['ja-JP', '--tts', '了解しました。', join(dir, 'unused.caf'), '--voicevox', process.env.OG_VOICEVOX_DIR!, '--vv', 'n0.vvm', '10005', '--switch', '1.vvm'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const e = JSON.parse(out.trim()) as { type: string; made: boolean; ms: number }
    expect(e).toMatchObject({ type: 'switch', made: false })
    expect(e.ms).toBeLessThan(300)
  }, 120_000)

  // Only a warm loads a voice (1–4 s): a line asking for one not loaded — a switch underway —
  // gets nothing from VOICEVOX and is read by the system voice, instead of waiting for a load.
  it.runIf(canBuild && !!process.env.OG_VOICEVOX_DIR)('a line in a voice that is not the loaded one is not made by VOICEVOX (no load on the way)', () => {
    build()
    // The line is 冥鳴ひまり's (1.vvm, style 14); the voice loaded is the line's own, or Nemo's.
    const tts = (loaded: string) => {
      try {
        return execFileSync(bin, ['ja-JP', '--tts', '了解しました。', join(dir, 'switch.caf'), '--voicevox', process.env.OG_VOICEVOX_DIR!, '--vv', '1.vvm', '14', '--warmed', loaded], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      } catch (e) {
        return String((e as { stdout?: string }).stdout)
      }
    }
    expect(JSON.parse(tts('1.vvm').trim())).toMatchObject({ type: 'tts', voice: 'voicevox' })
    expect(JSON.parse(tts('n0.vvm').trim())).toEqual({ type: 'error', reason: 'failed' })
  }, 120_000)

  it.runIf(canRun && !!process.env.OG_VOICEVOX_DIR)('VOICEVOX Nemo and 冥鳴ひまり make the sentence', async (ctx) => {
    build()
    for (const [model, style] of [['n0.vvm', '10005'], ['1.vvm', '14']]) {
      const file = join(dir, `tts-${model}.caf`)
      const out = execFileSync(bin, ['ja-JP', '--tts', '今日は、とても良い天気ですね。散歩に出かけましょう。', file, '--voicevox', process.env.OG_VOICEVOX_DIR!, '--vv', model, style], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      expect(JSON.parse(out.trim())).toMatchObject({ type: 'tts', voice: 'voicevox', pieces: 3 })
      const { lines, signal } = await hear(file)
      if (signal === 'SIGABRT' || lines.some((l) => l.reason === 'denied' || l.reason === 'unavailable')) return ctx.skip()
      expect(lines.find((l) => l.type === 'final')?.text ?? lines, model).toMatch(/天気/)
    }
  }, 180_000)

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

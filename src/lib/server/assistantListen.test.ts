// The assistant's ears hand on what og-listen hears, and end with exactly one
// plain reason — a helper killed by macOS for a missing permission (SIGABRT)
// reads as 'denied', so the screen can say "allow it in System Settings".
import { describe, it, expect, afterAll, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AssistantListenEvent } from '@/lib/types'
import { BARGE, isBargeIn, listenBinary, startListening, voiceCommand } from './assistantListen'

const dir = mkdtempSync(join(tmpdir(), 'og-listen-test-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const fake = (name: string, body: string) => {
  const p = join(dir, name)
  writeFileSync(p, `#!/bin/sh\n${body}\n`)
  chmodSync(p, 0o755)
  return p
}
const run = (bin: string, lang: 'ja' | 'en' = 'ja') =>
  new Promise<AssistantListenEvent[]>((done) => {
    const got: AssistantListenEvent[] = []
    startListening(lang, (e) => {
      got.push(e)
      if (e.type === 'error') setTimeout(() => done(got), 50) // nothing may follow
    }, bin)
  })

describe('startListening', () => {
  it('passes the heard words on, then one reason when the helper ends', async () => {
    const bin = fake('talk', `echo '{"type":"ready"}'; echo "{\\"type\\":\\"partial\\",\\"text\\":\\"$1\\"}"; echo 'noise'; echo '{"type":"final","text":"やあ"}'`)
    expect(await run(bin, 'en')).toEqual([
      { type: 'ready' },
      { type: 'partial', text: 'en-US' },
      { type: 'final', text: 'やあ' },
      { type: 'error', reason: 'failed' },
    ])
  })

  it("the helper's own reason wins, reported once", async () => {
    const bin = fake('refuse', `echo '{"type":"error","reason":"unavailable"}'; exit 2`)
    expect(await run(bin)).toEqual([{ type: 'error', reason: 'unavailable' }])
  })

  it('killed by macOS for a missing permission (SIGABRT) = denied', async () => {
    const bin = fake('abort', 'kill -ABRT $$')
    expect(await run(bin)).toEqual([{ type: 'error', reason: 'denied' }])
  })

  it('stop() ends it quietly — and the helper is really gone', async () => {
    const pidFile = join(dir, 'pid')
    const bin = fake('forever', `echo $$ > '${pidFile}'; echo '{"type":"ready"}'; exec sleep 30`)
    const got: AssistantListenEvent[] = []
    const stop = startListening('ja', (e) => got.push(e), bin)
    // Waits on what happened, not on a clock: a loaded machine starts the helper late.
    await vi.waitFor(() => expect(got).toEqual([{ type: 'ready' }]), { timeout: 10_000 })
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true))
    const pid = Number(readFileSync(pidFile, 'utf8'))
    stop()
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 10_000 })
    expect(got).toEqual([{ type: 'ready' }])
  })

  it('no helper = unavailable', async () => {
    const got: AssistantListenEvent[] = []
    startListening('ja', (e) => got.push(e), null)
    expect(got).toEqual([{ type: 'error', reason: 'unavailable' }])
  })
})

describe('listenBinary', () => {
  it.runIf(process.platform === 'darwin')('finds bin/og-listen at the app root above the module, or nothing', () => {
    const root = join(dir, 'app')
    mkdirSync(join(root, 'server', 'dist'), { recursive: true })
    expect(listenBinary(join(root, 'server', 'dist'))).toBeNull()
    mkdirSync(join(root, 'bin'))
    writeFileSync(join(root, 'bin', 'og-listen'), '')
    expect(listenBinary(join(root, 'server', 'dist'))).toBe(join(root, 'bin', 'og-listen'))
  })
})

// Talking over the call's voice (owner 2026-10-07, "A"): while it reads, what
// the mic hears counts only when all three hold — and then it only STOPS.
describe('isBargeIn', () => {
  const reading = '本日の予定をお伝えします。午前十時から企画会議があります。'
  it('all three: enough words, loud enough, not its own words', () => {
    expect(isBargeIn('ちょっと待って', -25, reading)).toBe(true)
    expect(isBargeIn('wait a second', -25, 'Here is the plan for today.')).toBe(true)
  })
  it('① too few words (a cough read as a syllable, a lone letter) — one English word is enough, like 「待って」', () => {
    expect(isBargeIn('あの', -25, reading)).toBe(false)
    expect(isBargeIn('a', -25, 'Here is the plan for today.')).toBe(false)
    expect(isBargeIn('wait', -25, 'Here is the plan for today.')).toBe(true)
  })
  it('③ in English by words: a few sentences hold most pairs of letters, not most pairs of words (review 2026-10-07)', () => {
    const long = 'Here is the plan for today. At ten there is a planning meeting, then lunch, and at two a design review. Please tell me if anything looks wrong.'
    for (const w of ['wait a second', 'stop please', 'can you repeat that']) expect(isBargeIn(w, -25, long)).toBe(true)
    expect(isBargeIn('a planning meeting', -25, long)).toBe(false)
  })
  it('③ on the latest words: its own voice run together with the owner\'s in one utterance still counts', () => {
    expect(isBargeIn('本日の予定をお伝えしますちょっと待って', -25, reading)).toBe(true)
    expect(isBargeIn('本日の予定をお伝えします午前十時から', -25, reading)).toBe(false)
  })
  it('② too quiet — what is left of its own voice after echo removal', () => {
    expect(isBargeIn('ちょっと待って', BARGE.minLevelDb - 1, reading)).toBe(false)
    expect(isBargeIn('ちょっと待って', undefined, reading)).toBe(false)
  })
  it('③ its own words coming back (kana or kanji, any width)', () => {
    expect(isBargeIn('本日の予定を', -25, reading)).toBe(false)
    expect(isBargeIn('企画会議が', -20, reading)).toBe(false)
    expect(isBargeIn('キカクカイギ', -20, 'きかくかいぎです')).toBe(false)
  })
  it('② louder than its own voice coming back, when it comes back loud', () => {
    expect(isBargeIn('ちょっと待って', -30, reading, -35)).toBe(false)
    expect(isBargeIn('ちょっと待って', -25, reading, -35)).toBe(true)
  })
  it('a nod is listening, not a turn to speak', () => {
    expect(isBargeIn('うんうん', -20, reading)).toBe(false)
    expect(isBargeIn('はい、はい', -20, reading)).toBe(false)
    expect(isBargeIn('yeah okay', -20, reading)).toBe(false)
  })
})

describe('a call: the voice and the gate', () => {
  /** A fake og-listen --call: writes what stdin says to `cmds`, and on the first
   *  "say" plays the given lines (one JSON per line) as if heard meanwhile. */
  const fakeCall = (name: string, echo: string, heardWhileReading: (object | string)[]) => {
    const cmds = join(dir, `${name}.cmds`)
    const out = heardWhileReading.map((o) => (typeof o === 'string' ? o : `echo '${JSON.stringify(o)}'`)).join('; ')
    const bin = fake(name, `echo '{"type":"ready","echo":"${echo}"}'\nwhile read -r l; do echo "$l" >> '${cmds}'; case "$l" in *'"say"'*) echo '{"type":"speak","id":"1"}'; ${out} ;; esac; done`)
    return { bin, cmds: () => (existsSync(cmds) ? readFileSync(cmds, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>) : []) }
  }
  const talk = async (bin: string, until: (got: AssistantListenEvent[]) => boolean) => {
    const got: AssistantListenEvent[] = []
    const stop = startListening('ja', (e) => {
      got.push(e)
      if (e.type === 'ready') expect(voiceCommand({ say: '本日の予定をお伝えします。', id: '1' })).toBe(true)
    }, bin, { call: true })
    await vi.waitFor(() => expect(until(got)).toBe(true), { timeout: 10_000 })
    await new Promise((r) => setTimeout(r, 100)) // nothing more may follow
    stop()
    return got.filter((e) => e.type !== 'level')
  }

  it('its own words and quiet scraps are dropped; a loud moment pauses it; the owner talking over it stops it and goes on as words', async () => {
    const f = fakeCall('over', 'on', [
      { type: 'partial', text: '本日の予定', level: -20 },
      { type: 'partial', text: '明日の会議', level: -60 },
      { type: 'level', level: -22 },
      { type: 'partial', text: '明日の会議は', level: -22 },
      { type: 'final', text: '明日の会議は何時?', level: -22 },
    ])
    const got = await talk(f.bin, (g) => g.some((e) => e.type === 'final'))
    expect(got).toEqual([
      { type: 'ready', echo: 'on' },
      { type: 'speak', id: '1' },
      { type: 'barge' },
      { type: 'partial', text: '明日の会議は', level: -22 },
      { type: 'final', text: '明日の会議は何時?', level: -22 },
    ])
    // From quiet, the reading starts with the recognizer's open words dropped (said
    // while it thought); its own barge-in stop keeps them — they are the owner's.
    expect(f.cmds()).toEqual([{ forget: true, say: '本日の予定をお伝えします。', id: '1', lang: 'ja-JP' }, { pause: true, forget: true }, { stop: true }])
  })

  it('no echo removal and no other box ("off"): nothing heard while it reads counts — no pause, no stop', async () => {
    const f = fakeCall('off', 'off', [
      { type: 'level', level: -20 },
      { type: 'partial', text: '明日の会議は', level: -20 },
      { type: 'final', text: '明日の会議は何時?', level: -20 },
      { type: 'spoke', id: '1' },
    ])
    const got = await talk(f.bin, (g) => g.some((e) => e.type === 'spoke'))
    expect(got.map((e) => e.type)).toEqual(['ready', 'speak', 'spoke'])
    // Read to the end: what the recognizer holds is its own voice — dropped.
    expect(f.cmds()).toEqual([{ forget: true, say: '本日の予定をお伝えします。', id: '1', lang: 'ja-JP' }, { forget: true }])
  })

  it('muted: nothing heard counts, reading or not', async () => {
    const f = fakeCall('mute', 'on', [{ type: 'spoke', id: '1' }, { type: 'final', text: '明日の会議は何時?', level: -20 }, { type: 'spoke', id: '9' }])
    const got: AssistantListenEvent[] = []
    const stop = startListening('ja', (e) => {
      got.push(e)
      if (e.type === 'ready') {
        voiceCommand({ mute: true })
        voiceCommand({ say: 'はい。', id: '1' })
      }
    }, f.bin, { call: true })
    await vi.waitFor(() => expect(got.some((e) => e.id === '9')).toBe(true), { timeout: 10_000 })
    stop()
    expect(got.some((e) => e.type === 'final')).toBe(false)
  })

  // Review 2026-10-07: muted, levels are skipped — a pause would never end (≤30 s "speaking").
  it('paused, then muted or echo removal gone: it goes on at once instead of staying held', async () => {
    const f = fakeCall('mutehold', 'on', [{ type: 'level', level: -20 }])
    const stop = startListening('ja', (e) => {
      if (e.type === 'ready') voiceCommand({ say: '本日の予定をお伝えします。', id: '1' })
    }, f.bin, { call: true })
    await vi.waitFor(() => expect(f.cmds().some((c) => c.pause)).toBe(true), { timeout: 10_000 })
    expect(voiceCommand({ mute: true })).toBe(true)
    await vi.waitFor(() => expect(f.cmds().slice(-2)).toEqual([{ resume: true }, { mute: true }]), { timeout: 10_000 })
    stop()

    const o = fakeCall('offhold', 'on', [{ type: 'level', level: -20 }, { type: 'ready', echo: 'off' }])
    const stop2 = startListening('ja', (e) => {
      if (e.type === 'ready' && e.echo === 'on') voiceCommand({ say: '本日の予定をお伝えします。', id: '1' })
    }, o.bin, { call: true })
    await vi.waitFor(() => expect(o.cmds().slice(1)).toEqual([{ pause: true, forget: true }, { resume: true }]), { timeout: 10_000 })
    stop2()
  })

  it('og-listen is the call\'s voice (--call) only in a call', async () => {
    const bin = fake('args', `echo "{\\"type\\":\\"ready\\",\\"echo\\":\\"$2\\"}"; exec sleep 5`)
    const ready = (o: { call?: boolean }) =>
      new Promise<string | undefined>((done) => {
        const stop = startListening('ja', (e) => {
          if (e.type !== 'ready') return
          stop()
          done(e.echo)
        }, bin, o)
      })
    expect(await ready({ call: true })).toBe('--call')
    expect(await ready({})).toBe('')
  })

  it('its own voice coming back loud (an interface\'s monitors, no echo removal) does not pause it; a voice above it does', async () => {
    const own = Array.from({ length: 12 }, () => ({ type: 'level', level: -38, play: -24 }))
    const f = fakeCall('loudback', 'apart', [...own, { type: 'level', level: -19, play: -24 }, { type: 'spoke', id: '1' }])
    await talk(f.bin, (g) => g.some((e) => e.type === 'spoke'))
    const cmds = f.cmds()
    expect(cmds.filter((c) => c.pause)).toHaveLength(1)
    expect(cmds.findIndex((c) => c.pause)).toBe(1) // only after the voice above it
  })

  it('a loud moment that never turns into words lets it go on', async () => {
    const f = fakeCall('noise', 'apart', [{ type: 'level', level: -20 }, `sleep ${(BARGE.holdMs + 200) / 1000}`, { type: 'level', level: -60 }, { type: 'spoke', id: '1' }])
    const got = await talk(f.bin, (g) => g.some((e) => e.type === 'spoke'))
    expect(got.map((e) => e.type)).toEqual(['ready', 'speak', 'spoke'])
    expect(f.cmds()).toEqual([{ forget: true, say: '本日の予定をお伝えします。', id: '1', lang: 'ja-JP' }, { pause: true, forget: true }, { resume: true }, { forget: true }])
  })

  it('no call: the voice says so', () => {
    expect(voiceCommand({ stop: true })).toBe(false)
  })
})

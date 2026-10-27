// The floating assistant's ears (FloatingAssistant / useVoice): runs og-listen
// (native/og-listen, built into bin/ by scripts/build-listen.mjs) — macOS's own
// speech recognizer, free and on this Mac — and hands on what it hears. One
// pair of ears at a time: a second listener takes over from the first.
//
// macOS asks the APP (OPEN GROUND.app, the responsible process) for the mic and
// speech-recognition permissions, so both usage strings live in package.json
// build.mac.extendInfo; without the speech one tccd kills the helper (SIGABRT).
import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import type { AssistantListenEvent as ListenEvent } from '@/lib/types'

const moduleDir = (): string => (typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url)))

/** bin/og-listen at the app root, or null where there are no ears (not macOS, not built).
 *  The root sits 2 levels above the bundle (server/dist) and 3 above dev (src/lib/server). */
export const listenBinary = (from = moduleDir()): string | null => {
  if (process.platform !== 'darwin') return null
  let dir = from
  for (let i = 0; i < 4; i++) {
    const p = join(dir, 'bin', 'og-listen')
    if (existsSync(p)) return p
    dir = dirname(dir)
  }
  return null
}

let current: ChildProcess | null = null

// ── Talking over the assistant (owner 2026-10-07, "A") ─────────────────────
// In a call og-listen is also the voice (`--call`): it reads the answer from the
// same audio engine it listens on, with Apple's voice processing on, so the
// echo of its own voice is taken out of what the mic hears (WWDC19 510 /
// WWDC23 10235: only audio played through that engine is the echo reference).
// What is left can still be a scrap of its own voice or a noise, so while it
// reads, words are let through only when all three hold (isBargeIn); then the
// reading stops at once and the words go on as the owner's. The recognizer's
// first word comes ~0.8 s after the voice starts (measured 2026-10-07), too late
// for "quiet within 0.5 s": so a loud moment PAUSES the reading at once (og-listen
// reports the mic every 0.1 s while it reads), and the words then decide — the
// three conditions stop it, nothing within `holdMs` lets it go on from where it
// paused. A barge-in only QUIETS: a stop, never a yes — nothing is approved or run by it.

/** Thresholds (owner left them to us, 2026-10-07). ponytail: fixed values,
 *  measured on one Mac (docs/PHONE_LINK.md "Talking over it"); a setting if
 *  another room needs another level. */
export const BARGE = {
  /** ① Enough words: kana/kanji count 1 each, an English word 3 (「待って」 and "wait" alike). */
  minUnits: 3,
  /** ② Loud enough: the mic's level after echo removal, dBFS, the loudest 0.1 s of the last 0.5 s.
   *  What is left of its own voice reached -45 (MacBook speakers, full volume); a voice at the Mac ≈ -30. */
  minLevelDb: -40,
  /** ③ Not its own words: at most this share of the heard pairs (of kana/kanji, of English words) may be in what it is reading. */
  maxEcho: 0.5,
  /** Pause the reading when 0.1 s of mic is this loud (someone may be talking)… */
  holdDb: -40,
  /** …and this much louder than what of its own voice comes back to the mic (②
   *  too): how loud it is reading now plus how much of that the mic hears — learnt
   *  while it reads (the loudest lately, fading `couplingFade` dB per 0.1 s), from
   *  `couplingStart` (measured: -14 dB through an interface's monitors, -27 dB
   *  typical with echo removal on MacBook speakers). */
  overEchoDb: 8,
  couplingStart: -20,
  couplingFade: 0.3,
  /** …and go on if nothing loud for this long has turned into words that stop it — */
  holdMs: 1500,
  /** — or after this long held at all (a noise that does not stop: music from another app), */
  holdMaxMs: 3000,
  /** not holding again for this long after (the words alone still stop it, ~1 s later). */
  holdOffMs: 5000,
} as const

// The u flag via the constructor: tsconfig's target refuses it in a literal.
const TOKEN = new RegExp('[a-z0-9\']+|[\\p{L}\\p{N}]', 'gu')
/** Kana/kanji one by one, English (and other spaced scripts) word by word, one
 *  way of writing them: width, case, katakana → hiragana. */
const tokens = (s: string): string[] =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .match(TOKEN) ?? []

/** A nod while listening (うん, はい, yeah…) is not a turn to speak. */
const NOD = /^(うん|ん|はい|ええ|ええと|ああ|あー|へー|へえ|ふーん|ほう|おー|そう|そうですね|そうだね|そっか|そうか|そうなんだ|なるほど|たしかに|yeah|yes|yep|ok|okay|right|alright|allright|sure|uhhuh|mhm|mm|isee)+$/

/** An English word (kana/kanji come one by one; a lone letter is not a word). */
const isWord = (t: string) => t.length > 1
const pairs = (t: string[]): string[] => t.slice(1).map((x, i) => `${t[i]} ${x}`)

/** The three conditions for "the owner is talking over the reading". */
export const isBargeIn = (heard: string, levelDb: number | undefined, reading: string, echoDb = -120): boolean => {
  // The latest words only (about a second's worth): the recognizer may have run
  // the echo it heard and the owner's words into one utterance (measured 2026-10-07).
  const t = tokens(heard).slice(-8)
  const units = t.reduce((n, x) => n + (isWord(x) ? 3 : 1), 0)
  if (units < BARGE.minUnits || NOD.test(t.join(''))) return false
  if (levelDb === undefined || !(levelDb >= Math.max(BARGE.minLevelDb, echoDb + BARGE.overEchoDb))) return false
  // Pairs, not single letters: a few English sentences hold most letter pairs (review 2026-10-07).
  const r = tokens(reading)
  const own = new Set(t.length > 1 ? pairs(r) : r)
  const p = t.length > 1 ? pairs(t) : t
  const echo = p.filter((x) => own.has(x)).length / p.length
  return echo <= BARGE.maxEcho
}

/** What a call's voice is told (the window's POST /api/phone-link/assistant/voice). */
export interface VoiceCommand {
  /** Quiet now (before `say`, when both). */
  stop?: boolean
  say?: string
  id?: string
  mute?: boolean
  /** Measuring only (`og-listen --call --feed`, scripts/measure-barge-in.mts); the route never passes it. */
  feed?: boolean
}

let call: ((cmd: VoiceCommand) => boolean) | null = null

/** Drives the voice of the call in progress; false when there is none. */
export const voiceCommand = (cmd: VoiceCommand): boolean => call?.(cmd) ?? false

/** Starts listening; every event goes to onEvent, ending with at most one 'error'.
 *  `call`: also the call's voice (echo removal on, the reading gated by isBargeIn).
 *  `voicevox`: the call's VOICEVOX voices (voicevox.ts) — the folder og-listen loads
 *  them from, and the voice a Japanese line is read with right now (null = the system voice).
 *  Returns stop (idempotent; a stopped listener reports nothing more). */
export const startListening = (
  lang: 'ja' | 'en',
  onEvent: (e: ListenEvent) => void,
  bin = listenBinary(),
  opts: { call?: boolean; voicevox?: { dir: string; line: () => { model: string; style: number } | null } } = {},
): (() => void) => {
  if (!bin) {
    onEvent({ type: 'error', reason: 'unavailable' })
    return () => {}
  }
  current?.kill()
  const vv = opts.call ? opts.voicevox : undefined
  const child = spawn(bin, [lang === 'en' ? 'en-US' : 'ja-JP', ...(opts.call ? ['--call'] : []), ...(vv ? ['--voicevox', vv.dir] : [])], {
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  current = child
  let ended = false
  const end = (reason: string) => {
    if (ended) return
    ended = true
    if (call === drive) call = null
    onEvent({ type: 'error', reason })
  }
  // The call's gate. `reading` = what it has said since it last fell quiet.
  const g = {
    speaking: new Set<string>(),
    reading: '',
    barged: false,
    muted: false,
    echoOff: false,
    heardOf: 0,
    held: false,
    heldAt: 0,
    loudAt: 0,
    holdOffUntil: 0,
    /** mic − speaker, dB: how much of its own voice the mic hears back. */
    coupling: BARGE.couplingStart as number,
    /** Its own voice as the mic would hear it, the last five 0.1 s (dBFS). */
    echoes: [] as number[],
  }
  // og-listen gone mid-write: its 'close' reports why, the pipe error is not news.
  child.stdin?.on('error', () => {})
  const tell = (o: object) => {
    if (!child.stdin?.writable) return false
    child.stdin.write(`${JSON.stringify(o)}\n`)
    return true
  }
  const unhold = () => {
    g.held = false
    g.holdOffUntil = Date.now() + BARGE.holdOffMs
    tell({ resume: true })
  }
  // The VOICEVOX voice is loaded ahead (as the call starts, and whenever it changes — picked
  // mid-call, or its files just arrived), and a line goes to it only once og-listen says it is
  // loaded ('warmed'): until then the system voice reads, so no line waits seconds for a load.
  let loaded: string | undefined
  let asked: string | undefined
  const line = () => {
    const l = vv?.line() ?? undefined
    if (!l) return undefined
    if (l.model === loaded) return l
    if (l.model !== asked && tell({ warm: l.model })) {
      asked = l.model
      loaded = undefined // og-listen keeps one voice: the loaded one goes when this one comes
    }
    return undefined
  }
  const drive = (cmd: VoiceCommand): boolean => {
    if (ended) return false
    line()
    if (cmd.mute !== undefined) g.muted = cmd.mute
    // Muted, nothing heard can stop it nor end a pause (levels are skipped): go on now.
    if (g.muted && g.held && !cmd.stop) unhold()
    // A line the window sent before it heard of a barge-in comes in after it:
    // not read. The window opens every new reading with a stop (useCallVoice).
    const say = typeof cmd.say === 'string' && cmd.say.trim() && cmd.id && (cmd.stop || !g.barged) ? cmd.say : undefined
    // What the recognizer has open is dropped when the window stops the reading
    // (the stop key: its own voice may sit in it) and when a reading starts from
    // quiet (words said while it thought were not taken) — never on a barge-in's
    // own stop, those words are the owner's.
    const forget = cmd.stop === true || (say !== undefined && !g.speaking.size)
    if (cmd.stop) {
      g.speaking.clear()
      g.held = false
      g.barged = false
      g.holdOffUntil = 0
    }
    if (say !== undefined && cmd.id) {
      if (!g.speaking.size) g.reading = ''
      g.heardOf = Date.now()
      g.speaking.add(cmd.id)
      g.reading += say
    }
    const lang = say && /[぀-ヿ㐀-鿿]/.test(say) ? 'ja-JP' : 'en-US'
    return tell({
      ...(cmd.stop ? { stop: true } : {}),
      ...(forget ? { forget: true } : {}),
      ...(say !== undefined ? { say, id: cmd.id, lang, ...(vv && lang === 'ja-JP' ? { vv: line() } : {}) } : {}),
      ...(cmd.mute !== undefined ? { mute: cmd.mute } : {}),
      ...(cmd.feed ? { feed: true } : {}),
    })
  }
  if (opts.call) call = drive
  line()
  /** Heard words while it reads: dropped unless the owner is talking over it. */
  const pass = (e: ListenEvent): boolean => {
    if (g.muted) return false
    // A voice that went silent without a word (no 'spoke'): not reading any more.
    // ponytail: a line read aloud is ≤ 160 characters, well under 30 s.
    if (Date.now() - g.heardOf > 30_000) g.speaking.clear()
    if (!g.speaking.size || g.barged) return true
    if (g.echoOff || !isBargeIn(e.text ?? '', e.level, g.reading, Math.max(-120, ...g.echoes))) return false
    g.barged = true
    g.held = false
    g.speaking.clear()
    tell({ stop: true }) // no forget: the open words are the owner's
    onEvent({ type: 'barge' })
    return true
  }
  let buf = ''
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    buf += chunk
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      let e: ListenEvent
      try {
        e = JSON.parse(line) as ListenEvent
      } catch {
        continue
      }
      if (e.type === 'error') end(e.reason ?? 'failed')
      else if (ended) continue
      else if (e.type === 'warmed') {
        // Only the voice asked for: a late 'warmed' of an older ask (A→B→A) is not the one coming.
        if (e.model === asked) loaded = e.model
        onEvent(e) // for a test or a measurement; the route does not pass it on
      } else if (e.type === 'ready') {
        // No echo removal (the device would not take it): nothing heard while it reads counts.
        g.echoOff = opts.call === true && e.echo === 'off'
        // Same for a pause when echo removal went away (a restart on another device).
        if (g.echoOff && g.held) unhold()
        onEvent(e)
      } else if (e.type === 'level') {
        onEvent(e) // for a measurement; the route does not pass it on (ten a second)
        // Holds only where heard words could count.
        if (!g.speaking.size || g.barged || g.muted || g.echoOff) continue
        const now = Date.now()
        const level = e.level ?? -120
        const play = e.play ?? -120
        const echo = play > -60 ? play + g.coupling : -120
        g.echoes = [...g.echoes.slice(-4), echo]
        const loud = level >= Math.max(BARGE.holdDb, echo + BARGE.overEchoDb)
        // Learnt only from what is not a voice over it.
        if (!loud && !g.held && play > -60) g.coupling = Math.max(level - play, g.coupling - BARGE.couplingFade)
        if (loud) g.loudAt = now
        if (g.held && (now - g.loudAt >= BARGE.holdMs || now - g.heldAt >= BARGE.holdMaxMs)) unhold()
        else if (loud && !g.held && now >= g.holdOffUntil) {
          g.held = true
          g.heldAt = now
          // Quiet now, and what the recognizer has open (its own voice, heard
          // until now) dropped: the words that follow are heard on their own.
          tell({ pause: true, forget: true })
        }
      } else if (e.type === 'speak') {
        g.heardOf = Date.now()
        onEvent(e)
      } else if (e.type === 'spoke') {
        g.heardOf = Date.now()
        // Read to the end: what the recognizer has open is scraps of its own voice —
        // dropped, unless someone was loud just now (the owner starting to answer).
        if (g.speaking.delete(e.id ?? '') && !g.speaking.size) {
          if (!g.held) tell({ forget: true })
          g.held = false
        }
        onEvent(e)
      } else if (e.type === 'partial' || e.type === 'final') {
        if (pass(e)) onEvent(e)
      } else onEvent(e)
    }
  })
  child.on('error', () => end('failed'))
  // tccd kills a helper whose app may not ask (SIGABRT): that is a permission problem.
  child.on('close', (_code, signal) => {
    if (current === child) current = null
    if (call === drive) call = null
    end(signal === 'SIGABRT' ? 'denied' : 'failed')
  })
  return () => {
    ended = true
    if (call === drive) call = null
    child.kill()
  }
}

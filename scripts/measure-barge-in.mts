// Talking over the call's voice (og-listen --call + assistantListen's gate),
// measured on this Mac without anyone speaking:
//
//   npx tsx scripts/measure-barge-in.mts <og-listen binary> echo [runs=10]
//     reads long answers aloud through whatever the Mac's output is and counts
//     how often the gate thinks the owner talked over it (want 0); prints what
//     the mic heard meanwhile and how loud.
//   npx tsx scripts/measure-barge-in.mts <og-listen binary> barge [runs=5]
//     reads an answer and, 2 s in, mixes a recorded voice (`say -v Eddy`,
//     leading silence cut) into what the mic hears (`--call --feed`): seconds
//     from the first voiced sample to the reading stopped (want ≤ 0.5).
//
// The voice is mixed in after echo removal, not played in the room: another
// app's sound coming out of the same Mac is not a person (voice processing
// treats it differently), and this Mac's speakers go to an interface its mic
// cannot hear. What the room adds — the speaker's echo while it reads — is
// what `echo` measures. Switch the Mac's output/input before running.
import { execFileSync } from 'child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AssistantListenEvent } from '../src/lib/types'
import { startListening, voiceCommand, type VoiceCommand } from '../src/lib/server/assistantListen'

const [bin, mode = 'echo', n] = process.argv.slice(2)
if (!bin) throw new Error('usage: measure-barge-in.mts <og-listen> echo|barge [runs]')
const runs = Number(n ?? (mode === 'echo' ? 10 : 5))
const dir = mkdtempSync(join(tmpdir(), 'og-barge-'))

const READ = [
  '本日の予定をお伝えします。午前十時から企画会議があり、その後に昼食をはさんで、午後二時からデザインの確認があります。',
  '夕方には新しいカードの進み具合をまとめて、明日の準備をしておきましょう。気になる点があれば教えてください。',
  '昨日の作業では三枚のカードが完了しました。残りの二枚は確認待ちで、どちらも今日中に終わる見込みです。',
  'アシスタントの記録は、設定の画面からいつでも見られます。古い記録は三十日たつと自動で消えます。',
  'リリースの準備は整っています。iPhone の側と揃えて出す予定なので、もう少しだけ待ってくださいね。',
]

/** The voice, at the mic's rate, its leading silence cut (so "fed" = the first voiced sample). */
const voiceFile = (rate: number) => {
  const aiff = join(dir, 'v.aiff')
  const wav = join(dir, `v${rate}.wav`)
  execFileSync('say', ['-v', 'Eddy', '-o', aiff, 'ちょっと待って、明日の会議は何時からだっけ'])
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', aiff, '-af', 'silenceremove=start_periods=1:start_threshold=-40dB', '-ac', '1', '-ar', String(rate), '-c:a', 'pcm_f32le', wav])
  return wav
}

const once = (ears: string, feed: boolean, text: string) =>
  new Promise<{ barged: boolean; delay?: number; quiet?: number; heard: string[]; echo?: string; paused: number; loudest: number }>((done) => {
    const heard: string[] = []
    let fedAt = 0
    let echo: string | undefined
    let barged = false
    let delay: number | undefined
    let quiet: number | undefined
    let paused = 0
    let fedT = 0
    let pausedT = 0
    let loudest = -120
    const finish = () => {
      stop()
      done({ barged, delay, quiet, heard, echo, paused, loudest })
    }
    const stop = startListening(
      'ja',
      (e: AssistantListenEvent) => {
        if (process.env.DEBUG) console.log(performance.now().toFixed(0), JSON.stringify(e))
        if (e.type === 'ready' && echo === undefined) {
          echo = e.echo
          voiceCommand({ say: text, id: '1' })
        } else if (e.type === 'speak' && feed) setTimeout(() => voiceCommand({ feed: true } as VoiceCommand), 2000)
        else if (e.type === 'fed') {
          fedAt = performance.now()
          fedT = e.t ?? 0
          if (pausedT) quiet = pausedT - fedT
        }
        else if (e.type === 'level') loudest = Math.max(loudest, e.level ?? -120)
        else if (e.type === 'paused') {
          paused++
          // og-listen's own clock: the pause may be told before the "fed" line arrives.
          if (!pausedT) pausedT = e.t ?? 0
          if (fedT && quiet === undefined) quiet = pausedT - fedT
        }
        else if (e.type === 'barge') {
          barged = true
          if (fedAt) delay = (performance.now() - fedAt) / 1000
          setTimeout(finish, 300)
        } else if (e.type === 'partial' || e.type === 'final') heard.push(`${e.type} ${e.level ?? ''}dB ${e.text}`)
        else if (e.type === 'spoke') setTimeout(finish, 1500)
        else if (e.type === 'error') done({ barged, heard: [...heard, `error ${e.reason}`], echo, paused, loudest })
      },
      ears,
      { call: true },
    )
    setTimeout(finish, 40_000)
  })

let ears = bin
if (mode === 'barge') {
  // The mic's rate: the binary reports it on stderr; 48 kHz for a MacBook's mic (with or without echo removal).
  const wav = voiceFile(Number(process.env.RATE ?? 48000))
  ears = join(dir, 'ears')
  writeFileSync(ears, `#!/bin/sh\nexec '${bin}' "$@" --feed '${wav}'\n`)
  chmodSync(ears, 0o755)
}
const results = []
for (let i = 0; i < runs; i++) {
  const r = await once(ears, mode === 'barge', READ[i % READ.length])
  results.push(r)
  console.log(JSON.stringify({ run: i + 1, echo: r.echo, barged: r.barged, quiet: r.quiet?.toFixed(3), stop: r.delay?.toFixed(2), paused: r.paused, loudest: r.loudest, heard: r.heard }))
}
if (mode === 'echo')
  console.log(`stopped by its own voice: ${results.filter((r) => r.barged).length}/${runs}, paused by it: ${results.reduce((n, r) => n + r.paused, 0)} times, loudest 0.1 s while reading: ${Math.max(...results.map((r) => r.loudest))} dBFS`)
else
  console.log(`quiet (paused) after: ${results.map((r) => r.quiet?.toFixed(3) ?? '-').join(' ')} s; stopped after: ${results.map((r) => r.delay?.toFixed(2) ?? '-').join(' ')} s (${results.filter((r) => r.delay !== undefined).length}/${runs})`)
rmSync(dir, { recursive: true, force: true })
process.exit(0)

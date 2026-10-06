// How long the Mac's ears take from the END of the owner's speech to handing the
// line on ("final") — the first part of 話し終えてから最初の声まで. No mic and
// no speaker: og-listen's --feed plays a recording into the recognizer at real
// time, then silence (native/og-listen/main.swift).
//
//   node scripts/measure-voice-latency.mjs <og-listen binary> [runs=3] "line" ["line" ...]
//
// Each line is spoken into a file by `say -v Kyoko`, its trailing silence cut
// with ffmpeg (so "fed" = the last voiced sample), then fed `runs` times.
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [bin, ...rest] = process.argv.slice(2)
const runs = /^\d+$/.test(rest[0] ?? '') ? Number(rest.shift()) : 3
const lines = rest.length ? rest : ['やあ、元気?', '今日の予定を教えてください', '明日の会議の資料ってどこにある?']
const dir = mkdtempSync(join(tmpdir(), 'og-voice-latency-'))

const once = (file) =>
  new Promise((resolve) => {
    const child = spawn(bin, ['ja-JP', '--feed', file], { stdio: ['pipe', 'pipe', 'ignore'] })
    let fed = 0
    let buf = ''
    const done = (r) => {
      child.kill()
      resolve(r)
    }
    child.stdout.setEncoding('utf8').on('data', (c) => {
      buf += c
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const e = JSON.parse(buf.slice(0, i))
        buf = buf.slice(i + 1)
        if (e.type === 'fed') fed = performance.now()
        if (e.type === 'final') done({ s: (performance.now() - fed) / 1000, text: e.text })
        if (e.type === 'error') done({ error: e.reason })
      }
    })
    setTimeout(() => done({ error: 'timeout' }), 20_000)
  })

try {
  for (const [n, line] of lines.entries()) {
    const raw = join(dir, `${n}.aiff`)
    const cut = join(dir, `${n}.wav`)
    execFileSync('say', ['-v', 'Kyoko', '-o', raw, line])
    execFileSync('ffmpeg', ['-loglevel', 'error', '-i', raw, '-af', 'areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse', '-y', cut])
    const got = []
    for (let i = 0; i < runs; i++) got.push(await once(cut))
    const ok = got.filter((g) => g.s !== undefined).map((g) => g.s)
    const avg = ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : NaN
    console.log(`> ${line}\n  end of speech → final: ${ok.map((s) => s.toFixed(2)).join(' / ')} s (avg ${avg.toFixed(2)})  heard: ${got.find((g) => g.text)?.text ?? got[0]?.error}`)
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

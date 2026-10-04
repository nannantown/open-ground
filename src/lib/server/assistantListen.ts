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

/** Starts listening; every event goes to onEvent, ending with at most one 'error'.
 *  Returns stop (idempotent; a stopped listener reports nothing more). */
export const startListening = (lang: 'ja' | 'en', onEvent: (e: ListenEvent) => void, bin = listenBinary()): (() => void) => {
  if (!bin) {
    onEvent({ type: 'error', reason: 'unavailable' })
    return () => {}
  }
  current?.kill()
  const child = spawn(bin, [lang === 'en' ? 'en-US' : 'ja-JP'], { stdio: ['pipe', 'pipe', 'ignore'] })
  current = child
  let ended = false
  const end = (reason: string) => {
    if (ended) return
    ended = true
    onEvent({ type: 'error', reason })
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
      else if (!ended) onEvent(e)
    }
  })
  child.on('error', () => end('failed'))
  // tccd kills a helper whose app may not ask (SIGABRT): that is a permission problem.
  child.on('close', (_code, signal) => {
    if (current === child) current = null
    end(signal === 'SIGABRT' ? 'denied' : 'failed')
  })
  return () => {
    ended = true
    child.kill()
  }
}

// The assistant's ears hand on what og-listen hears, and end with exactly one
// plain reason — a helper killed by macOS for a missing permission (SIGABRT)
// reads as 'denied', so the screen can say "allow it in System Settings".
import { describe, it, expect, afterAll, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AssistantListenEvent } from '@/lib/types'
import { listenBinary, startListening } from './assistantListen'

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

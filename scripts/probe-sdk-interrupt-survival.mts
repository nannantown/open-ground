// Does `interrupt()` END the SDK session, or only the current turn?
//
//   npx tsx scripts/probe-sdk-interrupt-survival.mts
//
// WHY THIS PROBE EXISTS. sdkSession's `interruptSdkSession` promises a graceful
// stop, and the button's tooltip tells the owner "the session stays open" — but
// the pump's own comment asserted the opposite as measured fact ("interrupt()
// makes the iterator THROW"), and a test pinned that death as golden. One of the
// two had to be a lie, and a lie shown to the owner is the worse kind. The
// stage-0 spike could not settle it: it recorded only "exception: yes".
//
// WHY IT NEEDS NO `claude`, NO AUTH AND NO QUOTA. The question is about the SDK
// CLIENT — "does the async iterator end when I call interrupt()?" — so the CLI
// on the other end only has to speak the stream-json protocol, which a 60-line
// stand-in does. That also buys the one thing a real claude cannot give: control
// over whether the CLI process stays alive, which turns out to be the whole
// answer. (An isolated HOME cannot authenticate a real claude anyway —
// migration plan appendix B-6 — so a "realer" probe would fail for the wrong
// reason or spend the owner's own quota.)
//
// MEASURED 2026-08-01, both cases:
//   A. CLI stays alive → interrupt aborts the turn, delivers its
//      `aborted_streaming` result, and the ITERATOR KEEPS GOING. A turn pushed
//      afterwards runs to completion. The graceful stop is real.
//   B. CLI exits after the aborted result → the iterator throws
//      `Claude Code returned an error result: [ede_diagnostic] …`. THAT is where
//      the spike's exception came from: the SDK ends its iterator when the CHILD
//      DIES, and relabels the exit error with the last error result's text, so a
//      dying CLI's exception reads as though the abort threw it.
//
// The spike passed a STRING prompt; the SDK sets `isSingleUserTurn` from
// `typeof prompt === 'string'` and closes the CLI's stdin on the first result,
// so its CLI was always going to die. We ship an AsyncIterable prompt that PARKS
// between turns (sdkSession's makeInputIterable) — a different arrangement, and
// the reason the spike's reading did not transfer. Measure the arrangement you
// actually ship.

import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { query } from '@anthropic-ai/claude-agent-sdk'

// A stand-in for `claude`: speaks stream-json, runs a long turn, and on an
// `interrupt` control request aborts it and emits the aborted turn's result
// exactly as the CLI does (subtype `error_during_execution`, `is_error`,
// `terminal_reason: 'aborted_streaming'`, plus the `errors` array the SDK reads
// for non-'success' subtypes — omitting it makes the SDK throw for an unrelated
// reason and fakes case B).
const FAKE_CLI = (dieAfterAbort: boolean) => `
import readline from 'readline'
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
let timer = null, aborted = false
const startTurn = () => {
  aborted = false
  let i = 0
  const tick = () => {
    if (aborted) return
    if (i >= 100) {
      send({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', result: 'done', session_id: 'fake' })
      timer = null
      return
    }
    send({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'working ' + i }] }, parent_tool_use_id: null, session_id: 'fake' })
    i++
    timer = setTimeout(tick, 50)
  }
  tick()
}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  let m
  try { m = JSON.parse(line) } catch { return }
  if (m.type === 'control_request') {
    if (m.request?.subtype === 'interrupt') {
      aborted = true
      if (timer) clearTimeout(timer)
      timer = null
      send({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', result: '[ede_diagnostic] aborted by user', errors: ['[ede_diagnostic] aborted by user'], session_id: 'fake' })
      ${dieAfterAbort ? "setTimeout(() => process.exit(1), 50)" : ""}
    }
    send({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } })
    return
  }
  if (m.type === 'user') startTurn()
}).on('close', () => process.exit(0))
setInterval(() => {}, 1 << 30)
`

const run = async (label: string, dieAfterAbort: boolean) => {
  const dir = mkdtempSync(join(tmpdir(), 'og-sdk-interrupt-'))
  const bin = join(dir, 'fake-claude.mjs')
  writeFileSync(bin, FAKE_CLI(dieAfterAbort))

  let wake: ((t: string | null) => void) | null = null
  const queue: (string | null)[] = ['first turn']
  // The SHIPPED shape: an AsyncIterable that parks between turns, never a string.
  const prompt = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        let text: string | null
        if (queue.length) text = queue.shift()!
        else text = await new Promise<string | null>((r) => (wake = r))
        if (text === null) return
        yield { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null, session_id: '' } as never
      }
    },
  }
  const push = (t: string | null) => {
    if (wake) {
      const w = wake
      wake = null
      w(t)
    } else queue.push(t)
  }

  const h = query({ prompt, options: { pathToClaudeCodeExecutable: bin, cwd: dir } })

  let threw: string | null = null
  let afterInterrupt = 0
  let interrupted = false
  const done = (async () => {
    try {
      for await (const _m of h) {
        void _m
        if (interrupted) afterInterrupt++
      }
    } catch (err) {
      threw = String((err as Error)?.message ?? err).slice(0, 120)
    }
  })()

  await new Promise((r) => setTimeout(r, 800))
  interrupted = true
  await h.interrupt().catch(() => {})
  await new Promise((r) => setTimeout(r, 500))
  push('a SECOND turn, pushed after the interrupt')
  await new Promise((r) => setTimeout(r, 2500))

  console.log(`\n── ${label} ──`)
  console.log(`  iterator threw          : ${threw ?? 'NO'}`)
  console.log(`  messages after interrupt: ${afterInterrupt}`)
  console.log(
    `  verdict                 : ${threw ? 'session ENDED' : 'session SURVIVED — the graceful stop is real'}`,
  )

  push(null)
  await Promise.race([done, new Promise((r) => setTimeout(r, 1000))])
  rmSync(dir, { recursive: true, force: true })
}

await run('A. CLI stays alive (the arrangement OPEN GROUND ships)', false)
await run('B. CLI exits right after the aborted result (the spike\'s arrangement)', true)
process.exit(0)

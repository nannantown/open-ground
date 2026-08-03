// AN SDK WORKER'S PROSE QUESTION MUST REACH THE OWNER — the gap that kept the
// cloud-centric decision's third re-evaluation condition open (0802 memo: only
// heartbeat `blocked` worked; detectFreeTextQuestion needs the claude TUI's
// idle footer, which an SDK worker's output cannot contain, so classifyOutput
// answered 'normal' forever and a worker sitting on a question was eventually
// nudged/reclaimed as an ordinary stall).
//
// FIXTURE DISCIPLINE (VERIFICATION.md §3): every input below is composed with
// the PRODUCTION writers — sdkRecentOutputHead for the status line and
// renderSdkTail for the tail — never hand-typed strings imitating them. A shape
// those two cannot emit is a shape this suite is not allowed to assert about.
//
// Proven RED against the pre-fix source (2026-08-03):
//   • classifyOutput without the kind dispatch → the classifier test fails
//   • detectSdkFreeTextQuestion accepting a 'working' head → the idle-gate
//     test fails
//   • marker-line exclusion dropped → the tool-tail test fails

import { describe, it, expect } from 'vitest'
import {
  detectSdkFreeTextQuestion,
  detectWorkerFreeTextQuestion,
  detectFreeTextQuestion,
} from './swarmQuestions'
import { classifyOutput } from './swarmOrchestrator'
import { renderSdkTail, sdkRecentOutputHead } from './workerRuntime'
import type { SdkEvent } from './sdkEvents'

/** recentOutput's exact production composition: head line above rendered tail. */
const sdkOut = (status: string, events: SdkEvent[]): string => {
  const tail = renderSdkTail(events)
  const head = sdkRecentOutputHead(status)
  return tail ? `${head}\n${tail}` : head
}

const text = (t: string): SdkEvent => ({ kind: 'text', text: t })
const tool = (name: string): SdkEvent => ({ kind: 'tool_use', name, detail: '' })

describe('detectSdkFreeTextQuestion — the idle gate is the pool status, not pixels', () => {
  it("detects a question when the session is 'waiting' and the last words end in ?", () => {
    const out = sdkOut('waiting', [
      tool('Read'),
      text('A/B どちらの命名にしますか?'),
    ])
    expect(detectSdkFreeTextQuestion(out)).toEqual({
      question: 'A/B どちらの命名にしますか?',
    })
  })

  it('a full-width ？ counts — the workers ask in Japanese', () => {
    const out = sdkOut('waiting', [text('この列は削除してよいですか？')])
    expect(detectSdkFreeTextQuestion(out)?.question).toBe('この列は削除してよいですか？')
  })

  it('reassembles a multi-line utterance into one question', () => {
    const out = sdkOut('waiting', [
      text('2案あります。\nA: 既存の列を広げる\nB: 新しい列を足す\nどちらにしますか?'),
    ])
    expect(detectSdkFreeTextQuestion(out)?.question).toBe(
      '2案あります。 A: 既存の列を広げる B: 新しい列を足す どちらにしますか?',
    )
  })

  it("'working' is mid-turn — never a question, whatever the text says", () => {
    // The turn has not ended; answering now would interleave with generation.
    const out = sdkOut('working', [text('どちらにしますか?')])
    expect(detectSdkFreeTextQuestion(out)).toBeNull()
  })

  it("'quota-parked' belongs to the rate-limit arm, not this one", () => {
    const out = sdkOut('quota-parked', [text('どうしますか?')])
    expect(detectSdkFreeTextQuestion(out)).toBeNull()
  })

  it('a tail ending in a TOOL line is work, not a question', () => {
    // The '?' lives in an earlier utterance; the worker moved on to a tool call.
    const out = sdkOut('waiting', [text('これでよいですか?'), tool('Edit')])
    expect(detectSdkFreeTextQuestion(out)).toBeNull()
  })

  it("a MARKER line that itself ends in '?' is still not the worker asking", () => {
    // The first version of this suite only used markers WITHOUT a trailing '?',
    // so deleting the marker exclusion left all 15 tests green (measured
    // 2026-08-03) — the ?-test alone carried them. These are the shapes the
    // exclusion actually exists for: renderer marker lines whose CONTENT ends
    // in a question mark. Both are production-producible: a tool_result head is
    // arbitrary tool output, a tool_use detail is an arbitrary argument.
    const toolErr: SdkEvent = { kind: 'tool_result', ok: false, head: 'command not found. Did you mean git?' }
    expect(detectSdkFreeTextQuestion(sdkOut('waiting', [toolErr]))).toBeNull()
    const toolArg: SdkEvent = { kind: 'tool_use', name: 'Bash', detail: 'ls /tmp/what?' }
    expect(detectSdkFreeTextQuestion(sdkOut('waiting', [toolArg]))).toBeNull()
  })

  it('a tail ending in prose WITHOUT ?/？ is a report, not a question', () => {
    const out = sdkOut('waiting', [text('完了しました。コミット済みです。')])
    expect(detectSdkFreeTextQuestion(out)).toBeNull()
  })

  it('a head with no tail detects nothing', () => {
    expect(detectSdkFreeTextQuestion(sdkOut('waiting', []))).toBeNull()
  })

  it('null in, null out', () => {
    expect(detectSdkFreeTextQuestion(null)).toBeNull()
  })

  it('the head must be the EXACT production head — a drifted copy detects nothing', () => {
    // sdkRecentOutputHead is imported by both the writer (workerRuntime) and the
    // detector; this pins that the detector really keys on it.
    expect(detectSdkFreeTextQuestion('[SDK session waiting]\nどうしますか?')).toBeNull()
    expect(detectSdkFreeTextQuestion(sdkRecentOutputHead('waiting') + '\nどうしますか?')).toEqual({
      question: 'どうしますか?',
    })
  })
})

describe('detectWorkerFreeTextQuestion — one seam, two runtimes', () => {
  const SDK_QUESTION = sdkOut('waiting', [text('どちらにしますか?')])

  it('dispatches sdk output to the sdk detector', () => {
    expect(detectWorkerFreeTextQuestion('sdk', SDK_QUESTION)?.question).toBe('どちらにしますか?')
  })

  it('the same sdk output through the PTY detector finds NOTHING — the exact pre-fix blindness', () => {
    // No idle footer, no input box: the PTY detector cannot see this. This test
    // documents WHY the seam exists; if it ever starts passing the PTY way, the
    // TUI regexes have started matching non-TUI text and that is its own bug.
    expect(detectFreeTextQuestion(SDK_QUESTION)).toBeNull()
    expect(detectWorkerFreeTextQuestion('pty', SDK_QUESTION)).toBeNull()
  })
})

describe("classifyOutput — the 'question' arm is runtime-aware", () => {
  const SDK_QUESTION = sdkOut('waiting', [text('列名は A と B のどちらにしますか?')])

  it("classifies an sdk worker's ended-turn question as 'question'", () => {
    expect(classifyOutput(SDK_QUESTION, 'sdk')).toBe('question')
  })

  it("the kind default ('pty') keeps the old meaning — same text reads 'normal'", () => {
    expect(classifyOutput(SDK_QUESTION)).toBe('normal')
  })

  it("an sdk worker mid-turn stays 'normal' even with a trailing ?", () => {
    expect(classifyOutput(sdkOut('working', [text('いいですか?')]), 'sdk')).toBe('normal')
  })
})

import { describe, it, expect, beforeEach } from 'vitest'
import {
  spawnSdkSession,
  getSdkSession,
  pushSdkInput,
  interruptSdkSession,
  terminateSdkSession,
  attachSdkListener,
  isSdkSessionAlive,
  listSdkSessions,
  removeSdkSession,
  __resetSdkSessionsForTests,
  __setQuotaPrefixesForTests,
  type SdkQueryFn,
  type SdkStreamFrame,
} from './sdkSession'

// NOTHING here spawns a real `claude`. queryFn is injected with a hand-rolled
// async generator, which is the only way these paths can be exercised at all:
// an isolated HOME cannot authenticate (measured — migration plan appendix B-6),
// so a "real" run would either touch the owner's live session state or fail for
// an unrelated reason. Live behaviour is pinned by scripts/probe-sdk-*.mts.

const PREFIXES = ["You've hit your", "You've reached your"]

/** A fake `query()` that echoes a scripted reply per received turn. */
const scriptedQuery =
  (replies: unknown[][], opts: { hangAfter?: number } = {}): SdkQueryFn =>
  ({ prompt }) => {
    let interrupted = false
    const iterable = {
      async *[Symbol.asyncIterator]() {
        let turn = 0
        for await (const _msg of prompt) {
          void _msg
          const script = replies[Math.min(turn, replies.length - 1)] ?? []
          for (const m of script) {
            if (interrupted) throw new Error('Claude Code returned an error result: [ede_diagnostic]')
            yield m
          }
          turn++
          if (opts.hangAfter !== undefined && turn >= opts.hangAfter) {
            // Simulate a turn that never ends until interrupted.
            await new Promise((r) => setTimeout(r, 50))
          }
        }
      },
      interrupt: async () => {
        interrupted = true
      },
    }
    return iterable
  }

const settle = () => new Promise((r) => setTimeout(r, 10))

const assistantText = (text: string) => ({
  type: 'assistant',
  message: { content: [{ type: 'text', text }] },
})
const resultOk = () => ({ type: 'result', subtype: 'success', terminal_reason: 'completed' })

beforeEach(() => {
  __resetSdkSessionsForTests()
  __setQuotaPrefixesForTests(PREFIXES)
})

describe('spawnSdkSession — lifecycle', () => {
  it('runs the initial prompt and lands on waiting after the turn ends', async () => {
    const info = spawnSdkSession({
      cwd: '/tmp/w',
      options: {},
      initialPrompt: 'go',
      queryFn: scriptedQuery([[assistantText('done'), resultOk()]]),
    })
    expect(info.status).toBe('starting')
    await settle()
    const now = getSdkSession(info.id)!
    expect(now.status).toBe('waiting')
    expect(now.seq).toBeGreaterThan(0)
  })

  it('records a spawn failure as failed rather than throwing at the caller', () => {
    const info = spawnSdkSession({
      cwd: '/tmp/w',
      options: {},
      queryFn: () => {
        throw new Error('binary missing')
      },
    })
    expect(info.status).toBe('failed')
    expect(info.exitReason).toContain('binary missing')
    expect(isSdkSessionAlive(info.id)).toBe(false)
  })

  it('reaches exited when the stream ends on its own', async () => {
    const info = spawnSdkSession({
      cwd: '/tmp/w',
      options: {},
      initialPrompt: 'go',
      queryFn: ({ prompt }) => ({
        async *[Symbol.asyncIterator]() {
          for await (const _m of prompt) {
            void _m
            yield resultOk()
            return // stream closes
          }
        },
      }),
    })
    await settle()
    expect(getSdkSession(info.id)!.status).toBe('exited')
    expect(isSdkSessionAlive(info.id)).toBe(false)
  })
})

describe('pushSdkInput', () => {
  it('drives a second turn and flips waiting → working', async () => {
    const info = spawnSdkSession({
      cwd: '/tmp/w',
      options: {},
      initialPrompt: 'one',
      queryFn: scriptedQuery([
        [assistantText('first'), resultOk()],
        [assistantText('second'), resultOk()],
      ]),
    })
    await settle()
    expect(getSdkSession(info.id)!.status).toBe('waiting')

    expect(pushSdkInput(info.id, 'two')).toBe(true)
    await settle()

    const frames: SdkStreamFrame[] = []
    attachSdkListener(info.id, 0, (f) => frames.push(f))!.replay.forEach((f) => frames.push(f))
    const texts = frames.filter((f) => f.ev.kind === 'text').map((f) => (f.ev as { text: string }).text)
    expect(texts).toContain('second')
  })

  it('refuses input to a finished session instead of silently dropping it', async () => {
    const info = spawnSdkSession({
      cwd: '/tmp/w',
      options: {},
      initialPrompt: 'go',
      queryFn: ({ prompt }) => ({
        async *[Symbol.asyncIterator]() {
          for await (const _m of prompt) {
            void _m
            yield resultOk()
            return
          }
        },
      }),
    })
    await settle()
    expect(pushSdkInput(info.id, 'more')).toBe(false)
  })

  it('is false for an unknown id', () => {
    expect(pushSdkInput('nope', 'x')).toBe(false)
  })
})

describe('interrupt / terminate', () => {
  it('treats the post-interrupt throw as a NORMAL stop when a turn_end aborted', async () => {
    // The SDK's iterator throws `[ede_diagnostic]` after an interrupt, AFTER the
    // aborted turn's result has been delivered. The evidence that this was a
    // deliberate stop is that turn_end — never the exception text.
    const info = spawnSdkSession({
      cwd: '/tmp/w',
      options: {},
      initialPrompt: 'long',
      queryFn: ({ prompt }) => {
        let stop = false
        return {
          async *[Symbol.asyncIterator]() {
            for await (const _m of prompt) {
              void _m
              // A LONG turn: keep emitting until interrupted, the way a real
              // generating turn behaves. (The earlier version of this fake fell
              // straight back to awaiting the next input, so interrupt() landed
              // on a session that was already idle and nothing ever aborted.)
              for (let i = 0; i < 200; i++) {
                if (stop) {
                  yield {
                    type: 'result',
                    subtype: 'error_during_execution',
                    is_error: true,
                    terminal_reason: 'aborted_streaming',
                  }
                  throw new Error('Claude Code returned an error result: [ede_diagnostic] …')
                }
                yield assistantText(`working ${i}`)
                await new Promise((r) => setTimeout(r, 2))
              }
            }
          },
          interrupt: async () => {
            stop = true
          },
        }
      },
    })
    await settle()
    await interruptSdkSession(info.id)
    await new Promise((r) => setTimeout(r, 40))
    const s = getSdkSession(info.id)!
    expect(s.exitReason).toBe('interrupted')
    expect(s.status).toBe('exited') // not 'failed'
  })

  it('records a genuine stream error as failed', async () => {
    const info = spawnSdkSession({
      cwd: '/tmp/w',
      options: {},
      initialPrompt: 'go',
      queryFn: ({ prompt }) => ({
        async *[Symbol.asyncIterator]() {
          for await (const _m of prompt) {
            void _m
            yield assistantText('about to die')
            throw new Error('transport exploded')
          }
        },
      }),
    })
    await settle()
    const s = getSdkSession(info.id)!
    expect(s.status).toBe('failed')
    expect(s.exitReason).toContain('transport exploded')
  })

  it('terminate is idempotent and unblocks a parked input generator', async () => {
    const info = spawnSdkSession({
      cwd: '/tmp/w',
      options: {},
      initialPrompt: 'go',
      queryFn: scriptedQuery([[resultOk()]]),
    })
    await settle()
    expect(terminateSdkSession(info.id)).toBe(true)
    expect(terminateSdkSession(info.id)).toBe(true) // no throw, still true
    expect(getSdkSession(info.id)!.status).toBe('exited')
  })

  it('terminate on an unknown id is false, and a live session is not removable', async () => {
    expect(terminateSdkSession('nope')).toBe(false)
    const info = spawnSdkSession({
      cwd: '/tmp/w',
      options: {},
      initialPrompt: 'go',
      queryFn: scriptedQuery([[assistantText('hi')]], { hangAfter: 1 }),
    })
    expect(removeSdkSession(info.id)).toBe(false) // still running
    terminateSdkSession(info.id)
    expect(removeSdkSession(info.id)).toBe(true)
    expect(getSdkSession(info.id)).toBeNull()
  })
})

describe('quota parking', () => {
  it('parks the session when the CLI refuses, and a push un-parks it', async () => {
    const info = spawnSdkSession({
      cwd: '/tmp/w',
      options: {},
      initialPrompt: 'go',
      queryFn: scriptedQuery([
        [assistantText("You've reached your Fable 5 limit. Run /usage-credits"), resultOk()],
        [assistantText('ok now'), resultOk()],
      ]),
    })
    await settle()
    // turn_end follows the refusal, so the settled status is 'waiting'; the
    // refusal itself is in the stream for the engine to act on.
    const frames: SdkStreamFrame[] = []
    attachSdkListener(info.id, 0, () => {})!.replay.forEach((f) => frames.push(f))
    expect(frames.some((f) => f.ev.kind === 'quota_refusal')).toBe(true)
    expect(frames.some((f) => f.ev.kind === 'status' && f.ev.status === 'quota-parked')).toBe(true)
  })
})

describe('attachSdkListener — replay + truncation honesty', () => {
  it('replays from a sequence number and then streams live frames', async () => {
    const info = spawnSdkSession({
      cwd: '/tmp/w',
      options: {},
      initialPrompt: 'one',
      queryFn: scriptedQuery([
        [assistantText('a'), resultOk()],
        [assistantText('b'), resultOk()],
      ]),
    })
    await settle()
    const seen: SdkStreamFrame[] = []
    const att = attachSdkListener(info.id, 0, (f) => seen.push(f))!
    expect(att.replay.length).toBeGreaterThan(0)
    expect(att.truncated).toBe(false)

    pushSdkInput(info.id, 'two')
    await settle()
    expect(seen.some((f) => f.ev.kind === 'text' && f.ev.text === 'b')).toBe(true)

    att.detach()
    const before = seen.length
    pushSdkInput(info.id, 'three')
    await settle()
    expect(seen.length).toBe(before) // detached
  })

  it('replays only what is NEWER than fromSeq', async () => {
    const info = spawnSdkSession({
      cwd: '/tmp/w',
      options: {},
      initialPrompt: 'one',
      queryFn: scriptedQuery([[assistantText('a'), resultOk()]]),
    })
    await settle()
    const all = attachSdkListener(info.id, 0, () => {})!.replay
    const mid = all[Math.floor(all.length / 2)].seq
    const tail = attachSdkListener(info.id, mid, () => {})!.replay
    expect(tail.every((f) => f.seq > mid)).toBe(true)
    expect(tail.length).toBeLessThan(all.length)
  })

  it('is null for an unknown session', () => {
    expect(attachSdkListener('nope', 0, () => {})).toBeNull()
  })

  it('a listener that throws does not take down the pump', async () => {
    const info = spawnSdkSession({
      cwd: '/tmp/w',
      options: {},
      initialPrompt: 'one',
      queryFn: scriptedQuery([
        [assistantText('a'), resultOk()],
        [assistantText('b'), resultOk()],
      ]),
    })
    await settle()
    attachSdkListener(info.id, 0, () => {
      throw new Error('broken SSE writer')
    })
    pushSdkInput(info.id, 'two')
    await settle()
    // The session kept going despite the bad listener.
    expect(getSdkSession(info.id)!.status).toBe('waiting')
  })
})

describe('pool bookkeeping', () => {
  it('lists live sessions and survives being asked about unknown ids', async () => {
    expect(getSdkSession('nope')).toBeNull()
    expect(isSdkSessionAlive('nope')).toBe(false)
    const a = spawnSdkSession({ cwd: '/tmp/a', options: {}, initialPrompt: 'x', queryFn: scriptedQuery([[resultOk()]]) })
    const b = spawnSdkSession({ cwd: '/tmp/b', options: {}, initialPrompt: 'x', queryFn: scriptedQuery([[resultOk()]]) })
    await settle()
    const ids = listSdkSessions().map((s) => s.id).sort()
    expect(ids).toEqual([a.id, b.id].sort())
  })

  it('honours an injected id (deterministic resume / tests)', () => {
    const info = spawnSdkSession({
      id: 'fixed-id',
      cwd: '/tmp/w',
      options: {},
      queryFn: scriptedQuery([[resultOk()]]),
    })
    expect(info.id).toBe('fixed-id')
    expect(getSdkSession('fixed-id')).not.toBeNull()
  })
})

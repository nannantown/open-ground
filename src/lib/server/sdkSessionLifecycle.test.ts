import { describe, it, expect, beforeEach } from 'vitest'
import {
  spawnSdkSession,
  getSdkSession,
  pushSdkInput,
  interruptSdkSession,
  terminateSdkSession,
  isSdkSessionLive,
  attachSdkListener,
  listActiveSdkCwds,
  __resetSdkSessionsForTests,
  __setQuotaPrefixesForTests,
  type SdkQueryFn,
  type SdkStreamFrame,
} from './sdkSession'
import { distillSdkMessage, isWorkEvidence, type SdkEvent } from './sdkEvents'

// HOW A SESSION ENDS, and what the record says about WHY.
//
// The sibling file (sdkSession.test.ts) covers the pool's surface. This one is
// about the two answers a finished desk owes its readers — "is it gone?" and
// "did I stop it, or did it fall over?" — because those were being confused by
// paths that never throw and by a flag that never reset. The owner reads the
// second answer on the tile; the engine reads it to decide whether to
// re-dispatch. Both are worthless if a crash can be filed as a clean stop.
//
// NOTHING here spawns a real `claude` (isolated HOME cannot authenticate —
// migration plan appendix B-6). The FIXTURES, though, are the measured shapes:
// scripts/probe-sdk-interrupt-survival.mts drove the real SDK against a
// protocol-speaking CLI and recorded both endings modelled below.

const PREFIXES = ["You've hit your", "You've reached your"]

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms))

const assistantText = (text: string) => ({
  type: 'assistant',
  message: { content: [{ type: 'text', text }] },
})
const resultOk = () => ({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed' })
/** The aborted turn's own result, verbatim in shape — subtype LIES (it is not
 *  'success'), `terminal_reason` is the field that means anything. */
const resultAborted = () => ({
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
  terminal_reason: 'aborted_streaming',
  result: '[ede_diagnostic] aborted by user',
})

beforeEach(() => {
  __resetSdkSessionsForTests()
  __setQuotaPrefixesForTests(PREFIXES)
})

// ── ① interrupt keeps the session — and must not launder later crashes ──────

/** A desk that behaves the way the real one was MEASURED to behave
 *  (probe case A): `interrupt()` aborts the running turn, the aborted result is
 *  delivered, and the iterator KEEPS GOING — parked on the input generator,
 *  ready for the next turn. It ends only when the input ends, or when
 *  `explode()` kills the transport under it.
 *
 *  This fixture is the point of the whole file. Written the other way — throw on
 *  interrupt — every assertion below passes for the wrong reason, because a
 *  session that dies at the interrupt never reaches the later crash at all. */
const survivingDesk = () => {
  let abort = false
  let boom: string | null = null
  const queryFn: SdkQueryFn = ({ prompt }) => ({
    async *[Symbol.asyncIterator]() {
      for await (const _msg of prompt) {
        void _msg
        for (let i = 0; i < 400; i++) {
          if (boom) throw new Error(boom)
          if (abort) {
            abort = false
            yield resultAborted()
            break
          }
          yield assistantText(`working ${i}`)
          await new Promise((r) => setTimeout(r, 2))
        }
      }
      // The prompt returned (terminate woke it with null) → the SDK closes the
      // CLI's stdin, the CLI exits 0, and this iterator ends NORMALLY.
    },
    interrupt: async () => {
      abort = true
    },
  })
  return { queryFn, explode: (msg: string) => (boom = msg) }
}

describe('interruptSdkSession — the promise on the button', () => {
  it('aborts the turn and leaves the session usable for the next one', async () => {
    const desk = survivingDesk()
    const info = spawnSdkSession({ cwd: '/tmp/w', options: {}, initialPrompt: 'go', queryFn: desk.queryFn })
    await settle()
    expect(getSdkSession(info.id)!.status).toBe('working')

    expect(await interruptSdkSession(info.id)).toBe(true)
    await settle()

    // The tooltip says "the session stays open" in both languages. This is that
    // sentence, as an assertion: still live, back to waiting, and it takes work.
    const stopped = getSdkSession(info.id)!
    expect(isSdkSessionLive(stopped)).toBe(true)
    expect(stopped.status).toBe('waiting')
    expect(stopped.exitReason).toBeUndefined()

    expect(pushSdkInput(info.id, 'carry on')).toBe(true)
    await settle()
    expect(getSdkSession(info.id)!.status).toBe('working')
  })

  it('still records a LATER genuine crash as failed, not as the earlier interrupt', async () => {
    // The regression this file was written for. `sawAbort` used to be a
    // has-this-session-ever-been-aborted flag, which was harmless only while an
    // interrupt was believed to end the session. It does not: a desk the owner
    // interrupted at 10:00 and that dies of a transport error at 14:00 was filed
    // as 'interrupted' / 'exited' — a clean stop — so nothing downstream could
    // tell it from a desk the owner had simply stopped.
    const desk = survivingDesk()
    const info = spawnSdkSession({ cwd: '/tmp/w', options: {}, initialPrompt: 'go', queryFn: desk.queryFn })
    await settle()

    await interruptSdkSession(info.id)
    await settle()
    expect(getSdkSession(info.id)!.status).toBe('waiting')

    // …hours later, in engine terms: a new turn, then the transport dies.
    pushSdkInput(info.id, 'next task')
    await settle()
    desk.explode('transport exploded')
    await settle()

    const dead = getSdkSession(info.id)!
    expect(dead.status).toBe('failed')
    expect(dead.exitReason).toContain('transport exploded')
    expect(dead.exitReason).not.toBe('interrupted')
  })

  it('still forgives the crash that lands IMMEDIATELY after an abort', async () => {
    // The other side of the same rule — do not "fix" the above by deleting the
    // abort evidence. A CLI that dies right after delivering the aborted result
    // (probe case B: the SDK relabels the exit error with that result's text, so
    // the exception reads `[ede_diagnostic] …`) is a stop, not a failure.
    let abort = false
    const info = spawnSdkSession({
      cwd: '/tmp/w',
      options: {},
      initialPrompt: 'go',
      queryFn: ({ prompt }) => ({
        async *[Symbol.asyncIterator]() {
          for await (const _msg of prompt) {
            void _msg
            for (let i = 0; i < 400; i++) {
              if (abort) {
                yield resultAborted()
                throw new Error('Claude Code returned an error result: [ede_diagnostic] aborted by user')
              }
              yield assistantText(`working ${i}`)
              await new Promise((r) => setTimeout(r, 2))
            }
          }
        },
        interrupt: async () => {
          abort = true
        },
      }),
    })
    await settle()
    await interruptSdkSession(info.id)
    await settle()

    const s = getSdkSession(info.id)!
    expect(s.exitReason).toBe('interrupted')
    expect(s.status).toBe('exited') // not 'failed'
  })
})

// ── ② a stop we asked for must not be filed as a completion ─────────────────

describe('terminateSdkSession — the exit reason survives the normal-return path', () => {
  it('keeps "terminated" when the iterator returns instead of throwing', async () => {
    // THE ORDINARY PATH, not an edge case: terminate wakes the input generator
    // with null, so the prompt RETURNS, the CLI's stdin closes, the CLI exits 0,
    // and the pump's `for await` ends with no exception at all. The end-of-try
    // line then ran unconditionally and stamped 'completed' over terminate's
    // 'terminated' — so every idle desk the owner stopped was recorded as having
    // finished by itself.
    const desk = survivingDesk()
    const info = spawnSdkSession({ cwd: '/tmp/w', options: {}, initialPrompt: 'go', queryFn: desk.queryFn })
    await settle()

    // Idle it first — this is the shape that returns rather than throws.
    await interruptSdkSession(info.id)
    await settle()
    expect(getSdkSession(info.id)!.status).toBe('waiting')

    expect(terminateSdkSession(info.id)).toBe(true)
    await settle()

    const s = getSdkSession(info.id)!
    expect(s.exitReason).toBe('terminated')
    expect(s.exitReason).not.toBe('completed')
    expect(s.reaped).toBe(true)
  })

  it('still says "completed" for a session that really did finish on its own', async () => {
    // The reset's other half: `??=` must not make a genuine completion silent.
    const info = spawnSdkSession({
      cwd: '/tmp/w',
      options: {},
      initialPrompt: 'go',
      queryFn: () => ({
        async *[Symbol.asyncIterator]() {
          yield assistantText('all done')
          yield resultOk()
        },
      }),
    })
    await settle()
    expect(getSdkSession(info.id)!.exitReason).toBe('completed')
  })
})

// ── ③ a session that never started is finished in EVERY sense ───────────────

describe('spawnSdkSession — the failure path owes the same record as the reap path', () => {
  const explodingSpawn = () =>
    spawnSdkSession({
      cwd: '/tmp/never-started',
      options: {},
      initialPrompt: 'go',
      queryFn: () => {
        throw new Error('binary missing')
      },
    })

  it('marks it reaped, so nothing waits on a pump that will never run', () => {
    // `pump` is never entered here, so its `finally` — the ONLY other place that
    // stamps these — never runs either. Two things key on the result and both
    // fail SILENTLY and PERMANENTLY if it is left unset:
    //   • the worktree delete gate selects `!reaped`, so the tree would be
    //     reported as "a claude is working in here" for the life of the process
    //     and the engine would retry the teardown forever;
    //   • the retention sweep needs `closedAt`, or the entry is immortal.
    // A gate that can never open is as broken as one that never closes.
    const info = explodingSpawn()
    expect(info.status).toBe('failed')
    expect(info.reaped).toBe(true)
    expect(isSdkSessionLive(info)).toBe(false)
    // The delete gate's actual seam, not a proxy for it.
    expect(listActiveSdkCwds()).not.toContain('/tmp/never-started')
  })

  it('ANNOUNCES it — the frame is in the ring, and the entry already reads reaped', () => {
    // The rule the pump's `finally` states ("a reap is always announced, and the
    // flag is set first") was written in ONE of the two places that set `reaped`.
    // Here no listener can exist yet — spawnSdkSession has not returned, so
    // nobody holds the id — but the frame still lands in the RING BUFFER, and
    // that is what an SSE reader attaching a moment later replays. It must find
    // a terminal status frame AND a session that already says reaped; a reader
    // handed the frame by a session that still reads live keeps its stream open
    // and never hears anything again.
    const info = explodingSpawn()
    const frames: SdkStreamFrame[] = []
    const att = attachSdkListener(info.id, 0, (f) => frames.push(f))
    expect(att).not.toBeNull()
    // Replay is what a fresh reader sees; the live callback fires for nothing
    // here, which is precisely why the buffer has to carry it.
    const terminal = att!.replay.filter(
      (f) => f.ev.kind === 'status' && (f.ev.status === 'failed' || f.ev.status === 'exited'),
    )
    expect(terminal).toHaveLength(1)
    expect(getSdkSession(info.id)!.reaped).toBe(true)
    expect(getSdkSession(info.id)!.exitReason).toContain('binary missing')
    att!.detach()
    expect(frames).toEqual([])
  })
})

// ── ④ isWorkEvidence, pinned per production message kind ────────────────────

/** Distil one real CLI message and return the events, so the table below reads
 *  the SAME path the pump reads. A predicate tested against hand-built events
 *  proves nothing about the messages that actually arrive. */
const evs = (msg: unknown): SdkEvent[] => distillSdkMessage(msg, PREFIXES)
const only = (msg: unknown): SdkEvent => {
  const out = evs(msg)
  expect(out).toHaveLength(1)
  return out[0]
}

describe('isWorkEvidence — what proves a desk is working RIGHT NOW', () => {
  it('is true for the four things only a running turn produces', () => {
    expect(isWorkEvidence(only(assistantText('thinking out loud')))).toBe(true)
    expect(
      isWorkEvidence(only({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }] } })),
    ).toBe(true)
    expect(
      isWorkEvidence(
        only({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
        }),
      ),
    ).toBe(true)
    expect(
      isWorkEvidence(
        only({
          type: 'user',
          message: { content: [{ type: 'tool_result', is_error: false, content: 'ok' }] },
        }),
      ),
    ).toBe(true)
    expect(
      isWorkEvidence(
        only({
          type: 'system',
          subtype: 'compact_boundary',
          compact_metadata: { trigger: 'auto', pre_tokens: 120_000, post_tokens: 20_000 },
        }),
      ),
    ).toBe(true)
  })

  it('is false for every event that means a turn ENDED or never started', () => {
    // A turn boundary is the opposite of work in flight; promoting on it would
    // put a finished desk back to 'working' with nothing left to end it.
    const end = evs(resultOk())
    expect(end.map((e) => e.kind)).toEqual(['turn_end'])
    expect(isWorkEvidence(end[0])).toBe(false)

    expect(isWorkEvidence(only(resultAborted()))).toBe(false)

    // Pre-refusal warning: the limit is approaching, nothing is being produced.
    expect(
      isWorkEvidence(
        only({ type: 'rate_limit_event', rate_limit_info: { utilization: 0.9, rateLimitType: 'five_hour' } }),
      ),
    ).toBe(false)

    // An API error and its turn_end arrive in ONE message — neither is work.
    const failed = evs({
      type: 'result',
      subtype: 'success',
      is_error: true,
      terminal_reason: 'api_error',
      api_error_status: 529,
      result: 'API Error: 529 Overloaded',
    })
    expect(failed.map((e) => e.kind)).toEqual(['api_error', 'turn_end'])
    expect(failed.map(isWorkEvidence)).toEqual([false, false])

    // ⚠ THE ONE THAT WOULD HURT MOST. The refusal arrives as ordinary assistant
    // text, so the SAME message yields quota_refusal AND text. The refusal must
    // NOT count as work — otherwise the promotion races the park it just set,
    // and a limit-stopped worker draws as 作業中 while it does nothing.
    const refusal = evs(assistantText("You've hit your usage limit. Resets 3pm."))
    expect(refusal.map((e) => e.kind)).toEqual(['quota_refusal', 'text'])
    expect(refusal.map(isWorkEvidence)).toEqual([false, true])

    // Status frames are the machine's own output, never evidence about it.
    expect(isWorkEvidence({ kind: 'status', status: 'working' })).toBe(false)
  })

  it('never sees the between-turn chatter at all — those distil to nothing', () => {
    // The failure that produced this predicate: the promotion was written as
    // "a message arrived ⇒ working", and these arrive when NO turn is running —
    // a backgrounded `npm test` finishing, and the idle notice that lands AFTER
    // the result. They must yield zero events, so there is nothing to promote on.
    expect(evs({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })).toEqual([])
    expect(evs({ type: 'system', subtype: 'session_state_changed', state: 'idle' })).toEqual([])
    expect(evs({ type: 'system', subtype: 'init', session_id: 'abc' })).toEqual([])
    expect(evs({ type: 'stream_event', event: { type: 'content_block_delta' } })).toEqual([])
  })
})
